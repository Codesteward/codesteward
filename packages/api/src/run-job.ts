import {
  createOrchestrator,
  globalCheckpointStore,
  prepareSessionWorkspace,
  resolveSelfHealConfig,
  SessionAuditCollector,
} from "@codesteward/agents";
import { createGraphClient } from "@codesteward/graph-client";
import { createModelRouter } from "@codesteward/model-router";
import { loadPolicyFromDir, DEFAULT_POLICY } from "@codesteward/policy";
import { createSandbox } from "@codesteward/sandbox";
import type { ReviewJob } from "@codesteward/core";
import { findingsStore, learningStore } from "./shared-stores.js";
import { globalQueue } from "./queue.js";
import { globalSessionStore } from "./store.js";
import { createOrgScmProvider } from "./org-scm.js";
import { isOrgEntitled, resolveOrgLicense } from "./license.js";
import { globalConnectorsStore } from "./connectors-store.js";

export type RunJobLog = (msg: string, ...args: unknown[]) => void;

/** Human wall duration for worker logs (matches audit.timings units). */
function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * Remove cloned session workspace under STEW_WORKSPACE_DIR (primary + cross-repo).
 * Skipped when STEW_WORKSPACE_KEEP=1 or when path is not under the configured root
 * (avoids deleting mounted REPO_PATH checkouts).
 */
async function cleanSessionWorkspace(
  sessionId: string,
  repoPath: string | undefined,
  log: RunJobLog,
): Promise<void> {
  if (process.env.STEW_WORKSPACE_KEEP === "1") {
    log(`workspace keep enabled (STEW_WORKSPACE_KEEP=1) — skip GC for ${sessionId}`);
    return;
  }
  const { join, resolve } = await import("node:path");
  const { rm } = await import("node:fs/promises");
  const root = resolve(
    process.env.STEW_WORKSPACE_DIR ??
      join(process.env.STEW_DATA_DIR ?? ".steward-data", "workspaces"),
  );
  // Session trees: {root}/{sessionId} (primary) and {root}/{sessionId}/cross/...
  const sessionDir = resolve(join(root, sessionId));
  const underRoot = (p: string) => {
    const abs = resolve(p);
    return abs === root || abs.startsWith(root + "/") || abs.startsWith(root + "\\");
  };
  if (!underRoot(sessionDir)) {
    log(`workspace GC refused: session dir outside root (${sessionDir})`);
    return;
  }
  try {
    await rm(sessionDir, { recursive: true, force: true });
    log(`workspace cleaned ${sessionDir}`);
  } catch (err) {
    log(
      `workspace GC failed ${sessionDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // If job.repoPath was a clone path but not under sessionDir naming, try it only if under root
}

/**
 * Shared review job processor used by the dedicated worker and the API
 * inline worker loop. Keep this the single source of truth for processJob.
 */
export async function runReviewJob(
  jobInput: ReviewJob,
  opts: { log?: RunJobLog; label?: string } = {},
): Promise<void> {
  let job = jobInput;
  const label = opts.label ?? "worker";
  const log: RunJobLog = opts.log ?? ((msg, ...args) => console.log(`[${label}] ${msg}`, ...args));
  const healConfig = resolveSelfHealConfig();

  log(`processing job ${job.id} session=${job.sessionId} mode=${job.mode}`);
  await globalSessionStore.reload();
  let session = globalSessionStore.get(job.sessionId);
  if (!session) {
    console.warn(`[${label}] session ${job.sessionId} not found — skip`);
    return;
  }

  // Clear waiting flag once claimed. Later metadata merges use this session object —
  // if waitingForWorker stays on the in-memory session, prepare/finalize re-write it.
  {
    const meta = { ...session.metadata };
    delete meta.waitingForWorker;
    session = { ...session, metadata: meta };
    globalSessionStore.update(job.sessionId, {
      status: "running",
      stage: session.stage === "queued" ? "planning" : session.stage,
      metadata: meta,
    });
  }

  const resume =
    Boolean(session.metadata?.resumeFromCheckpoint) ||
    Boolean(await globalCheckpointStore.load(session.id));

  const orgId =
    (job as { orgId?: string }).orgId ?? session.orgId ?? "local";

  // Apply org UI runtime config for keys not set in process.env
  try {
    const { applyOrgRuntimeToProcess } = await import("./runtime-config.js");
    await applyOrgRuntimeToProcess(orgId);
  } catch (err) {
    log(
      `runtime config apply failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Bind code plane: prefer SCM clone when credentials exist
  const scmProviderName =
    job.scm?.provider ?? session.scmProvider ?? process.env.SCM_PROVIDER ?? "github";
  let cloneAuth: { provider: string; token?: string; host?: string } | null = null;
  try {
    await globalConnectorsStore.ensureLoaded();
    const row = await globalConnectorsStore.getAsync(String(scmProviderName), orgId);
    if (row?.config) {
      const { decryptConfigSecrets } = await import("./connectors-file.js");
      const plain = decryptConfigSecrets(row.config) as Record<string, unknown>;
      const token =
        (typeof plain.token === "string" && plain.token) ||
        (typeof plain.accessToken === "string" && plain.accessToken) ||
        undefined;
      const host =
        (typeof plain.baseUrl === "string" && plain.baseUrl) ||
        (typeof plain.url === "string" && plain.url) ||
        undefined;
      if (token) cloneAuth = { provider: String(scmProviderName), token, host };
      // GitHub App on connector — mint installation token for git clone
      if (
        !cloneAuth?.token &&
        (scmProviderName === "github" || scmProviderName === "github_enterprise") &&
        plain.appId &&
        (plain.privateKeyPem || plain.privateKey) &&
        plain.installationId
      ) {
        const { getInstallationAccessToken } = await import(
          "@codesteward/scm"
        );
        const inst = await getInstallationAccessToken({
          credentials: {
            appId: String(plain.appId),
            privateKeyPem: String(plain.privateKeyPem ?? plain.privateKey),
            baseUrl: host,
          },
          installationId: String(plain.installationId),
        });
        cloneAuth = {
          provider: String(scmProviderName),
          token: inst.token,
          host,
        };
        log(`clone auth: GitHub App installation token minted`);
      }
    }
    // Tenancy GitHub App (enterprise SoT)
    if (
      !cloneAuth?.token &&
      (scmProviderName === "github" || scmProviderName === "github_enterprise")
    ) {
      try {
        const scm = await createOrgScmProvider(orgId, scmProviderName);
        // createScmProvider may hold token getter; prefer explicit mint via tenancy
        const { getTenancyStore } = await import("./tenancy/orgs.js");
        const store = getTenancyStore();
        const cfg = await store.getGitHubAppConfig(orgId);
        const creds = store.resolveGitHubAppCredentials(cfg);
        const installs = await store.listInstallations(orgId);
        const gh = installs.find(
          (i) =>
            i.provider === "github" &&
            i.status !== "suspended" &&
            /^\d+$/.test(String(i.installationId ?? "")),
        );
        const installationId =
          gh?.installationId ?? process.env.GITHUB_APP_INSTALLATION_ID;
        if (creds && installationId) {
          const { getInstallationAccessToken } = await import(
            "@codesteward/scm"
          );
          const inst = await getInstallationAccessToken({
            credentials: {
              appId: creds.appId,
              privateKeyPem: creds.privateKey,
              baseUrl: creds.baseUrl ?? cfg?.baseUrl,
            },
            installationId,
          });
          cloneAuth = {
            provider: "github",
            token: inst.token,
            host: creds.baseUrl ?? cfg?.baseUrl,
          };
          log(`clone auth: tenancy GitHub App installation token minted`);
        }
        void scm;
      } catch (err) {
        log(
          `clone auth GitHub App mint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Env break-glass (single-tenant)
    if (!cloneAuth?.token) {
      const envTok =
        process.env.GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITLAB_TOKEN ||
        process.env.GITEA_TOKEN;
      if (envTok) {
        cloneAuth = {
          provider: String(scmProviderName),
          token: envTok,
          host:
            process.env.GITHUB_API_URL ||
            process.env.GITLAB_URL ||
            process.env.GITEA_URL,
        };
      }
    }
  } catch (err) {
    log(`clone auth resolve failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const audit = new SessionAuditCollector(session.id);
  let prepared: Awaited<ReturnType<typeof prepareSessionWorkspace>>;
  try {
    prepared = await prepareSessionWorkspace({
      job: { ...job, repoPath: job.repoPath ?? session.repoPath },
      sessionId: session.id,
      orgId,
      cloneAuth,
      preferScmDiff: Boolean(job.patches?.length) && process.env.STEW_SCM_DIFF_ONLY === "1",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`workspace prepare failed: ${message}`);
    const failMeta = { ...session.metadata };
    delete failMeta.waitingForWorker;
    globalSessionStore.update(job.sessionId, {
      status: "failed",
      stage: "failed",
      error: message,
      completedAt: new Date().toISOString(),
      metadata: {
        ...failMeta,
        codeSource: "unverified_mount",
        workspaceNotes: [message],
        failureSummary: message,
      },
    });
    globalSessionStore.pushEvent(job.sessionId, {
      type: "error",
      sessionId: session.id,
      message,
      retriable: false,
      ts: new Date().toISOString(),
    });
    await globalQueue.complete?.(job.id);
    return;
  }
  job = prepared.job;
  audit.setContext(prepared.context);
  {
    const meta = { ...session.metadata };
    delete meta.waitingForWorker;
    session = {
      ...session,
      repoPath: job.repoPath ?? session.repoPath,
      metadata: {
        ...meta,
        codeSource: prepared.context.source,
        codeVerified: prepared.context.verified,
        workspaceNotes: prepared.context.notes,
      },
    };
    globalSessionStore.update(job.sessionId, {
      repoPath: job.repoPath,
      metadata: session.metadata,
    });
  }
  globalSessionStore.pushEvent(job.sessionId, {
    type: "audit_context",
    sessionId: session.id,
    source: prepared.context.source,
    verified: prepared.context.verified,
    pathCount: prepared.context.pathsRequested.length,
    fileCount: prepared.context.filesIncluded.length,
    message: prepared.context.notes.slice(0, 3).join("; "),
    ts: new Date().toISOString(),
  });
  log(
    `workspace source=${prepared.context.source} verified=${prepared.context.verified} path=${job.repoPath ?? "-"}`,
  );

  // In-progress Check Run so branch protection can require codesteward/gate
  if (job.scm?.publish && job.headSha && job.scm.owner && job.scm.repo) {
    try {
      const scmEarly = await createOrgScmProvider(orgId, job.scm.provider ?? "github");
      if (scmEarly.postCheckRun) {
        await scmEarly.postCheckRun(job.scm.owner, job.scm.repo, {
          name: process.env.STEW_CHECK_NAME ?? "codesteward/gate",
          headSha: job.headSha,
          status: "in_progress",
          title: "CodeSteward review running",
          summary: `Session ${job.sessionId} · mode ${job.mode}`,
        });
      }
    } catch (err) {
      log(
        `check run in_progress skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const policy = job.repoPath
    ? await loadPolicyFromDir(job.repoPath).catch(() => DEFAULT_POLICY)
    : DEFAULT_POLICY;

  // Org-scoped license gates (SaaS control plane when STEW_BILLING_URL is set)
  const license = await resolveOrgLicense(orgId);
  const allowProve = await isOrgEntitled(orgId, "prove");
  const allowLangfuse = await isOrgEntitled(orgId, "langfuse");
  const allowThorough = await isOrgEntitled(orgId, "thoroughDiscourse");
  const allowCrossRepo = await isOrgEntitled(orgId, "crossRepo");
  // Defense in depth: free plans must not run dual-pass discourse even if the job slipped through
  if (
    (job.riskTier === "thorough" || job.depth === "thorough") &&
    !allowThorough
  ) {
    log(
      `thorough/discourse not entitled for org=${orgId} (tier=${license.tier}); downgrading riskTier to full`,
    );
    job = {
      ...job,
      riskTier: "full",
      depth: job.depth === "thorough" ? "normal" : job.depth,
    };
    globalSessionStore.update(job.sessionId, {
      riskTier: "full",
      depth: job.depth,
      metadata: {
        ...(globalSessionStore.get(job.sessionId)?.metadata ?? {}),
        thoroughBlocked: true,
        thoroughBlockReason: "org_license_required",
      },
    });
  }
  if (job.crossRepo && !allowCrossRepo) {
    log(`cross-repo not entitled for org=${orgId}; disabling fan-out`);
    job = { ...job, crossRepo: false };
  }
  // Org + platform Langfuse can both be set → dual-write to both projects
  let langfuseDestinations: import("@codesteward/model-router").LangfuseCredentials[] =
    [];
  if (allowLangfuse) {
    try {
      const { loadLangfuseDestinationsForRuntime } = await import(
        "./org-settings-store.js"
      );
      langfuseDestinations = await loadLangfuseDestinationsForRuntime(orgId);
      if (langfuseDestinations.length) {
        log(
          `langfuse destinations: ${langfuseDestinations.map((d) => d.source).join("+")}`,
        );
      }
    } catch (err) {
      console.warn("[run-job] langfuse destinations unavailable", err);
    }
  }
  void license;

  // Per-org model matrix + encrypted provider API keys (env is host fallback only).
  // Always pass sessionId so Langfuse groups all generations under one Session.
  // Never use another org's matrix — createOrgModelRouter loads only `orgId`.
  let modelRouter = createModelRouter(process.env, {
    sessionId: job.sessionId,
    orgId,
    langfuseDestinations,
  });
  try {
    const { createOrgModelRouter } = await import("./org-model-router.js");
    const { createModelRouter: makeRouter } = await import("@codesteward/model-router");
    const orgBound = await createOrgModelRouter(orgId, { sessionId: job.sessionId });
    // Re-bind with Langfuse destinations (helper does not know license-gated LF)
    modelRouter = makeRouter(process.env, {
      config: orgBound.config,
      sessionId: job.sessionId,
      orgId,
      langfuseDestinations,
    });
    if (orgBound.fromOrgMatrix) {
      log(`org model matrix loaded for org=${orgId}`);
    }
  } catch (err) {
    console.warn("[run-job] org model matrix unavailable, using env defaults", err);
  }
  const graph = createGraphClient({
    tenantId: job.tenantId,
    repoId: job.repoId,
  });
  const sandbox = createSandbox(process.env.STEW_SANDBOX_PROVIDER ?? "null");
  const scmProvider =
    job.scm?.provider ?? process.env.SCM_PROVIDER ?? "github";
  const scm = await createOrgScmProvider(orgId, scmProvider);

  const crossRepoLinks = allowCrossRepo
    ? globalSessionStore
        .listLinks()
        .filter((l) => l.enabled && ((l as { orgId?: string }).orgId ?? "local") === orgId)
    : [];

  let promptPack = null as import("@codesteward/agents").OrgPromptPack | null;
  try {
    const { getOrgSettingsStore } = await import("./org-settings-store.js");
    const { mergePromptPack, createDefaultPromptPack } = await import(
      "@codesteward/agents"
    );
    const orgDoc = await getOrgSettingsStore().get(orgId);
    if (orgDoc.promptPack) {
      promptPack = mergePromptPack(
        createDefaultPromptPack(),
        orgDoc.promptPack as unknown as import("@codesteward/agents").OrgPromptPack,
      );
    }
  } catch (err) {
    console.warn("[run-job] prompt pack unavailable", err);
  }

  /** Wall-clock for stage enter → next stage (mirrors audit.timings in logs). */
  const stageTrack: { name: string | null; t0: number } = { name: null, t0: 0 };

  const orch = createOrchestrator({
    modelRouter,
    graph,
    policy,
    findings: findingsStore,
    learning: learningStore,
    promptPack,
    maxConcurrent: job.maxConcurrent,
    crossRepoLinks,
    // Same SCM credentials used for primary clone — required so linked repos are checked out
    cloneAuth,
    sandbox,
    scm,
    allowProve,
    selfHeal: healConfig,
    audit,
    onEvent: (event) => {
      globalSessionStore.pushEvent(job.sessionId, event);
      if (event.type === "stage") {
        // Close previous stage with wall duration so logs match metadata.timings
        if (stageTrack.name && stageTrack.t0 > 0 && stageTrack.name !== event.stage) {
          const ms = Math.max(0, Date.now() - stageTrack.t0);
          log(
            `${job.sessionId} stage=${stageTrack.name} done ${formatDurationMs(ms)} (${ms}ms)`,
          );
        }
        stageTrack.name = event.stage;
        stageTrack.t0 = Date.now();
        globalSessionStore.update(job.sessionId, { stage: event.stage });
        log(
          `${job.sessionId} stage=${event.stage}` +
            (event.message ? ` — ${event.message}` : ""),
        );
      }
      if (event.type === "healing" || event.type === "retry" || event.type === "unit_recovered") {
        log(
          `${job.sessionId} ${event.type}` +
            ("unitId" in event && event.unitId ? ` unit=${event.unitId}` : "") +
            ("strategy" in event && event.strategy ? ` strategy=${event.strategy}` : ""),
        );
      }
      if (event.type === "specialist_run" && event.status === "completed") {
        log(
          `${job.sessionId} specialist ${event.role} findings=${event.findingCount ?? 0} ${event.durationMs ?? "?"}ms`,
        );
      }
      if (
        event.type === "specialist_run" &&
        (event.status === "failed" || event.status === "timeout")
      ) {
        const tag =
          event.status === "timeout" || event.timedOut ? "TIMEOUT" : "FAILED";
        log(
          `${job.sessionId} specialist ${event.role} ${tag} ${event.durationMs ?? "?"}ms` +
            (event.timeoutMs ? ` budget=${event.timeoutMs}ms` : "") +
            (event.error ? ` — ${String(event.error).slice(0, 160)}` : ""),
        );
      }
    },
    onCheckpoint: (sess) => {
      globalSessionStore.update(job.sessionId, {
        units: sess.units,
        checkpoint: sess.checkpoint,
        failureLog: sess.failureLog,
        stage: sess.stage,
        status: "running",
      });
    },
  });

  const paths = job.paths?.length ? job.paths : ["."];
  // Keep job lease alive during long multi-specialist runs
  const leaseHeartbeat = setInterval(() => {
    void globalQueue.touchLock?.(job.id)?.catch(() => undefined);
  }, Number(process.env.STEW_JOB_HEARTBEAT_MS ?? 60_000));
  try {
    const result = await orch.run(session, job, paths, { resume });
    const meta = { ...result.session.metadata };
    delete meta.resumeFromCheckpoint;
    delete meta.resumeJobId;
    delete meta.waitingForWorker;

    const failureLog = result.failureLog ?? result.session.failureLog ?? [];
    const unitErr = result.session.units?.find((u) => u.error)?.error;
    const lastFail = failureLog[failureLog.length - 1]?.error;
    const error =
      result.session.status === "failed"
        ? result.session.error || lastFail || unitErr || "failed with no findings"
        : undefined;
    // Persist audit on both top-level (live memory) and metadata (Postgres JSONB)
    const auditFinal =
      result.session.audit ??
      (meta.audit as typeof result.session.audit | undefined);
    globalSessionStore.update(job.sessionId, {
      status: result.session.status,
      stage: result.session.stage,
      units: result.session.units,
      tokenUsage: result.session.tokenUsage,
      verdict: result.session.verdict,
      completedAt: result.session.completedAt,
      audit: auditFinal,
      metadata: {
        ...meta,
        audit: auditFinal ?? meta.audit,
        auditHeadline: meta.auditHeadline,
        codeSource: prepared.context.source,
        codeVerified: prepared.context.verified,
        workspaceNotes: prepared.context.notes,
        failureSummary: error,
        failureCount: failureLog.length,
      },
      checkpoint: result.session.checkpoint,
      failureLog,
      error,
    });
    if (
      result.session.status === "completed" ||
      result.session.status === "completed_with_errors" ||
      result.session.status === "failed"
    ) {
      await globalQueue.complete?.(job.id);
      // Drop cloned trees for this session (primary + cross-repo under same sessionId dir)
      await cleanSessionWorkspace(job.sessionId, job.repoPath, log);
    }
    // Final open stage (e.g. judge → completed without another stage event)
    if (stageTrack.name && stageTrack.t0 > 0) {
      const ms = Math.max(0, Date.now() - stageTrack.t0);
      log(
        `${job.sessionId} stage=${stageTrack.name} done ${formatDurationMs(ms)} (${ms}ms)`,
      );
    }
    const timings =
      result.session.audit?.timings ??
      (result.session.metadata?.timings as
        | {
            totalDurationMs?: number;
            summary?: {
              byStageMs?: Record<string, number>;
              longestStage?: string;
              longestStageMs?: number;
              longestSpecialistRole?: string;
              longestSpecialistMs?: number;
            };
          }
        | undefined);
    if (timings?.summary?.byStageMs) {
      const parts = Object.entries(timings.summary.byStageMs)
        .sort((a, b) => b[1] - a[1])
        .map(([s, ms]) => `${s}=${formatDurationMs(ms)}`)
        .join(" ");
      log(
        `${job.sessionId} timings total=${formatDurationMs(timings.totalDurationMs ?? 0)}` +
          (timings.summary.longestStage
            ? ` longest=${timings.summary.longestStage}/${formatDurationMs(timings.summary.longestStageMs ?? 0)}`
            : "") +
          (timings.summary.longestSpecialistRole
            ? ` slowest_role=${timings.summary.longestSpecialistRole}/${formatDurationMs(timings.summary.longestSpecialistMs ?? 0)}`
            : "") +
          ` | ${parts}`,
      );
    }
    log(
      `done job ${job.id} status=${result.session.status} findings=${result.findings.length} verdict=${result.session.verdict} publish=${result.publishedReviewId ?? "-"}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cur = globalSessionStore.get(job.sessionId);
    const attempts = cur?.resumeAttempts ?? 0;
    const exhausted = attempts >= healConfig.maxGlobalRetries;

    // Finalize hung Check Run so branch protection is not stuck in_progress
    if (job.scm?.publish && job.headSha && job.scm.owner && job.scm.repo) {
      try {
        const scmFail = await createOrgScmProvider(orgId, job.scm.provider ?? "github");
        if (scmFail.postCheckRun) {
          await scmFail.postCheckRun(job.scm.owner, job.scm.repo, {
            name: process.env.STEW_CHECK_NAME ?? "codesteward/gate",
            headSha: job.headSha,
            status: "completed",
            conclusion: "failure",
            title: "CodeSteward: review crashed",
            summary: message.slice(0, 1000),
          });
        }
      } catch {
        /* best-effort */
      }
    }

    globalSessionStore.update(job.sessionId, {
      status: exhausted ? "failed" : "running",
      stage: exhausted ? "failed" : cur?.stage ?? "specialists",
      error: message,
      metadata: {
        ...(cur?.metadata ?? {}),
        lastCrash: message,
        lastCrashAt: new Date().toISOString(),
      },
    });
    globalSessionStore.pushEvent(job.sessionId, {
      type: "error",
      sessionId: job.sessionId,
      message,
      retriable: !exhausted,
      ts: new Date().toISOString(),
    });
    console.error(
      `[${label}] job ${job.id} crashed (resumable=${!exhausted} attempts=${attempts})`,
      err,
    );
    await globalQueue.fail?.(job.id, message);

    // Terminal crash: free disk for clones (resumable crashes keep the tree for resume)
    if (exhausted) {
      await cleanSessionWorkspace(job.sessionId, job.repoPath, log);
    }

    if (!exhausted && cur) {
      const nextAttempts = attempts + 1;
      globalSessionStore.update(job.sessionId, {
        resumeAttempts: nextAttempts,
        metadata: {
          ...(cur.metadata ?? {}),
          resumeFromCheckpoint: true,
          lastCrash: message,
        },
      });
      const requeue = await globalQueue.enqueue({
        sessionId: job.sessionId,
        mode: job.mode,
        tenantId: job.tenantId,
        repoId: job.repoId,
        repoPath: job.repoPath,
        baseSha: job.baseSha,
        headSha: job.headSha,
        baseBranch: job.baseBranch,
        prNumber: job.prNumber,
        riskTier: job.riskTier,
        depth: job.depth,
        paths: job.paths,
        maxConcurrent: job.maxConcurrent,
        crossRepo: job.crossRepo,
        crossRepoBudget: job.crossRepoBudget,
        scm: job.scm,
      });
      log(`auto-requeue session=${job.sessionId} attempt=${nextAttempts} job=${requeue.id}`);
    }
  } finally {
    clearInterval(leaseHeartbeat);
    // Ship Langfuse traces for this review session (session-scoped grouping)
    try {
      const { flushLangfuse } = await import("@codesteward/model-router");
      await flushLangfuse(langfuseDestinations);
    } catch {
      /* optional */
    }
  }
}

export async function resumeIncompleteSessions(
  opts: { log?: RunJobLog; label?: string } = {},
): Promise<number> {
  const label = opts.label ?? "worker";
  const log: RunJobLog = opts.log ?? ((msg, ...args) => console.log(`[${label}] ${msg}`, ...args));
  const { isSessionResumable, globalCheckpointStore: cps, resolveSelfHealConfig: resolve } =
    await import("@codesteward/agents");
  const healConfig = resolve();

  await globalSessionStore.reload();

  // 1) Free jobs left `running` by a dead worker so they don't block forever
  if (globalQueue.reclaimStale) {
    try {
      // On startup, reclaim aggressively (1m) so interrupted sessions don't wait full lease
      const leaseMs = Number(process.env.STEW_JOB_STARTUP_RECLAIM_MS ?? 60_000);
      const { reclaimed, sessionIds } = await globalQueue.reclaimStale(leaseMs);
      if (reclaimed > 0) {
        log(
          `reclaimed ${reclaimed} stale job lock(s) for sessions: ${sessionIds.slice(0, 8).join(", ")}${sessionIds.length > 8 ? "…" : ""}`,
        );
      }
    } catch (err) {
      log(
        `reclaimStale failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2) Only *pending* jobs count as already queued (not zombie running rows)
  const queued = await globalQueue.list();
  const queuedSessionIds = new Set(queued.map((j) => j.sessionId));

  const checkpoints = await cps.listIncomplete();
  const sessions = globalSessionStore.list();
  const candidates = new Map<string, { resume: boolean }>();

  for (const s of sessions) {
    if (
      isSessionResumable({
        status: s.status,
        stage: s.stage,
        units: s.units,
        resumeAttempts: s.resumeAttempts,
        maxGlobalRetries: healConfig.maxGlobalRetries,
      })
    ) {
      candidates.set(s.id, { resume: true });
    }
  }

  for (const cp of checkpoints) {
    const s = globalSessionStore.get(cp.sessionId);
    if (!s) continue;
    if (
      isSessionResumable({
        status: s.status,
        stage: s.stage,
        units: cp.units,
        resumeAttempts: s.resumeAttempts,
        maxGlobalRetries: healConfig.maxGlobalRetries,
      })
    ) {
      candidates.set(s.id, { resume: true });
    }
  }

  let enqueued = 0;
  for (const [sessionId, { resume }] of candidates) {
    if (queuedSessionIds.has(sessionId)) continue;
    const session = globalSessionStore.get(sessionId);
    if (!session) continue;
    if (session.status === "pending" && !session.checkpoint && !(session.units?.length)) {
      continue;
    }

    const attempts = (session.resumeAttempts ?? 0) + 1;
    globalSessionStore.update(sessionId, {
      status: "running",
      stage: session.stage === "failed" ? "specialists" : session.stage,
      resumeAttempts: attempts,
      error: undefined,
    });

    const job = await globalQueue.enqueue({
      sessionId,
      mode: session.mode,
      tenantId: session.tenantId,
      repoId: session.repoId,
      repoPath: session.repoPath,
      baseSha: session.baseSha,
      headSha: session.headSha,
      baseBranch: session.baseBranch,
      prNumber: session.prNumber,
      riskTier: session.riskTier,
      depth: session.depth,
      paths: (session.metadata?.paths as string[] | undefined) ?? undefined,
    });

    const meta = { ...session.metadata };
    delete meta.waitingForWorker;
    globalSessionStore.update(sessionId, {
      metadata: {
        ...meta,
        resumeFromCheckpoint: resume,
        resumeJobId: job.id,
        jobId: job.id,
      },
    });

    globalSessionStore.pushEvent(sessionId, {
      type: "log",
      sessionId,
      level: "info",
      message: `Worker startup resume #${attempts} enqueued job ${job.id}`,
      ts: new Date().toISOString(),
    });

    enqueued += 1;
    log(`resume incomplete session=${sessionId} attempt=${attempts} job=${job.id}`);
  }

  if (enqueued) log(`re-enqueued ${enqueued} incomplete session(s)`);
  return enqueued;
}
