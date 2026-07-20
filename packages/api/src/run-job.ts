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

/**
 * Update the webhook progress comment after a job finishes so PR readers are not
 * stuck on "Re-reviewing now…". Uses owner-matched SCM install (same as clone/publish).
 */
async function updatePrStatusCommentAfterJob(input: {
  orgId: string;
  job: ReviewJob;
  sessionId: string;
  preferredOwner?: string | null;
  status: string;
  verdict?: string;
  findingCount: number;
  publishedReviewId?: string;
  error?: string;
  statusCommentId?: string;
  log: RunJobLog;
}): Promise<void> {
  if (process.env.STEW_PR_STATUS_COMMENT === "0") return;
  const owner =
    input.job.scm?.owner ??
    input.preferredOwner ??
    input.job.repoId?.split("/")[0];
  const repo =
    input.job.scm?.repo ?? input.job.repoId?.split("/")[1];
  const prNumber =
    input.job.scm?.prNumber ?? input.job.prNumber;
  if (!owner || !repo || prNumber == null) return;

  // Prefer latest store metadata (status comment is written by API after enqueue)
  const latest = globalSessionStore.get(input.sessionId);
  const existingId =
    input.statusCommentId ||
    (latest?.metadata?.statusCommentId as string | undefined) ||
    (latest?.metadata?.prStatusCommentId as string | undefined);

  try {
    const {
      upsertPrStatusComment,
      reviewCompletedCommentBody,
      reviewFailedCommentBody,
    } = await import("./pr-status-comment.js");
    const scm = await createOrgScmProvider(
      input.orgId,
      input.job.scm?.provider ?? "github",
      owner,
    );
    const uiBase =
      process.env.STEW_PUBLIC_URL ||
      process.env.STEW_UI_PUBLIC_URL ||
      process.env.STEW_API_PUBLIC_URL;
    const failed =
      input.status === "failed" ||
      (Boolean(input.error) && input.status !== "completed" && input.status !== "completed_with_errors");
    const body = failed
      ? reviewFailedCommentBody({
          sessionId: input.sessionId,
          error: input.error ?? "review failed",
          uiBase,
        })
      : reviewCompletedCommentBody({
          sessionId: input.sessionId,
          verdict: input.verdict,
          findingCount: input.findingCount,
          uiBase,
          published: Boolean(input.publishedReviewId),
          publishError:
            !input.publishedReviewId && input.job.scm?.publish
              ? "SCM publish did not return a review id (check worker logs for GitHub 404 / permissions)."
              : undefined,
        });
    const posted = await upsertPrStatusComment({
      scm,
      owner,
      repo,
      prNumber,
      body,
      existingCommentId: existingId,
    });
    if (posted?.id) {
      const cur = globalSessionStore.get(input.sessionId);
      if (cur) {
        globalSessionStore.update(input.sessionId, {
          metadata: {
            ...cur.metadata,
            statusCommentId: posted.id,
            prStatusCommentId: posted.id,
          },
        });
      }
      input.log(
        `pr status comment updated id=${posted.id} session=${input.sessionId} published=${input.publishedReviewId ?? "-"}`,
      );
    }
  } catch (err) {
    input.log(
      `pr status comment update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
  orgId?: string,
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
  const underRoot = (p: string) => {
    const abs = resolve(p);
    return abs === root || abs.startsWith(root + "/") || abs.startsWith(root + "\\");
  };
  // Prefer org-nested layout; also try legacy flat {root}/{sessionId}
  const candidates: string[] = [];
  if (orgId) {
    const orgSeg =
      orgId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 64) ||
      "local";
    candidates.push(resolve(join(root, orgSeg, sessionId)));
  }
  candidates.push(resolve(join(root, sessionId)));
  // If job.repoPath is under root and looks like the session tree, clean it too
  if (repoPath && underRoot(repoPath)) {
    candidates.push(resolve(repoPath));
  }

  const seen = new Set<string>();
  for (const sessionDir of candidates) {
    if (seen.has(sessionDir)) continue;
    seen.add(sessionDir);
    if (!underRoot(sessionDir)) {
      log(`workspace GC refused: session dir outside root (${sessionDir})`);
      continue;
    }
    try {
      await rm(sessionDir, { recursive: true, force: true });
      log(`workspace cleaned ${sessionDir}`);
    } catch (err) {
      log(
        `workspace GC failed ${sessionDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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

  const jobKind =
    job.jobKind ??
    (job.metadata?.jobKind === "pr_outcome" ? "pr_outcome" : "review");

  log(
    `processing job ${job.id} session=${job.sessionId} mode=${job.mode} kind=${jobKind}`,
  );
  await globalSessionStore.reload();
  let session = globalSessionStore.get(job.sessionId);
  if (!session) {
    console.warn(`[${label}] session ${job.sessionId} not found — skip`);
    return;
  }

  // Post-merge outcome analysis (no agent pipeline)
  if (jobKind === "pr_outcome") {
    const { runPrOutcomeJob } = await import("./run-outcome-job.js");
    await runPrOutcomeJob(job, session, log);
    try {
      await globalQueue.complete?.(job.id);
    } catch {
      /* optional complete */
    }
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
  const { repoOwnerFromJob, pickGithubInstallation } = await import(
    "./github-installation-pick.js"
  );
  const preferredGhAccount = repoOwnerFromJob({
    owner: job.scm?.owner,
    scmFullName: session.scmFullName,
    repoId: job.repoId ?? session.repoId,
  });
  let cloneAuth: { provider: string; token?: string; host?: string } | null = null;
  try {
    await globalConnectorsStore.ensureLoaded();
    const row = await globalConnectorsStore.getAsync(String(scmProviderName), orgId);
    // Resolve best installation for this repo owner (multi-install orgs)
    let preferredInstallationId: string | undefined;
    if (scmProviderName === "github" || scmProviderName === "github_enterprise") {
      try {
        const { getTenancyStore } = await import("./tenancy/orgs.js");
        const installs = await getTenancyStore().listInstallations(orgId);
        const pick = pickGithubInstallation(
          installs.map((i) => ({
            provider: i.provider,
            installationId: String(i.installationId ?? ""),
            accountLogin: i.accountLogin,
            status: i.status,
          })),
          preferredGhAccount,
        );
        preferredInstallationId = pick?.installationId;
        if (pick) {
          log(
            `clone auth: preferred installation=${pick.installationId} account=${pick.accountLogin ?? "?"} for owner=${preferredGhAccount ?? "?"}`,
          );
        }
      } catch {
        /* optional */
      }
    }
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
      // Prefer tenancy install matching repo owner over a stale connector installationId
      const connectorInstallId =
        preferredInstallationId ||
        (typeof plain.installationId === "string" ? plain.installationId : undefined);
      if (
        !cloneAuth?.token &&
        (scmProviderName === "github" || scmProviderName === "github_enterprise") &&
        plain.appId &&
        (plain.privateKeyPem || plain.privateKey) &&
        connectorInstallId
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
          installationId: String(connectorInstallId),
        });
        cloneAuth = {
          provider: String(scmProviderName),
          token: inst.token,
          host,
        };
        log(
          `clone auth: GitHub App installation token minted (installation=${connectorInstallId}${
            preferredInstallationId &&
            String(plain.installationId) !== preferredInstallationId
              ? `; connector had ${plain.installationId}, using owner match`
              : ""
          })`,
        );
      }
    }
    // Tenancy GitHub App (enterprise SoT)
    if (
      !cloneAuth?.token &&
      (scmProviderName === "github" || scmProviderName === "github_enterprise")
    ) {
      try {
        const scm = await createOrgScmProvider(
          orgId,
          scmProviderName,
          preferredGhAccount,
        );
        // createScmProvider may hold token getter; prefer explicit mint via tenancy
        const { getTenancyStore } = await import("./tenancy/orgs.js");
        const store = getTenancyStore();
        const cfg = await store.getGitHubAppConfig(orgId);
        const creds = store.resolveGitHubAppCredentials(cfg);
        const installs = await store.listInstallations(orgId);
        const gh = pickGithubInstallation(
          installs.map((i) => ({
            provider: i.provider,
            installationId: String(i.installationId ?? ""),
            accountLogin: i.accountLogin,
            status: i.status,
          })),
          preferredGhAccount,
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
          log(
            `clone auth: tenancy GitHub App installation token minted (installation=${installationId} account=${gh?.accountLogin ?? "?"})`,
          );
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
      job: {
        ...job,
        repoPath: job.repoPath ?? session.repoPath,
        // Prefer job headBranch; fall back to session so clone can fetch PR tip
        headBranch: job.headBranch ?? session.headBranch,
        prNumber: job.prNumber ?? session.prNumber ?? job.scm?.prNumber,
        headSha: job.headSha ?? session.headSha,
        baseSha: job.baseSha ?? session.baseSha,
        baseBranch: job.baseBranch ?? session.baseBranch,
        metadata: {
          ...(job.metadata ?? {}),
          headBranch:
            job.headBranch ??
            session.headBranch ??
            (typeof job.metadata?.headBranch === "string"
              ? job.metadata.headBranch
              : undefined),
        },
      },
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
    // Surface failure on the PR so users who only watch GitHub see it
    try {
      const owner =
        job.scm?.owner ??
        session.scmFullName?.split("/")[0] ??
        preferredGhAccount;
      const repo =
        job.scm?.repo ??
        session.scmFullName?.split("/")[1] ??
        job.repoId?.split("/")[1];
      const prNumber = job.scm?.prNumber ?? job.prNumber ?? session.prNumber;
      if (owner && repo && prNumber != null) {
        const { createOrgScmProvider } = await import("./org-scm.js");
        const {
          upsertPrStatusComment,
          reviewFailedCommentBody,
        } = await import("./pr-status-comment.js");
        const scm = await createOrgScmProvider(orgId, scmProviderName, owner);
        const existingId =
          (failMeta.statusCommentId as string | undefined) ||
          (failMeta.prStatusCommentId as string | undefined);
        const posted = await upsertPrStatusComment({
          scm,
          owner,
          repo,
          prNumber: Number(prNumber),
          existingCommentId: existingId,
          body: reviewFailedCommentBody({
            sessionId: session.id,
            error: message,
            uiBase: process.env.STEW_PUBLIC_URL,
          }),
        });
        if (posted?.id) failMeta.statusCommentId = posted.id;
        log(
          `pr status comment ${existingId ? "updated" : "posted"} for failure on ${owner}/${repo}#${prNumber}`,
        );
      }
    } catch (commentErr) {
      log(
        `pr failure comment failed: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
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
      const scmEarly = await createOrgScmProvider(
        orgId,
        job.scm.provider ?? "github",
        preferredGhAccount ?? job.scm.owner,
      );
      if (scmEarly.postCheckRun) {
        await scmEarly.postCheckRun(job.scm.owner, job.scm.repo, {
          name: process.env.STEW_CHECK_NAME ?? "codesteward/gate",
          headSha: job.headSha,
          status: "in_progress",
          title: "Codesteward review running",
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
          `langfuse destinations: ${langfuseDestinations.map((d) => d.source).join("+")} sessionId=${job.sessionId}`,
        );
      }
    } catch (err) {
      console.warn("[run-job] langfuse destinations unavailable", err);
    }
  }

  // Platform ClickHouse product SoT — when enabled, ALL orgs dual-write (no org opt-out)
  let clickhouseWriter: import("@codesteward/model-router").ClickHouseWriter | null =
    null;
  try {
    const {
      loadPlatformClickHouseForRuntime,
      resolveTraceTtlDays,
    } = await import("./platform-clickhouse-store.js");
    const { loadOrgTraceTtlDays } = await import("./org-settings-store.js");
    const {
      createClickHouseWriter,
    } = await import("@codesteward/model-router");
    const chCfg = await loadPlatformClickHouseForRuntime();
    if (chCfg) {
      const orgTtl = await loadOrgTraceTtlDays(orgId);
      const ttlDays = resolveTraceTtlDays(chCfg.defaultTtlDays ?? 90, orgTtl);
      clickhouseWriter = createClickHouseWriter(chCfg, { defaultTtlDays: ttlDays });
      // Stamp ttl on every record via writer default
      log(
        `clickhouse sink on sessionId=${job.sessionId} ttlDays=${ttlDays} (org=${orgTtl ?? "platform-default"})`,
      );
      // Ensure schema early so first observations don't race
      void clickhouseWriter.ensureSchema().catch((err) =>
        console.warn(
          "[run-job] clickhouse ensureSchema failed",
          err instanceof Error ? err.message : err,
        ),
      );
    }
  } catch (err) {
    console.warn("[run-job] clickhouse sink unavailable", err);
  }
  void license;

  // Per-org model matrix + encrypted provider API keys (env is host fallback only).
  // Always pass sessionId so Langfuse groups all generations under one Session.
  // Never use another org's matrix — createOrgModelRouter loads only `orgId`.
  let modelRouter = createModelRouter(process.env, {
    sessionId: job.sessionId,
    orgId,
    langfuseDestinations,
    clickhouse: clickhouseWriter,
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
      clickhouse: clickhouseWriter,
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
  // Must match clone install pick — without owner, multi-install orgs mint a token for
  // the wrong account and postReview/postComment return GitHub 404 (Not Found).
  const scm = await createOrgScmProvider(
    orgId,
    scmProvider,
    preferredGhAccount ?? job.scm?.owner ?? null,
  );

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
      // Surface SCM publish / graph / policy warnings in worker logs (not only session_events)
      if (
        event.type === "log" &&
        (event.level === "error" || event.level === "warn") &&
        event.message
      ) {
        log(`${job.sessionId} ${event.level}: ${String(event.message).slice(0, 400)}`);
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
      await cleanSessionWorkspace(
        job.sessionId,
        job.repoPath,
        log,
        (job as { orgId?: string }).orgId ?? orgId,
      );
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

    // Flip the webhook "Re-reviewing now…" comment to finished (or note publish failure).
    // Previously only start + prepare-fail paths touched this comment.
    await updatePrStatusCommentAfterJob({
      orgId,
      job,
      sessionId: job.sessionId,
      preferredOwner: preferredGhAccount ?? job.scm?.owner,
      status: result.session.status,
      verdict: result.session.verdict,
      findingCount: result.findings.length,
      publishedReviewId: result.publishedReviewId,
      error,
      statusCommentId:
        (meta.statusCommentId as string | undefined) ||
        (meta.prStatusCommentId as string | undefined),
      log,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cur = globalSessionStore.get(job.sessionId);
    const attempts = cur?.resumeAttempts ?? 0;
    const exhausted = attempts >= healConfig.maxGlobalRetries;

    // Finalize hung Check Run so branch protection is not stuck in_progress
    if (job.scm?.publish && job.headSha && job.scm.owner && job.scm.repo) {
      try {
        const scmFail = await createOrgScmProvider(
          orgId,
          job.scm.provider ?? "github",
          preferredGhAccount ?? job.scm.owner,
        );
        if (scmFail.postCheckRun) {
          await scmFail.postCheckRun(job.scm.owner, job.scm.repo, {
            name: process.env.STEW_CHECK_NAME ?? "codesteward/gate",
            headSha: job.headSha,
            status: "completed",
            conclusion: "failure",
            title: "Codesteward: review crashed",
            summary: message.slice(0, 1000),
          });
        }
      } catch {
        /* best-effort */
      }
    }

    // Update stuck "Re-reviewing now" comment on crash when retries exhausted
    if (exhausted) {
      await updatePrStatusCommentAfterJob({
        orgId,
        job,
        sessionId: job.sessionId,
        preferredOwner: preferredGhAccount ?? job.scm?.owner,
        status: "failed",
        findingCount: 0,
        error: message,
        statusCommentId:
          (cur?.metadata?.statusCommentId as string | undefined) ||
          (cur?.metadata?.prStatusCommentId as string | undefined),
        log,
      });
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
      await cleanSessionWorkspace(
        job.sessionId,
        job.repoPath,
        log,
        (job as { orgId?: string }).orgId ?? orgId,
      );
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
    // Ship Langfuse + ClickHouse traces for this review session
    try {
      const { flushLangfuse } = await import("@codesteward/model-router");
      await flushLangfuse(langfuseDestinations);
    } catch {
      /* optional */
    }
    try {
      await clickhouseWriter?.flush();
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
