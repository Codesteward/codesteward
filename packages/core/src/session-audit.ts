import { z } from "zod";
import { ReviewModeSchema } from "./enums.js";

/** How code was obtained for this review run. */
export const CodeSourceSchema = z.enum([
  "mount",
  "scm_diff",
  "clone",
  "unverified_mount",
]);
export type CodeSource = z.infer<typeof CodeSourceSchema>;

export const ContextReceiptSchema = z.object({
  repoId: z.string(),
  tenantId: z.string().optional(),
  orgId: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  prNumber: z.number().optional(),
  mode: ReviewModeSchema.optional(),
  source: CodeSourceSchema,
  repoPath: z.string().optional(),
  workdir: z.string().optional(),
  verified: z.boolean().default(false),
  verifiedSha: z.string().optional(),
  pathsRequested: z.array(z.string()).default([]),
  pathsEffective: z.array(z.string()).default([]),
  filesIncluded: z.array(z.string()).default([]),
  filesOmitted: z.array(z.string()).default([]),
  tokenBudget: z.number().int().nonnegative().optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  incremental: z.boolean().optional(),
  lastReviewedSha: z.string().optional(),
  graph: z
    .object({
      mock: z.boolean().optional(),
      lastBuild: z.string().nullable().optional(),
      degraded: z.boolean().optional(),
      message: z.string().optional(),
    })
    .optional(),
  notes: z.array(z.string()).default([]),
  preparedAt: z.string(),
});
export type ContextReceipt = z.infer<typeof ContextReceiptSchema>;

/** Compact finding summary retained on a specialist run (enterprise audit). */
export const SpecialistFindingSummarySchema = z.object({
  title: z.string(),
  severity: z.string().optional(),
  /** Product (evidence-derived) confidence */
  confidence: z.number().min(0).max(1).optional(),
  modelConfidence: z.number().min(0).max(1).optional(),
  tokenConfidence: z.number().min(0).max(1).optional(),
  path: z.string().optional(),
  startLine: z.number().optional(),
  category: z.string().optional(),
});
export type SpecialistFindingSummary = z.infer<typeof SpecialistFindingSummarySchema>;

export const SpecialistRunSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  unitLabel: z.string().optional(),
  role: z.string(),
  runner: z.enum(["simple", "deepagents", "unknown"]).default("unknown"),
  model: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  status: z.enum(["ok", "error", "truncated", "skipped"]).default("ok"),
  findingCount: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  responseSha256: z.string().optional(),
  responseExcerpt: z.string().max(500).optional(),
  promptChars: z.number().int().nonnegative().optional(),
  completionChars: z.number().int().nonnegative().optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
  /** Paths / scope this subagent was asked to review */
  pathsReviewed: z.array(z.string()).optional(),
  /** Files included in packed context when available */
  filesReviewed: z.array(z.string()).optional(),
  /** Average confidence of findings this run produced */
  avgConfidence: z.number().min(0).max(1).optional(),
  /** Per-finding titles/severities/confidence (capped) for enterprise audit */
  findingsSummary: z.array(SpecialistFindingSummarySchema).optional(),
  /** Graph / tool grounding used */
  usedGraph: z.boolean().optional(),
  stepIndex: z.number().int().nonnegative().optional(),
  /** True when STEW_SPECIALIST_TIMEOUT_MS (or equivalent) aborted this run. */
  timedOut: z.boolean().optional(),
  /** Configured timeout budget that fired (ms). */
  timeoutMs: z.number().int().nonnegative().optional(),
});
export type SpecialistRun = z.infer<typeof SpecialistRunSchema>;

export const ToolTraceEntrySchema = z.object({
  id: z.string(),
  unitId: z.string().optional(),
  role: z.string().optional(),
  tool: z.enum([
    "graph_status",
    "graph_query",
    "graph_rebuild",
    "sandbox_exec",
    "sandbox_read",
    "other",
  ]),
  name: z.string(),
  summary: z.string(),
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
  detail: z.record(z.unknown()).optional(),
  ts: z.string(),
});
export type ToolTraceEntry = z.infer<typeof ToolTraceEntrySchema>;

export const ToolTraceSummarySchema = z.object({
  total: z.number().int().nonnegative().default(0),
  byTool: z.record(z.number()).default({}),
  errors: z.number().int().nonnegative().default(0),
  entries: z.array(ToolTraceEntrySchema).default([]),
  truncated: z.boolean().default(false),
});
export type ToolTraceSummary = z.infer<typeof ToolTraceSummarySchema>;

export const JudgeNoiseSummarySchema = z.object({
  inputCount: z.number().int().nonnegative(),
  outputCount: z.number().int().nonnegative(),
  dropped: z
    .array(z.object({ title: z.string(), reason: z.string() }))
    .default([]),
  severityFloor: z.string().optional(),
  commentCap: z.number().optional(),
  discourse: z
    .object({
      ran: z.boolean(),
      passACount: z.number().optional(),
      passBCount: z.number().optional(),
      notes: z.number().optional(),
      surfacedCount: z.number().optional(),
      droppedByChallenge: z.number().optional(),
    })
    .optional(),
  sastCount: z.number().int().nonnegative().optional(),
});
export type JudgeNoiseSummary = z.infer<typeof JudgeNoiseSummarySchema>;

export const ZeroFindingsRationaleSchema = z.object({
  reason: z.enum([
    "empty_diff",
    "incremental_no_changes",
    "all_units_clean",
    "all_candidates_dropped",
    "units_failed",
    "context_missing",
    "specialist_timeouts",
    "unknown",
  ]),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
});
export type ZeroFindingsRationale = z.infer<typeof ZeroFindingsRationaleSchema>;

/**
 * Explicit incomplete-review signal when one or more specialists timed out.
 * Prevents false confidence that a role "looked and found nothing."
 */
export const CoverageGapsSchema = z.object({
  specialistTimeouts: z.number().int().nonnegative().default(0),
  /** Roles that timed out (may repeat across units). */
  roles: z.array(z.string()).default([]),
  /** Human unit labels for context */
  unitLabels: z.array(z.string()).default([]),
  message: z.string(),
  /** True when security (or other high-trust) roles timed out */
  criticalRolesAffected: z.boolean().default(false),
});
export type CoverageGaps = z.infer<typeof CoverageGapsSchema>;

/** One pipeline stage wall-clock (policy → publish). */
export const StageTimingSchema = z.object({
  stage: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
export type StageTiming = z.infer<typeof StageTimingSchema>;

/** One review unit wall-clock (file batch). */
export const UnitTimingSchema = z.object({
  unitId: z.string(),
  unitLabel: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  status: z.string().optional(),
  roles: z.array(z.string()).optional(),
  /** Max parallel specialist duration for this unit (when known). */
  specialistMaxMs: z.number().int().nonnegative().optional(),
  /** Sum of specialist run durations (overlap ignored — use for cost, not wall). */
  specialistSumMs: z.number().int().nonnegative().optional(),
  findingCount: z.number().int().nonnegative().optional(),
});
export type UnitTiming = z.infer<typeof UnitTimingSchema>;

/** Rollups for bottleneck analysis without scanning full arrays. */
export const TimingsSummarySchema = z.object({
  longestStage: z.string().optional(),
  longestStageMs: z.number().int().nonnegative().optional(),
  longestUnitId: z.string().optional(),
  longestUnitMs: z.number().int().nonnegative().optional(),
  longestSpecialistRole: z.string().optional(),
  longestSpecialistMs: z.number().int().nonnegative().optional(),
  /** Wall times by stage name (closed stages only). */
  byStageMs: z.record(z.number()).default({}),
  specialistsMs: z.number().int().nonnegative().optional(),
  verificationMs: z.number().int().nonnegative().optional(),
  discourseMs: z.number().int().nonnegative().optional(),
  judgeMs: z.number().int().nonnegative().optional(),
  proveMs: z.number().int().nonnegative().optional(),
  publishMs: z.number().int().nonnegative().optional(),
  graphMs: z.number().int().nonnegative().optional(),
  planningMs: z.number().int().nonnegative().optional(),
  policyMs: z.number().int().nonnegative().optional(),
  specialistRunsCount: z.number().int().nonnegative().optional(),
  specialistRunsSumMs: z.number().int().nonnegative().optional(),
  specialistRunsMaxMs: z.number().int().nonnegative().optional(),
  toolsCount: z.number().int().nonnegative().optional(),
  toolsSumMs: z.number().int().nonnegative().optional(),
  unitCount: z.number().int().nonnegative().optional(),
});
export type TimingsSummary = z.infer<typeof TimingsSummarySchema>;

/**
 * Durable session timing ledger for bottleneck analysis.
 * Prefer this over replaying event logs.
 */
export const SessionTimingsSchema = z.object({
  sessionStartedAt: z.string(),
  sessionEndedAt: z.string().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  stages: z.array(StageTimingSchema).default([]),
  units: z.array(UnitTimingSchema).default([]),
  summary: TimingsSummarySchema.optional(),
});
export type SessionTimings = z.infer<typeof SessionTimingsSchema>;

export const SessionAuditSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  context: ContextReceiptSchema,
  specialistRuns: z.array(SpecialistRunSchema).default([]),
  tools: ToolTraceSummarySchema.default({
    total: 0,
    byTool: {},
    entries: [],
    errors: 0,
    truncated: false,
  }),
  judge: JudgeNoiseSummarySchema.optional(),
  zeroFindings: ZeroFindingsRationaleSchema.optional(),
  /**
   * Incomplete specialist coverage (timeouts). Always set when any role hits
   * STEW_SPECIALIST_TIMEOUT_MS — even if other findings exist.
   */
  coverageGaps: CoverageGapsSchema.optional(),
  heal: z
    .object({
      recoveredUnits: z.number().optional(),
      failedUnits: z.number().optional(),
      failureCount: z.number().optional(),
    })
    .optional(),
  /** Stage / unit / specialist timing for bottleneck analysis. */
  timings: SessionTimingsSchema.optional(),
  completedAt: z.string().optional(),
});
export type SessionAudit = z.infer<typeof SessionAuditSchema>;
