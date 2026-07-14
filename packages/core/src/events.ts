import { z } from "zod";
import {
  AgentRoleSchema,
  HealStrategySchema,
  SessionStageSchema,
  SeveritySchema,
} from "./enums.js";
import { FindingSchema } from "./finding.js";

/** WebSocket / SSE progress events for live session UI. */
export const ProgressEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stage"),
    sessionId: z.string(),
    stage: SessionStageSchema,
    message: z.string().optional(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal("unit"),
    sessionId: z.string(),
    unitId: z.string(),
    label: z.string(),
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
    ts: z.string(),
  }),
  z.object({
    type: z.literal("agent"),
    sessionId: z.string(),
    role: AgentRoleSchema,
    unitId: z.string().optional(),
    status: z.enum(["started", "tool", "completed", "failed"]),
    message: z.string().optional(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal("finding"),
    sessionId: z.string(),
    finding: FindingSchema,
    ts: z.string(),
  }),
  z.object({
    type: z.literal("token_usage"),
    sessionId: z.string(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number().optional(),
    costEstimated: z.boolean().optional(),
    calls: z.number().optional(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal("log"),
    sessionId: z.string(),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
    ts: z.string(),
  }),
  /** Self-heal strategy selected for a failed unit. */
  z.object({
    type: z.literal("healing"),
    sessionId: z.string(),
    unitId: z.string().optional(),
    strategy: HealStrategySchema,
    attempt: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
    ts: z.string(),
  }),
  /** Unit retry scheduled (includes backoff). */
  z.object({
    type: z.literal("retry"),
    sessionId: z.string(),
    unitId: z.string(),
    label: z.string().optional(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    strategy: HealStrategySchema.optional(),
    message: z.string().optional(),
    ts: z.string(),
  }),
  /** Unit succeeded after heal strategy. */
  z.object({
    type: z.literal("unit_recovered"),
    sessionId: z.string(),
    unitId: z.string(),
    label: z.string(),
    strategy: HealStrategySchema,
    attempt: z.number().int().nonnegative(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal("completed"),
    sessionId: z.string(),
    status: z.enum(["completed", "completed_with_errors", "failed", "cancelled"]),
    findingCount: z.number().int().nonnegative(),
    severityCounts: z.record(SeveritySchema, z.number()).optional(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    sessionId: z.string(),
    message: z.string(),
    retriable: z.boolean().default(false),
    ts: z.string(),
  }),
  /** Code provenance bound for this run (clone / mount / scm_diff). */
  z.object({
    type: z.literal("audit_context"),
    sessionId: z.string(),
    source: z.string(),
    verified: z.boolean().optional(),
    pathCount: z.number().optional(),
    fileCount: z.number().optional(),
    tokenBudget: z.number().optional(),
    message: z.string().optional(),
    ts: z.string(),
  }),
  /** Specialist started or finished. */
  z.object({
    type: z.literal("specialist_run"),
    sessionId: z.string(),
    unitId: z.string(),
    role: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    model: z.string().optional(),
    findingCount: z.number().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
    runner: z.string().optional(),
    ts: z.string(),
  }),
  /** Compact end-of-run audit summary. */
  z.object({
    type: z.literal("audit_summary"),
    sessionId: z.string(),
    source: z.string().optional(),
    specialistRuns: z.number().optional(),
    toolCalls: z.number().optional(),
    zeroFindingsReason: z.string().optional(),
    message: z.string().optional(),
    ts: z.string(),
  }),
  /** Human-readable session report ready for UI / export. */
  z.object({
    type: z.literal("session_report"),
    sessionId: z.string(),
    headline: z.string().optional(),
    findingCount: z.number().optional(),
    verdict: z.string().optional(),
    llmNarrative: z.boolean().optional(),
    ts: z.string(),
  }),
]);
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function stageEvent(
  sessionId: string,
  stage: z.infer<typeof SessionStageSchema>,
  message?: string,
): ProgressEvent {
  return { type: "stage", sessionId, stage, message, ts: nowIso() };
}
