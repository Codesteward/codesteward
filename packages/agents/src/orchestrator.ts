import {
  evidenceId,
  type AgentFailureLogEntry,
  type AgentRole,
  type CrossRepoLink,
  type FindingCandidate,
  type HealStrategy,
  type ProgressEvent,
  type ReviewJob,
  type ReviewSession,
  type ReviewUnit,
  type Severity,
  nowIso,
  stageEvent,
} from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";
import type { ModelRouter } from "@codesteward/model-router";
import type { Policy } from "@codesteward/policy";
import type { FindingsStore } from "@codesteward/findings";
import type { Sandbox } from "@codesteward/sandbox";
import { LocalSandbox, dockerAvailable, proveFinding } from "@codesteward/sandbox";
import type { DiffFile, ScmProvider } from "@codesteward/scm";
import type { LearningStore } from "@codesteward/learning";
import {
  buildOrgLearningPrompt,
  formatLinkedIssuesContext,
  loadLinkedIssues,
  parseLinkedIssueRefs,
  markReviewed,
  resolveIncrementalPaths,
  seedMemoriesFromSteward,
} from "@codesteward/learning";
import {
  findingsToSarif,
  presentFingerprintSet,
  reconcileFindingsOnRereview,
  scopeTags,
  upsertFindingAcrossSessions,
  type FindingScope,
} from "@codesteward/findings";
import type { Finding } from "@codesteward/core";
import type { OrgPromptPack } from "./prompt-pack.js";
import { applySuggestedFixConfidenceGate } from "./extract.js";
import { createLimiter, defaultMaxConcurrent } from "./concurrency.js";
import { prepareCrossRepoReview } from "./cross-repo/prepare.js";
import type { CloneAuth } from "./cross-repo/materialize.js";
import { runDiscourse, shouldRunDiscourse } from "./discourse.js";
import { packRepoContext } from "./code-context.js";
import { packDiffContext } from "./diff-context.js";
import { judgeFindings, severityCounts } from "./judge.js";
import { buildSessionReport } from "./session-report.js";
import { capComments, priorMapFromFindings } from "./noise.js";
import { planReviewUnits } from "./planner.js";
import {
  createAgentRunner,
  SimpleAgentRunner,
  type AgentRunner,
  type RunnerDeps,
} from "./runner.js";
import {
  buildPartialReviewSummary,
  globalCheckpointStore,
  resolveSelfHealConfig,
  runUnitWithHeal,
  toCheckpointSummary,
  type CheckpointStore,
  type HealPublishStats,
  type SelfHealConfig,
  type SessionCheckpointPayload,
} from "./self-heal.js";
import { buildReviewMermaid } from "./diagram.js";
import { evaluateGate } from "./gate.js";
import { verifyFindings } from "./verifier.js";
import { runSastAdapters } from "./sast.js";

export interface OrchestratorDeps {
  modelRouter: ModelRouter;
  graph: GraphClient;
  policy: Policy;
  findings: FindingsStore;
  runner?: AgentRunner;
  maxConcurrent?: number;
  onEvent?: (event: ProgressEvent) => void | Promise<void>;
  /** Called after each unit checkpoint so session store can mirror progress. */
  onCheckpoint?: (
    session: ReviewSession,
    checkpoint: SessionCheckpointPayload,
  ) => void | Promise<void>;
  /** Org cross-repo links for fan-out */
  crossRepoLinks?: CrossRepoLink[];
  /**
   * SCM credentials for cloning linked repos during cross-repo fan-out
   * (same token as primary workspace prepare).
   */
  cloneAuth?: CloneAuth | null;
  sandbox?: Sandbox;
  scm?: ScmProvider;
  learning?: LearningStore;
  /** Org-editable prompt pack (personas / instructions). */
  promptPack?: OrgPromptPack | null;
  selfHeal?: Partial<SelfHealConfig>;
  checkpoints?: CheckpointStore;
  /**
   * When false, skip Prove stage even if policy/riskTier request it.
   * Used for license entitlement (oss deny-by-default prove).
   * Default true for backward compatibility.
   */
  allowProve?: boolean;
  /** Review-run forensics collector (optional). */
  audit?: import("./session-audit.js").SessionAuditCollector;
}

export interface OrchestratorResult {
  session: ReviewSession;
  findings: Awaited<ReturnType<FindingsStore["list"]>>;
  units: ReviewUnit[];
  dropped: Array<{ title: string; reason: string }>;
  crossRepoRepos?: string[];
  publishedReviewId?: string;
  incremental?: boolean;
  discourseNotes?: number;
  failureLog: AgentFailureLogEntry[];
}

export interface OrchestratorRunOptions {
  /** Resume from last checkpoint (skip completed units). */
  resume?: boolean;
}

export class ReviewOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly runner: AgentRunner;
  private readonly simpleRunner: SimpleAgentRunner;
  private readonly limit: ReturnType<typeof createLimiter>;
  private readonly healConfig: SelfHealConfig;
  private readonly checkpoints: CheckpointStore;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    const runnerDeps: RunnerDeps = {
      modelRouter: deps.modelRouter,
      graph: deps.graph,
      policy: deps.policy,
      sandbox: deps.sandbox,
    };
    this.runner = deps.runner ?? createAgentRunner(runnerDeps);
    this.simpleRunner = new SimpleAgentRunner(runnerDeps);
    this.limit = createLimiter(deps.maxConcurrent ?? defaultMaxConcurrent());
    this.healConfig = resolveSelfHealConfig(deps.selfHeal);
    this.checkpoints = deps.checkpoints ?? globalCheckpointStore;
  }

  private emit(event: ProgressEvent) {
    return this.deps.onEvent?.(event);
  }

  async run(
    session: ReviewSession,
    job: ReviewJob,
    paths: string[],
    options: OrchestratorRunOptions = {},
  ): Promise<OrchestratorResult> {
    const { policy, graph, findings, modelRouter, learning } = this.deps;
    let current: ReviewSession = {
      ...session,
      status: "running",
      updatedAt: nowIso(),
      failureLog: session.failureLog ?? [],
    };
    const existingCheckpoint = options.resume
      ? await this.checkpoints.load(session.id)
      : null;

    await this.emit(stageEvent(session.id, "policy", "Loaded policy"));
    current = { ...current, stage: "policy" };

    if (learning && policy.ignoreRules.length) {
      try {
        await seedMemoriesFromSteward(learning, {
          orgId: session.orgId,
          repoId: job.repoId,
          ignoreRules: policy.ignoreRules,
          focus: policy.focus,
        });
      } catch {
        /* optional */
      }
    }

    // Model-side learning: inject org memories/reactions into specialist system prompts
    let learningGuidance = "";
    if (learning) {
      try {
        learningGuidance = await buildOrgLearningPrompt(learning, {
          orgId: session.orgId ?? "local",
          repoId: job.repoId,
          prNumber: job.prNumber ?? job.scm?.prNumber,
        });
        if (learningGuidance) {
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "info",
            message: `Learning loaded for model prompts (~${learningGuidance.length} chars, org=${session.orgId ?? "local"}, scopes=pr→repo→org)`,
            ts: nowIso(),
          });
        }
      } catch {
        /* optional */
      }
    }

    // Mention / triage focus (from webhook comment)
    const reviewFocus =
      typeof job.metadata?.reviewFocus === "string"
        ? job.metadata.reviewFocus
        : typeof session.metadata?.reviewFocus === "string"
          ? (session.metadata.reviewFocus as string)
          : undefined;
    if (reviewFocus) {
      learningGuidance = [
        learningGuidance,
        "",
        "# Review focus (from PR comment)",
        reviewFocus.slice(0, 800),
      ]
        .filter(Boolean)
        .join("\n");
    }

    // Linked GitHub issues (Fixes #n / Closes #n) → product context
    try {
      const scm = this.deps.scm;
      const owner = job.scm?.owner;
      const repo = job.scm?.repo;
      const prNumber = job.prNumber ?? job.scm?.prNumber;
      if (scm && owner && repo && prNumber) {
        let prBody =
          typeof job.metadata?.prBody === "string"
            ? (job.metadata.prBody as string)
            : typeof session.metadata?.prBody === "string"
              ? (session.metadata.prBody as string)
              : "";
        if (!prBody) {
          try {
            const pr = await scm.getPullRequest(owner, repo, prNumber);
            prBody = pr.body ?? "";
          } catch {
            /* optional */
          }
        }
        const refs = parseLinkedIssueRefs(prBody);
        if (refs.length && typeof scm.getIssue === "function") {
          const issues = await loadLinkedIssues(refs, async (n) => {
            try {
              return await scm.getIssue!(owner, repo, n);
            } catch {
              return null;
            }
          });
          const block = formatLinkedIssuesContext(issues);
          if (block) {
            learningGuidance = [learningGuidance, "", block].filter(Boolean).join("\n");
            await this.emit({
              type: "log",
              sessionId: session.id,
              level: "info",
              message: `Linked issues loaded: ${issues.map((i) => `#${i.number}`).join(", ")}`,
              ts: nowIso(),
            });
          }
        }
      }
    } catch {
      /* optional */
    }

    const promptPack = this.deps.promptPack ?? null;
    if (promptPack?.roles && Object.keys(promptPack.roles).length) {
      await this.emit({
        type: "log",
        sessionId: session.id,
        level: "info",
        message: `Org prompt pack active (${Object.keys(promptPack.roles).length} role template(s))`,
        ts: nowIso(),
      });
    }

    let effectivePaths = paths;
    let incremental = false;
    if (learning && job.mode === "gate" && !job.fullReview) {
      const inc = await resolveIncrementalPaths({
        learning,
        repoId: job.repoId,
        orgId: session.orgId ?? "local",
        repoPath: job.repoPath,
        headSha: job.headSha,
        allPaths: paths,
        full: job.fullReview,
      });
      if (inc.incremental) {
        incremental = true;
        effectivePaths = inc.paths;
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "info",
          message: `Incremental re-review since ${inc.lastReviewedSha ?? "?"}: ${effectivePaths.length} files`,
          ts: nowIso(),
        });
        if (!effectivePaths.length) {
          this.deps.audit?.patchContext({
            incremental: true,
            pathsEffective: [],
            lastReviewedSha: inc.lastReviewedSha,
          });
          const audit = this.deps.audit?.finalize({
            findingCount: 0,
            emptyDiff: true,
          });
          if (audit) {
            audit.zeroFindings = {
              reason: "incremental_no_changes",
              message: `0 findings: incremental gate found no changed files since ${inc.lastReviewedSha ?? "last review"}.`,
              evidence: [
                `lastReviewedSha: ${inc.lastReviewedSha ?? "—"}`,
                "No paths to review after incremental filter",
                `code source: ${audit.context.source}`,
              ],
            };
          }
          current = {
            ...current,
            status: "completed",
            stage: "completed",
            verdict: "approve",
            completedAt: nowIso(),
            updatedAt: nowIso(),
            audit: audit ?? current.audit,
            metadata: {
              ...current.metadata,
              incremental: true,
              emptyDiff: true,
              lastReviewedSha: inc.lastReviewedSha,
              audit: audit ?? current.metadata?.audit,
              auditHeadline: {
                source: audit?.context.source ?? "mount",
                verified: audit?.context.verified ?? false,
                specialistRuns: 0,
                zeroFindingsReason: "incremental_no_changes",
              },
            },
          };
          await this.emit({
            type: "audit_summary",
            sessionId: session.id,
            source: audit?.context.source,
            specialistRuns: 0,
            toolCalls: 0,
            zeroFindingsReason: "incremental_no_changes",
            message: audit?.zeroFindings?.message,
            ts: nowIso(),
          });
          await this.emit({
            type: "completed",
            sessionId: session.id,
            status: "completed",
            findingCount: 0,
            severityCounts: {},
            ts: nowIso(),
          });
          return {
            session: current,
            findings: [],
            units: [],
            dropped: [],
            incremental: true,
            failureLog: [],
          };
        }
      }
    }

    const skipBootstrap =
      Boolean(existingCheckpoint) &&
      (existingCheckpoint!.stage === "specialists" ||
        existingCheckpoint!.stage === "verification" ||
        existingCheckpoint!.stage === "judge" ||
        existingCheckpoint!.stage === "discourse" ||
        existingCheckpoint!.stage === "prove" ||
        existingCheckpoint!.stage === "publish");

    let packedContext: string | undefined;
    if (!skipBootstrap) {
      await this.emit(stageEvent(session.id, "graph", "Checking graph"));
      current = { ...current, stage: "graph" };
      try {
        const status = await graph.status({
          tenantId: job.tenantId,
          repoId: job.repoId,
        });
        this.deps.audit?.patchContext({
          graph: {
            mock: Boolean(status.stub) || process.env.GRAPH_MOCK === "1",
            lastBuild: status.last_build ?? null,
            degraded: false,
          },
        });
        if (!status.last_build && job.repoPath) {
          // Prefer path-scoped rebuild when the job lists paths (gate diffs or
          // stewardship path filters). Full monorepo rebuild can hang 10+ min
          // and used to block reviews until the SSE tool timeout fired.
          const scoped =
            effectivePaths?.length &&
            !(effectivePaths.length === 1 && effectivePaths[0] === ".");
          await graph.rebuild({
            repoPath: job.repoPath,
            tenantId: job.tenantId,
            repoId: job.repoId,
            changedFiles: scoped ? effectivePaths : undefined,
          });
          this.deps.audit?.recordTool({
            tool: "graph_rebuild",
            name: "graph_rebuild",
            summary: scoped
              ? `rebuild ${job.repoId} (${effectivePaths!.length} paths)`
              : `rebuild ${job.repoId} (full)`,
            ok: true,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.audit?.patchContext({
          graph: {
            mock: process.env.GRAPH_MOCK === "1",
            lastBuild: null,
            degraded: true,
            message: msg,
          },
        });
        this.deps.audit?.recordTool({
          tool: "graph_status",
          name: "graph_status",
          summary: `degraded: ${msg.slice(0, 200)}`,
          ok: false,
        });
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "warn",
          message: `Graph degraded: ${msg}`,
          ts: nowIso(),
        });
        // Do NOT throw — leave graph.degraded on audit so evaluateGate can fail
        // the Check Run cleanly (throw would leave in_progress checks hung).
        const thorough =
          job.riskTier === "thorough" || job.depth === "thorough";
        const requireGraph =
          policy.requireGraph ||
          (policy.requireGraphForThorough !== false && thorough) ||
          process.env.STEW_REQUIRE_GRAPH === "1";
        if (requireGraph && process.env.GRAPH_MOCK !== "1") {
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "error",
            message: `Graph required (tier=${job.riskTier}/${job.depth}) but unavailable — merge gate will fail the Check Run`,
            ts: nowIso(),
          });
        }
      }

      if (job.patches?.length) {
        const packed = packDiffContext(
          job.patches.map(
            (p): DiffFile => ({
              path: p.path,
              status: p.status ?? "modified",
              patch: p.patch,
              previousPath: p.previousPath,
              additions: p.additions ?? 0,
              deletions: p.deletions ?? 0,
            }),
          ),
          { tokenBudget: Number(process.env.STEW_DIFF_TOKEN_BUDGET ?? 12_000) },
        );
        packedContext = packed.text;
        this.deps.audit?.patchContext({
          filesIncluded: packed.filesIncluded,
          estimatedTokens: packed.estimatedTokens,
          truncated: packed.truncated,
          tokenBudget: Number(process.env.STEW_DIFF_TOKEN_BUDGET ?? 12_000),
        });
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "info",
          message: `Diff packed: ${packed.filesIncluded.length} files, ~${packed.estimatedTokens} tokens${packed.truncated ? " (truncated)" : ""}`,
          ts: nowIso(),
        });
      } else if (job.repoPath) {
        // Stewardship / gate without patches: pack real source from the tree
        try {
          const packed = await packRepoContext({
            repoPath: job.repoPath,
            paths: effectivePaths,
            tokenBudget: Number(process.env.STEW_CODE_TOKEN_BUDGET ?? 14000),
          });
          packedContext = packed.text;
          this.deps.audit?.patchContext({
            filesIncluded: packed.filesIncluded,
            filesOmitted: packed.filesOmitted,
            estimatedTokens: packed.estimatedTokens,
            truncated: packed.truncated,
            tokenBudget: Number(process.env.STEW_CODE_TOKEN_BUDGET ?? 14000),
          });
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "info",
            message: `Code packed: ${packed.filesIncluded.length} files, ~${packed.estimatedTokens} tokens${packed.truncated ? " (truncated)" : ""} from ${job.repoPath}`,
            ts: nowIso(),
          });
        } catch (err) {
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "warn",
            message: `Code pack failed: ${err instanceof Error ? err.message : String(err)}`,
            ts: nowIso(),
          });
        }
      }
    }

    let units: ReviewUnit[];
    let candidates: FindingCandidate[] = [];
    let sastCandidates: FindingCandidate[] = [];
    let failureLog: AgentFailureLogEntry[] = [...(current.failureLog ?? [])];
    const strategiesUsed: Record<string, HealStrategy[]> = {
      ...(existingCheckpoint?.strategiesUsed ?? {}),
    };
    let crossRepoRepos: string[] = [job.repoId];

    if (existingCheckpoint && options.resume) {
      units = existingCheckpoint.units.map((u) => ({ ...u }));
      candidates = [...existingCheckpoint.candidates];
      failureLog = [...existingCheckpoint.failureLog];
      crossRepoRepos =
        (current.metadata?.crossRepoRepos as string[] | undefined) ?? [job.repoId];
      await this.emit({
        type: "log",
        sessionId: session.id,
        level: "info",
        message: `Resuming from checkpoint: ${existingCheckpoint.completedUnitIds.length} unit(s) done, ${candidates.length} partial finding(s)`,
        ts: nowIso(),
      });
      current = {
        ...current,
        units,
        stage: "specialists",
        checkpoint: toCheckpointSummary(existingCheckpoint),
        failureLog,
      };
    } else {
      await this.emit(stageEvent(session.id, "planning", "Planning review units"));
      current = { ...current, stage: "planning" };
      units = planReviewUnits({
        sessionId: session.id,
        mode: job.mode,
        paths: effectivePaths,
        riskTier: job.riskTier,
      });

      if (job.crossRepo !== false && this.deps.crossRepoLinks?.length) {
        const prepared = await prepareCrossRepoReview({
          sessionId: session.id,
          primaryRepoId: job.repoId,
          primaryRepoPath: job.repoPath,
          primaryPaths: effectivePaths,
          links: this.deps.crossRepoLinks,
          budget: job.crossRepoBudget,
          graph,
          tenantId: job.tenantId,
          cloneAuth: this.deps.cloneAuth,
          provider:
            this.deps.cloneAuth?.provider ??
            job.scm?.provider ??
            process.env.SCM_PROVIDER ??
            "github",
          // Primary graph rebuild already ran in graph stage when needed
          rebuildPrimary: false,
          rebuildLinkedGraphs: true,
          onLog: async ({ level, message }) => {
            await this.emit({
              type: "log",
              sessionId: session.id,
              level,
              message,
              ts: nowIso(),
            });
          },
          onRebuild: async ({ repoId, ok, error }) => {
            this.deps.audit?.recordTool({
              tool: "graph_rebuild",
              name: "graph_rebuild",
              summary: ok
                ? `cross-repo rebuild ${repoId}`
                : `cross-repo rebuild ${repoId} failed: ${(error ?? "").slice(0, 120)}`,
              ok,
            });
          },
        });
        crossRepoRepos = prepared.repos;
        if (prepared.units.length) {
          units = [...units, ...prepared.units];
        }
      }
      current = { ...current, units };
    }

    await this.emit(
      stageEvent(
        session.id,
        "specialists",
        `Running ${units.length} units (self-heal enabled)`,
      ),
    );
    current = { ...current, stage: "specialists" };

    const workQueue: ReviewUnit[] = units.filter(
      (u) =>
        u.status === "pending" || u.status === "running" || u.status === "failed",
    );
    for (const u of workQueue) {
      if (u.status === "running" || u.status === "failed") {
        u.status = "pending";
        u.error = undefined;
      }
    }

    
    // Early SAST (semgrep / gitleaks when binaries on PATH)
    if (job.repoPath && process.env.STEW_SAST !== "0") {
      try {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "info",
          message: "Running SAST adapters (semgrep/gitleaks if available)",
          ts: nowIso(),
        });
        sastCandidates = await runSastAdapters({
          repoPath: job.repoPath,
          paths: effectivePaths,
        });
        if (sastCandidates.length) {
          candidates = [...sastCandidates, ...candidates];
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "info",
            message: `SAST produced ${sastCandidates.length} candidate(s)`,
            ts: nowIso(),
          });
        }
      } catch (err) {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "warn",
          message: `SAST skipped: ${err instanceof Error ? err.message : String(err)}`,
          ts: nowIso(),
        });
      }
    }

    const unitIndex = new Map<string, ReviewUnit>();
    for (const u of units) unitIndex.set(u.id, u);

    const persistCheckpoint = async (
      stage: ReviewSession["stage"] = "specialists",
    ) => {
      const allUnits = [...unitIndex.values()];
      const payload: SessionCheckpointPayload = {
        sessionId: session.id,
        job,
        stage,
        units: allUnits,
        candidates: [...candidates],
        completedUnitIds: allUnits
          .filter((u) => u.status === "completed")
          .map((u) => u.id),
        failedUnitIds: allUnits.filter((u) => u.status === "failed").map((u) => u.id),
        skippedUnitIds: allUnits
          .filter((u) => u.status === "skipped")
          .map((u) => u.id),
        strategiesUsed: { ...strategiesUsed },
        failureLog: [...failureLog],
        partialFindingCount: candidates.length,
        lastUnitId: allUnits.find((u) => u.status === "completed")?.id,
        updatedAt: nowIso(),
      };
      await this.checkpoints.save(payload);
      current = {
        ...current,
        units: allUnits,
        checkpoint: toCheckpointSummary(payload),
        failureLog: [...failureLog],
        updatedAt: nowIso(),
      };
      await this.deps.onCheckpoint?.(current, payload);
    };

    await persistCheckpoint("specialists");

    const runOne = async (unit: ReviewUnit) => {
      unit.status = "running";
      unit.startedAt = nowIso();
      unitIndex.set(unit.id, unit);
      await this.emit({
        type: "unit",
        sessionId: session.id,
        unitId: unit.id,
        label: unit.label,
        status: "running",
        ts: nowIso(),
      });

      const roles = (unit.assignedRoles.length
        ? unit.assignedRoles
        : ["generalist"]) as AgentRole[];
      const specialistRoles = roles.filter((r) => r !== "discourse") as AgentRole[];

      const unitRepoId =
        (unit.metadata?.repoId as string | undefined) ?? job.repoId;
      const isCrossRepo = Boolean(unit.metadata?.crossRepo);
      // Cross-repo units MUST use their own materialized path — never the primary tree
      const unitRepoPath =
        (typeof unit.metadata?.repoPath === "string" && unit.metadata.repoPath) ||
        (isCrossRepo ? undefined : job.repoPath);

      let baseContext =
        (unit.metadata?.context as string | undefined) ??
        (isCrossRepo ? undefined : packedContext) ??
        (job.mode === "gate" && !isCrossRepo ? unit.paths.join("\n") : undefined);

      // Pack source from the linked tree so specialists actually read that repo
      if (isCrossRepo && unitRepoPath) {
        try {
          const charBudget = Number(process.env.STEW_CROSS_REPO_CONTEXT_CHARS ?? 24_000);
          const packed = await packRepoContext({
            repoPath: unitRepoPath,
            paths: unit.paths?.length ? unit.paths : ["."],
            tokenBudget: Math.max(2000, Math.floor(charBudget / 4)),
          });
          baseContext = [
            `# Cross-repo unit: ${unitRepoId}`,
            `Source path: ${unitRepoPath}`,
            unit.metadata?.context ? String(unit.metadata.context) : "",
            "",
            packed.text,
          ]
            .filter(Boolean)
            .join("\n");
        } catch (err) {
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "warn",
            message: `Cross-repo context pack failed for ${unitRepoId}: ${err instanceof Error ? err.message : String(err)}`,
            ts: nowIso(),
          });
          baseContext = [
            baseContext,
            `WARNING: failed to pack ${unitRepoPath} — path may be unreadable`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      } else if (isCrossRepo && !unitRepoPath) {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "error",
          message: `Cross-repo unit ${unit.label} has no repoPath — skipping to avoid scanning primary tree as ${unitRepoId}`,
          ts: nowIso(),
        });
        unit.status = "skipped";
        unit.error = "linked repo not materialized";
        unit.completedAt = nowIso();
        unitIndex.set(unit.id, unit);
        await this.emit({
          type: "unit",
          sessionId: session.id,
          unitId: unit.id,
          label: unit.label,
          status: "skipped",
          ts: nowIso(),
        });
        return;
      } else if (!baseContext) {
        baseContext = packedContext;
      }

      const result = await runUnitWithHeal({
        sessionId: session.id,
        unit,
        config: this.healConfig,
        onEvent: (e) => this.emit(e),
        onFailureLog: async (entry) => {
          failureLog.push(entry);
        },
        onSplit: async (parent, children) => {
          unitIndex.set(parent.id, parent);
          for (const child of children) {
            unitIndex.set(child.id, child);
            workQueue.push(child);
          }
          await this.emit({
            type: "log",
            sessionId: session.id,
            level: "info",
            message: `Split unit ${parent.label} → ${children.map((c) => c.label).join(", ")}`,
            ts: nowIso(),
          });
        },
        runner: {
          run: async (u, opts) => {
            const contextText = opts.freshContext
              ? [
                  baseContext,
                  "",
                  "[self-heal] Fresh context retry — ignore prior partial analysis for this unit.",
                  `Paths:\n${u.paths.join("\n")}`,
                ]
                  .filter(Boolean)
                  .join("\n")
              : baseContext;

            const activeRunner: AgentRunner = opts.useSimpleRunner
              ? this.simpleRunner
              : this.runner;

            const unitWithPath = {
              ...u,
              metadata: {
                ...u.metadata,
                // Prefer unit's own path (cross-repo); fall back to primary only for primary units
                repoPath: unitRepoPath ?? job.repoPath,
              },
            };
            const ctx = {
              sessionId: session.id,
              repoId: unitRepoId,
              tenantId: job.tenantId,
              unit: unitWithPath,
              policy,
              modelRouter,
              graph,
              contextText,
              learningGuidance: learningGuidance || undefined,
              promptPack,
              audit: this.deps.audit,
              onEvent: (e: ProgressEvent) => this.emit(e),
              runnerKind:
                opts.useSimpleRunner || activeRunner === this.simpleRunner
                  ? ("simple" as const)
                  : ("deepagents" as const),
            };

            let unitFindings: FindingCandidate[];
            if (activeRunner.runUnit) {
              unitFindings = await activeRunner.runUnit(specialistRoles, ctx);
            } else {
              const batches = await Promise.all(
                specialistRoles.map((role) => activeRunner.runSpecialist(role, ctx)),
              );
              unitFindings = batches.flat();
            }
            for (const f of unitFindings) {
              if (!f.repoId) f.repoId = unitRepoId;
            }
            return unitFindings;
          },
        },
      });

      for (const f of result.findings) {
        if (!f.repoId || f.repoId === "unknown") f.repoId = unitRepoId;
        candidates.push(f);
      }

      if (result.strategyUsed) {
        const prev = strategiesUsed[unit.id] ?? [];
        strategiesUsed[unit.id] = [...prev, result.strategyUsed];
      }

      Object.assign(unit, result.unit);
      unitIndex.set(unit.id, unit);

      await this.emit({
        type: "unit",
        sessionId: session.id,
        unitId: unit.id,
        label: unit.label,
        status: unit.status,
        ts: nowIso(),
      });

      await persistCheckpoint("specialists");
    };

    const pending = new Set<Promise<void>>();
    let cursor = 0;
    const maxC = this.deps.maxConcurrent ?? defaultMaxConcurrent();
    while (cursor < workQueue.length || pending.size > 0) {
      while (cursor < workQueue.length && pending.size < maxC) {
        const unit = workQueue[cursor++]!;
        if (unit.status === "completed" || unit.status === "skipped") continue;
        const p = this.limit(() => runOne(unit)).then(() => {
          pending.delete(p);
        });
        pending.add(p);
      }
      if (pending.size === 0) break;
      await Promise.race(pending);
    }

    units = [...unitIndex.values()];
    current = { ...current, units, failureLog };

    let discourseNotes = 0;
    let discourseTranscript: Array<Record<string, unknown>> = [];
    let discourseSummary: Record<string, unknown> | undefined;
    let afterDiscourse = candidates;
    if (shouldRunDiscourse({ riskTier: job.riskTier, depth: job.depth })) {
      await this.emit(stageEvent(session.id, "discourse", "Discourse: dual correctness + synthesis"));
      current = { ...current, stage: "discourse" };
      try {
        const disc = await runDiscourse(
          {
            sessionId: session.id,
            repoId: job.repoId,
            tenantId: job.tenantId,
            policy,
            modelRouter,
            graph,
            contextText: packedContext,
            learningGuidance: learningGuidance || undefined,
            promptPack,
            units,
          },
          candidates,
        );
        afterDiscourse = disc.findings;
        discourseNotes = disc.notes.length;
        discourseTranscript = (disc.notes ?? []).map((n) =>
          typeof n === "object" && n !== null
            ? ({ ...(n as unknown as Record<string, unknown>) } as Record<string, unknown>)
            : { text: String(n) },
        );
        discourseSummary = {
          passACount: disc.passACount,
          passBCount: disc.passBCount,
          notes: disc.notes.length,
          surfacedCount: disc.surfacedCount,
          droppedByChallenge: disc.droppedByChallenge,
        };
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "info",
          message: `Discourse: passA=${disc.passACount} passB=${disc.passBCount} notes=${disc.notes.length} surfaced=${disc.surfacedCount} challenged≈${disc.droppedByChallenge} | ${JSON.stringify(discourseSummary)}`,
          ts: nowIso(),
        });
        // Persist mid-run so UI can show transcript before completion
        current = {
          ...current,
          metadata: {
            ...current.metadata,
            discourse: discourseSummary,
            discourseTranscript,
            discourseNotes,
          },
        };
      } catch (err) {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "warn",
          message: `Discourse failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
          ts: nowIso(),
        });
      }
    }

    await this.emit(stageEvent(session.id, "verification", "Verifying findings"));
    current = { ...current, stage: "verification" };
    // SAST candidates already merged into `candidates` early; afterDiscourse includes them.
    const verified = await verifyFindings(afterDiscourse, policy, modelRouter);

    let suppressedFingerprints: Set<string> | undefined;
    let negativePatterns: string[] | undefined;
    let priorFingerprints: ReturnType<typeof priorMapFromFindings> | undefined;

    if (learning) {
      try {
        const neg = await learning.negativeSuppression({
          // Always scope — unscoped negativeSuppression merges every org
          orgId: session.orgId ?? "local",
          repoId: job.repoId,
        });
        suppressedFingerprints = neg.fingerprints;
        negativePatterns = neg.patterns;
      } catch {
        /* optional */
      }
    }

    if (incremental || job.headSha) {
      try {
        const priorFindings = await findings.list({
          repoId: job.repoId,
          orgId: session.orgId ?? "local",
        });
        priorFingerprints = priorMapFromFindings(priorFindings);
      } catch {
        /* optional */
      }
    }

    await this.emit(stageEvent(session.id, "judge", "Judging / noise stack"));
    current = { ...current, stage: "judge" };
    const judged = judgeFindings(verified, policy, {
      suppressedFingerprints,
      negativePatterns,
      priorFingerprints,
      commentCap: Number(process.env.STEW_COMMENT_CAP ?? 25),
    });
    this.deps.audit?.setJudge({
      inputCount: verified.length,
      outputCount: judged.findings.length,
      dropped: judged.dropped,
      severityFloor: policy.severityFloor,
      commentCap: Number(process.env.STEW_COMMENT_CAP ?? 25),
      sastCount: sastCandidates.length,
      discourse: discourseSummary
        ? {
            ran: true,
            notes: discourseNotes,
            passACount: Number(discourseSummary.passACount ?? 0) || undefined,
            passBCount: Number(discourseSummary.passBCount ?? 0) || undefined,
            surfacedCount: Number(discourseSummary.surfacedCount ?? 0) || undefined,
            droppedByChallenge:
              Number(discourseSummary.droppedByChallenge ?? 0) || undefined,
          }
        : { ran: Boolean(discourseNotes) },
    });

    let proved = judged.findings;
    const allowProve = this.deps.allowProve !== false;
    const proveThreshold = allowProve
      ? (policy.proveOnSeverity ?? (job.riskTier === "thorough" ? "critical" : undefined))
      : undefined;
    if (!allowProve && (policy.proveOnSeverity || job.riskTier === "thorough")) {
      await this.emit(
        stageEvent(
          session.id,
          "prove",
          "Prove skipped — license does not include prove entitlement",
        ),
      );
    }
    if (proveThreshold && (this.deps.sandbox || job.repoPath)) {
      const rank: Record<string, number> = {
        critical: 100,
        high: 80,
        medium: 60,
        low: 40,
        info: 20,
        nit: 10,
      };
      const floor = rank[proveThreshold] ?? 100;
      const toProve = judged.findings
        .filter((f) => (rank[f.severity] ?? 0) >= floor)
        .slice(0, 3);
      if (toProve.length) {
        await this.emit(
          stageEvent(session.id, "prove", `Prove tier on ${toProve.length} findings`),
        );
        current = { ...current, stage: "prove" };
        const useDocker = await dockerAvailable().catch(() => false);
        const proveSet = new Set(toProve);
        proved = [];
        for (const f of judged.findings) {
          if (!proveSet.has(f)) {
            proved.push(f);
            continue;
          }
          try {
            const result = await proveFinding({
              createSandbox: () => this.deps.sandbox ?? new LocalSandbox({ useDocker }),
              llm: {
                complete: async (req) => {
                  const model = modelRouter.createChatModel("prove");
                  const res = await model.complete(req);
                  return { content: res.content };
                },
              },
              finding: {
                findingId: f.title.slice(0, 32),
                title: f.title,
                body: f.body ?? "",
                path: f.path,
                startLine: f.startLine,
                endLine: f.endLine,
                severity: f.severity,
                category: f.category,
              },
              repoPath: job.repoPath,
              sha: job.headSha,
            });
            proved.push({
              ...f,
              evidence: [
                ...(f.evidence ?? []),
                {
                  id: evidenceId(),
                  type: "prove",
                  summary: result.summary,
                  payload: {
                    status: result.status,
                    exitCode: result.exitCode,
                    artifacts: result.artifacts,
                    logs: (result.logs ?? "").slice(0, 4000),
                  },
                },
              ],
              confidence: Math.min(
                1,
                (f.confidence ?? 0.7) + (result.status === "failed" ? 0.1 : 0),
              ),
            });
            await this.emit({
              type: "log",
              sessionId: session.id,
              level: "info",
              message: `Prove ${f.title.slice(0, 60)} → ${result.status}`,
              ts: nowIso(),
            });
          } catch (err) {
            proved.push(f);
            await this.emit({
              type: "log",
              sessionId: session.id,
              level: "warn",
              message: `Prove failed for ${f.title.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`,
              ts: nowIso(),
            });
          }
        }
      }
    }

    const findingScope: FindingScope = {
      orgId: session.orgId ?? "local",
      repoId: job.repoId,
      mode: job.mode ?? session.mode ?? "gate",
      prNumber: job.prNumber ?? job.scm?.prNumber ?? session.prNumber,
      headBranch:
        session.headBranch ??
        (job as { headBranch?: string }).headBranch ??
        undefined,
    };

    const scopeTagList = scopeTags(findingScope);
    const persisted = [];
    const upsertStats = { created: 0, updated: 0, reopened: 0, kept_closed: 0 };
    // Drop low-confidence concrete fixes (platform STEW_SUGGESTED_FIX_MIN_CONFIDENCE)
    proved = applySuggestedFixConfidenceGate(proved);
    for (const c of proved) {
      const { finding: f, action } = await upsertFindingAcrossSessions(
        findings,
        {
          ...c,
          sessionId: session.id,
          repoId: c.repoId ?? job.repoId,
          tenantId: job.tenantId,
          orgId: session.orgId ?? "local",
          tags: [...new Set([...(c.tags ?? []), ...scopeTagList])],
        },
        findingScope,
      );
      upsertStats[action] += 1;
      // Skip noise from kept_closed (user dismissed) in session feed
      if (action === "kept_closed") continue;
      persisted.push(f);
      await this.emit({
        type: "finding",
        sessionId: session.id,
        finding: f,
        ts: nowIso(),
      });
    }

    const completedUnits = units.filter((u) => u.status === "completed");
    const skippedUnits = units.filter((u) => u.status === "skipped");
    const failedUnits = units.filter((u) => u.status === "failed");
    const recoveredUnits = units.filter((u) => u.healed);

    // Auto-close prior open findings for this PR/branch that are no longer present.
    // Use *verified* fingerprints (before re-review convergence drops "already reported").
    // Never auto-fix when zero units completed (agents failed — absence is not a fix).
    try {
      const present = presentFingerprintSet(verified);
      const reviewedPaths =
        incremental && effectivePaths?.length ? effectivePaths : undefined;
      const rec = await reconcileFindingsOnRereview(findings, {
        scope: findingScope,
        sessionId: session.id,
        presentFingerprints: present,
        reviewedPaths,
        skip: completedUnits.length === 0,
      });
      if (rec.fixed.length) {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "info",
          message: `Lifecycle: auto-fixed ${rec.fixed.length} prior finding(s) no longer present on this ${findingScope.prNumber != null ? `PR #${findingScope.prNumber}` : findingScope.headBranch ? `branch ${findingScope.headBranch}` : "scope"}`,
          ts: nowIso(),
        });
      }
      if (upsertStats.updated || upsertStats.reopened) {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "info",
          message: `Lifecycle: upsert created=${upsertStats.created} updated=${upsertStats.updated} reopened=${upsertStats.reopened} kept_closed=${upsertStats.kept_closed}`,
          ts: nowIso(),
        });
      }
    } catch (err) {
      await this.emit({
        type: "log",
        sessionId: session.id,
        level: "warn",
        message: `Finding lifecycle reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        ts: nowIso(),
      });
    }

    const zeroUseful =
      completedUnits.length === 0 &&
      persisted.filter((f) => !f.tags?.includes("coverage-gap")).length === 0;
    const sessionStatus: ReviewSession["status"] = zeroUseful
      ? "failed"
      : skippedUnits.length > 0 || failedUnits.length > 0
        ? "completed_with_errors"
        : "completed";

    const healStats: HealPublishStats = {
      totalUnits: units.length,
      completedUnits: completedUnits.length,
      recoveredUnits: recoveredUnits.length,
      skippedUnits: skippedUnits.length,
      failedUnits: failedUnits.length,
      failureLog,
    };

    let publishedReviewId: string | undefined;
    if (job.scm?.publish && this.deps.scm && job.mode === "gate") {
      await this.emit(stageEvent(session.id, "publish", "Publishing review to SCM"));
      current = { ...current, stage: "publish" };
      try {
        publishedReviewId = await this.publishScm(
          job,
          persisted,
          healStats,
          sessionStatus === "failed"
            ? "failed"
            : sessionStatus === "completed_with_errors"
              ? "completed_with_errors"
              : "completed",
          {
            policy,
            graphDegraded: Boolean(
              (current.audit as { context?: { graph?: { degraded?: boolean } } } | undefined)
                ?.context?.graph?.degraded ||
                (current.metadata?.audit as { context?: { graph?: { degraded?: boolean } } })
                  ?.context?.graph?.degraded,
            ),
          },
        );
      } catch (err) {
        await this.emit({
          type: "log",
          sessionId: session.id,
          level: "error",
          message: `SCM publish failed: ${err instanceof Error ? err.message : String(err)}`,
          ts: nowIso(),
        });
      }
    }

    if (learning && job.headSha) {
      try {
        await markReviewed(learning, {
          repoId: job.repoId,
          orgId: session.orgId,
          headSha: job.headSha,
          sessionId: session.id,
          prNumber: job.prNumber ?? job.scm?.prNumber,
        });
      } catch {
        /* optional */
      }
    }

    const budget = modelRouter.getBudget();
    const usageSnap =
      typeof budget.snapshot === "function"
        ? budget.snapshot()
        : {
            promptTokens: budget.promptTokens ?? 0,
            completionTokens: budget.completionTokens ?? 0,
            totalTokens: budget.usedTokens,
            costUsd: budget.costUsd ?? 0,
            costEstimated: true as const,
            calls: budget.calls ?? 0,
            byModel: undefined as
              | Record<
                  string,
                  {
                    promptTokens: number;
                    completionTokens: number;
                    totalTokens: number;
                    costUsd: number;
                    calls: number;
                  }
                >
              | undefined,
          };
    const lastFailures = failureLog.slice(-5);
    const primaryError =
      sessionStatus === "failed"
        ? lastFailures[lastFailures.length - 1]?.error ??
          units.find((u) => u.error)?.error ??
          "Review failed with no findings (see failureLog)"
        : undefined;
    this.deps.audit?.setHeal({
      recoveredUnits: healStats.recoveredUnits,
      failedUnits: healStats.failedUnits,
      failureCount: failureLog.length,
    });
    this.deps.audit?.patchContext({
      pathsEffective: effectivePaths,
      incremental,
    });

    const audit = this.deps.audit?.finalize({
      findingCount: persisted.length,
      emptyDiff: Boolean(current.metadata?.emptyDiff),
      unitsFailed:
        healStats.failedUnits > 0 ||
        units.some((u) => u.status === "failed" || (u.status === "skipped" && u.error)),
    });

    if (audit) {
      await this.emit({
        type: "audit_summary",
        sessionId: session.id,
        source: audit.context.source,
        specialistRuns: audit.specialistRuns.length,
        toolCalls: audit.tools.total,
        zeroFindingsReason: audit.zeroFindings?.reason,
        message: audit.zeroFindings?.message,
        ts: nowIso(),
      });
    }

    const gateVerdict = zeroUseful
      ? ("unknown" as const)
      : evaluateGate({
          policy,
          findings: proved,
          sessionStatus:
            sessionStatus === "failed"
              ? "failed"
              : sessionStatus === "completed_with_errors"
                ? "completed_with_errors"
                : "completed",
          graphDegraded: Boolean(audit?.context?.graph?.degraded),
          riskTier: job.riskTier,
          depth: job.depth,
          findingCount: proved.length,
        }).verdict;

    // Human-readable session report (always; LLM narrative for stewardship when models available)
    let sessionReport: Awaited<ReturnType<typeof buildSessionReport>> | undefined;
    try {
      sessionReport = await buildSessionReport({
        session: {
          ...current,
          completedAt: nowIso(),
          verdict: gateVerdict,
        },
        job,
        findings: proved.map((f) => ({
          title: f.title,
          body: f.body,
          path: f.path,
          startLine: f.startLine,
          severity: f.severity,
          category: f.category,
          agents: f.agents,
          suggestion: f.suggestion,
          suggestedFix: f.suggestedFix,
        })),
        units,
        dropped: judged.dropped,
        audit: audit ?? current.audit,
        discourseNotes,
        crossRepoRepos,
        verdict: gateVerdict,
        modelRouter,
      });
      await this.emit({
        type: "session_report",
        sessionId: session.id,
        headline: sessionReport.headline,
        findingCount: sessionReport.findingCount,
        verdict: sessionReport.verdict,
        llmNarrative: sessionReport.llmNarrative,
        ts: nowIso(),
      });
    } catch (err) {
      await this.emit({
        type: "log",
        sessionId: session.id,
        level: "warn",
        message: `Session report generation failed: ${err instanceof Error ? err.message : String(err)}`,
        ts: nowIso(),
      });
    }

    current = {
      ...current,
      status: sessionStatus,
      stage: sessionStatus === "failed" ? "failed" : "completed",
      units,
      failureLog,
      error: primaryError,
      audit: audit ?? current.audit,
      tokenUsage: {
        promptTokens: usageSnap.promptTokens,
        completionTokens: usageSnap.completionTokens,
        totalTokens: usageSnap.totalTokens,
        costUsd: usageSnap.costUsd,
        costEstimated: usageSnap.costEstimated,
        calls: usageSnap.calls,
        byModel: usageSnap.byModel,
      },
      completedAt: nowIso(),
      updatedAt: nowIso(),
      metadata: {
        ...current.metadata,
        crossRepoRepos,
        publishedReviewId,
        incremental,
        discourseNotes,
        discourse: discourseSummary ?? current.metadata?.discourse,
        discourseTranscript:
          discourseTranscript.length > 0
            ? discourseTranscript
            : current.metadata?.discourseTranscript,
        lastReviewedSha: job.headSha,
        failureSummary: primaryError,
        failureCount: failureLog.length,
        healStats: {
          totalUnits: healStats.totalUnits,
          completedUnits: healStats.completedUnits,
          recoveredUnits: healStats.recoveredUnits,
          skippedUnits: healStats.skippedUnits,
          failedUnits: healStats.failedUnits,
        },
        // Full audit also in metadata for PG JSONB path (typed session.audit for clients)
        audit: audit ?? current.metadata?.audit,
        auditHeadline: audit
          ? {
              source: audit.context.source,
              verified: audit.context.verified,
              specialistRuns: audit.specialistRuns.length,
              toolCalls: audit.tools.total,
              zeroFindingsReason: audit.zeroFindings?.reason,
            }
          : undefined,
        report: sessionReport,
        reportHeadline: sessionReport?.headline,
      },
      verdict: gateVerdict,
    };

    await persistCheckpoint(current.stage);
    if (sessionStatus === "completed") {
      await this.checkpoints.delete(session.id);
      current = { ...current, checkpoint: undefined };
    }

    await this.emit({
      type: "completed",
      sessionId: session.id,
      status: sessionStatus === "failed" ? "failed" : sessionStatus,
      findingCount: persisted.length,
      severityCounts: severityCounts(persisted),
      ts: nowIso(),
    });

    return {
      session: current,
      findings: persisted,
      units,
      dropped: judged.dropped,
      crossRepoRepos,
      publishedReviewId,
      incremental,
      discourseNotes,
      failureLog,
    };
  }

  private async publishScm(
    job: ReviewJob,
    findings: Array<{
      path?: string;
      startLine?: number;
      endLine?: number;
      title: string;
      body: string;
      severity: string;
      category?: string;
      evidence?: Array<{ snippet?: string; summary?: string; payload?: Record<string, unknown> }>;
      existingCode?: string;
      suggestion?: string;
      suggestedFix?: string;
    }>,
    stats: HealPublishStats,
    sessionStatus: "completed" | "completed_with_errors" | "failed",
    opts?: { graphDegraded?: boolean; policy?: Policy },
  ): Promise<string | undefined> {
    const scm = this.deps.scm!;
    const { owner, repo, prNumber } = job.scm!;
    const policy = opts?.policy ?? this.deps.policy;
    const commentCap = Number(process.env.STEW_COMMENT_CAP ?? 25);
    const capped = capComments(
      findings as Array<{ severity: Severity } & (typeof findings)[0]>,
      commentCap,
    );

    // Constructive partial summary — never bare "CodeSteward failed" unless zero units
    const summaryBase = buildPartialReviewSummary({
      job,
      findings,
      stats,
      sessionStatus,
    }).replace(
      `**Findings:** ${findings.length}`,
      `**Findings:** ${findings.length} (${capped.length} inline)`,
    );
    // Git trailer for attestation / audit (visible in PR summary body)
    const trailer = [
      "",
      "---",
      `STW-REVIEWED: session=${job.sessionId}`,
      `STW-REVIEWED-SHA: ${job.headSha ?? "unknown"}`,
      `STW-REVIEWED-STATUS: ${sessionStatus}`,
      `STW-REVIEWED-FINDINGS: ${findings.length}`,
    ].join("\n");
    const diagram = buildReviewMermaid({
      repoId: job.repoId,
      mode: job.mode,
      paths: job.paths ?? [],
      findings,
    });
    const summary = summaryBase + "\n\n### Change map\n\n" + diagram + trailer;

    // Line re-location / grounding (OCR-style) before SCM publish
    const { relocateLine } = await import("./line-relocate.js");
    const fileCache = new Map<string, string>();
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const repoRoot = job.repoPath ?? process.cwd();
    const inline = [];
    for (const f of capped) {
      if (!f.path) continue;
      let content = fileCache.get(f.path);
      if (content === undefined) {
        try {
          content = await readFile(join(repoRoot, f.path), "utf8");
          fileCache.set(f.path, content);
        } catch {
          content = "";
          fileCache.set(f.path, content);
        }
      }
      const existing =
        f.evidence?.find((e) => e.snippet)?.snippet ??
        f.evidence?.find((e) => e.summary)?.summary ??
        f.existingCode;
      const anchor = relocateLine(content || undefined, {
        path: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
        existingCode: existing,
        message: f.body ?? f.title,
      });
      if (!anchor.grounded && content) {
        // Drop ungrounded inline comments when file exists (diff-grounded filter)
        continue;
      }
      if (!anchor.startLine) continue;
      const parts = [
        `**[${f.severity}/${f.category ?? "other"}]** ${f.title}`,
        "",
        f.body ?? "",
      ];
      if (f.suggestion?.trim()) {
        parts.push("", `**Suggestion:** ${f.suggestion.trim()}`);
      }
      if (f.suggestedFix?.trim()) {
        parts.push(
          "",
          "**Proposed fix:**",
          "```",
          f.suggestedFix.trim(),
          "```",
        );
      }
      inline.push({
        path: f.path,
        line: anchor.startLine,
        body: parts.join("\n").trim(),
      });
    }

    const gate = evaluateGate({
      policy,
      findings,
      sessionStatus,
      graphDegraded: opts?.graphDegraded,
      riskTier: job.riskTier,
      depth: job.depth,
      findingCount: findings.length,
    });

    const summaryWithGate =
      summary +
      `\n\n### Merge gate\n\n- **Mode:** ${gate.advisory ? "advisory" : "enforce"}\n- **Check:** ${gate.checkTitle}\n- **Reasons:** ${gate.reasons.join("; ") || "—"}\n`;

    const posted = await scm.postReview(
      owner,
      repo,
      prNumber,
      summaryWithGate,
      inline,
      gate.reviewEvent,
    );

    // Required Check Run for branch protection (GitHub App needs checks:write)
    if (scm.postCheckRun && job.headSha) {
      try {
        const detailsBase =
          process.env.STEW_PUBLIC_URL ||
          process.env.STEW_API_PUBLIC_URL ||
          "";
        await scm.postCheckRun(owner, repo, {
          name: process.env.STEW_CHECK_NAME ?? "codesteward/gate",
          headSha: job.headSha,
          status: "completed",
          conclusion: gate.checkConclusion,
          title: gate.checkTitle,
          summary: gate.checkSummary,
          text: summaryWithGate.slice(0, 60000),
          detailsUrl: detailsBase
            ? `${detailsBase.replace(/\/$/, "")}/sessions?id=${job.sessionId}`
            : undefined,
        });
      } catch (err) {
        await this.emit({
          type: "log",
          sessionId: job.sessionId,
          level: "warn",
          message: `Check Run publish failed: ${err instanceof Error ? err.message : String(err)}`,
          ts: nowIso(),
        });
      }
    }

    // GitHub Code Scanning (Security tab) — SARIF upload when supported
    await this.publishSarifToCodeScanning(job, findings as Finding[], scm);

    return posted.id;
  }

  /**
   * Upload findings as SARIF to GitHub Code Scanning (Security → Code scanning).
   * Controlled by STEW_PUBLISH_SARIF (env → platform → org → product default on).
   * Applied into process.env via applyOrgRuntimeToProcess before the job runs.
   * Requires code scanning enabled + token with security_events: write.
   */
  private async publishSarifToCodeScanning(
    job: ReviewJob,
    findings: Finding[],
    scm: ScmProvider,
  ): Promise<void> {
    if (!scm.uploadCodeScanningSarif) return;
    if (!job.scm) return;
    // Resolution: env → platform store → org store (applied into process.env on job start)
    // → product default On when unset/empty.
    const flag = process.env.STEW_PUBLISH_SARIF?.trim().toLowerCase();
    if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
      return;
    }
    const headSha = job.headSha?.trim();
    if (!headSha || headSha.length < 7) {
      await this.emit({
        type: "log",
        sessionId: job.sessionId,
        level: "warn",
        message:
          "SARIF Code Scanning upload skipped: job.headSha missing (required by GitHub)",
        ts: nowIso(),
      });
      return;
    }

    const { owner, repo, prNumber } = job.scm;
    const ref =
      prNumber != null
        ? `refs/pull/${prNumber}/head`
        : job.baseBranch
          ? `refs/heads/${job.baseBranch}`
          : process.env.STEW_SARIF_REF?.trim() || undefined;
    if (!ref) {
      await this.emit({
        type: "log",
        sessionId: job.sessionId,
        level: "warn",
        message:
          "SARIF Code Scanning upload skipped: no PR number or branch ref for GitHub",
        ts: nowIso(),
      });
      return;
    }

    try {
      const category =
        process.env.STEW_SARIF_CATEGORY?.trim() ||
        (job.mode === "gate" ? "codesteward/gate" : "codesteward/stewardship");
      const sarif = findingsToSarif(findings, {
        toolName: "Codesteward Review",
        toolVersion: process.env.STEW_VERSION ?? "1.0.0",
        informationUri: "https://github.com/Codesteward/codesteward",
        category,
      });
      const uploaded = await scm.uploadCodeScanningSarif(owner, repo, {
        commitSha: headSha,
        ref,
        sarif,
        toolName: "Codesteward Review",
        startedAt: job.sessionId ? undefined : undefined,
      });
      await this.emit({
        type: "log",
        sessionId: job.sessionId,
        level: "info",
        message: `Uploaded SARIF to GitHub Code Scanning (id=${uploaded.id}${uploaded.url ? ` url=${uploaded.url}` : ""}) — Security → Code scanning`,
        ts: nowIso(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 403/404 are common when GHAS/code scanning is off — don't fail the review
      await this.emit({
        type: "log",
        sessionId: job.sessionId,
        level: "warn",
        message: `SARIF Code Scanning upload failed (review still published): ${msg}`,
        ts: nowIso(),
      });
    }
  }
}

export function createOrchestrator(deps: OrchestratorDeps): ReviewOrchestrator {
  return new ReviewOrchestrator(deps);
}
