import { z } from "zod";
import {
  HealStrategySchema,
  ReviewDepthSchema,
  ReviewModeSchema,
  RiskTierSchema,
  SessionStageSchema,
  SessionStatusSchema,
  TriggerSchema,
} from "./enums.js";
import { SessionAuditSchema } from "./session-audit.js";

export const ReviewUnitSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum([
    "file_batch",
    "package",
    "hotspot",
    "rule_shard",
    "symbol_cluster",
    "path",
  ]),
  label: z.string(),
  paths: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  status: z
    .enum(["pending", "running", "completed", "failed", "skipped"])
    .default("pending"),
  assignedRoles: z.array(z.string()).default([]),
  workerId: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  /** Unit-level heal attempts so far (persisted in checkpoint). */
  attempts: z.number().int().nonnegative().optional(),
  /** Last heal strategy applied to this unit. */
  lastStrategy: HealStrategySchema.optional(),
  /** True when unit succeeded after at least one heal attempt. */
  healed: z.boolean().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type ReviewUnit = z.infer<typeof ReviewUnitSchema>;

/** Durable unit-crash log for self-heal diagnostics / API. */
export const AgentFailureLogEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  unitId: z.string(),
  unitLabel: z.string().optional(),
  attempt: z.number().int().nonnegative(),
  strategy: HealStrategySchema.optional(),
  error: z.string(),
  recovered: z.boolean().default(false),
  ts: z.string(),
});
export type AgentFailureLogEntry = z.infer<typeof AgentFailureLogEntrySchema>;

/** Lightweight session checkpoint summary (full payload in checkpoint store). */
export const SessionCheckpointSummarySchema = z.object({
  stage: SessionStageSchema,
  completedUnitIds: z.array(z.string()).default([]),
  failedUnitIds: z.array(z.string()).default([]),
  skippedUnitIds: z.array(z.string()).default([]),
  lastUnitId: z.string().optional(),
  partialFindingCount: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
});
export type SessionCheckpointSummary = z.infer<typeof SessionCheckpointSummarySchema>;

export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ReviewSessionSchema = z.object({
  id: z.string(),
  orgId: z.string().default("local"),
  tenantId: z.string().default("local"),
  repoId: z.string(),
  repoPath: z.string().optional(),
  mode: ReviewModeSchema,
  trigger: TriggerSchema.default("api"),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  scmProvider: z.string().optional(),
  scmFullName: z.string().optional(),
  riskTier: RiskTierSchema.default("full"),
  depth: ReviewDepthSchema.default("normal"),
  status: SessionStatusSchema.default("pending"),
  stage: SessionStageSchema.default("queued"),
  verdict: z.enum(["approve", "comment", "request_changes", "unknown"]).optional(),
  units: z.array(ReviewUnitSchema).default([]),
  tokenUsage: TokenUsageSchema.default({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }),
  policySnapshotId: z.string().optional(),
  parentSessionId: z.string().optional(),
  error: z.string().optional(),
  /** Last successful unit checkpoint summary for resume. */
  checkpoint: SessionCheckpointSummarySchema.optional(),
  /** Agent unit failures (mirrors checkpoint agent_failure_log). */
  failureLog: z.array(AgentFailureLogEntrySchema).optional(),
  /** Session-level resume / global heal attempts. */
  resumeAttempts: z.number().int().nonnegative().optional(),
  /**
   * Review-run forensics: code provenance, specialist runs, tool summary,
   * zero-findings rationale. Separate from org IAM audit_events.
   */
  audit: SessionAuditSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});
export type ReviewSession = z.infer<typeof ReviewSessionSchema>;

export const CreateSessionRequestSchema = z
  .object({
    mode: ReviewModeSchema,
    repoId: z.string(),
    tenantId: z.string().optional(),
    orgId: z.string().optional(),
    repoPath: z.string().optional(),
    baseSha: z.string().optional(),
    headSha: z.string().optional(),
    baseBranch: z.string().optional(),
    headBranch: z.string().optional(),
    prNumber: z.number().int().positive().optional(),
    scmProvider: z.string().optional(),
    scmFullName: z.string().optional(),
    riskTier: RiskTierSchema.optional(),
    depth: ReviewDepthSchema.optional(),
    trigger: TriggerSchema.optional(),
    paths: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    // Hard mode separation:
    // - gate = PR merge check only (requires prNumber; base/head come from the PR)
    // - stewardship = single branch / repo audit (no PR; no branch-range compare)
    if (data.mode === "gate") {
      if (data.prNumber == null || data.prNumber < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prNumber"],
          message:
            "Gate requires prNumber — it reviews a pull-request diff. To audit a branch without a PR, use mode=stewardship.",
        });
      }
    }
    if (data.mode === "stewardship") {
      if (data.prNumber != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prNumber"],
          message:
            "Stewardship does not accept prNumber. To review a PR (or compare two branches), open a PR and use gate mode.",
        });
      }
    }
  });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
