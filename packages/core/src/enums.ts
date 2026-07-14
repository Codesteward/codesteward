import { z } from "zod";

export const ReviewModeSchema = z.enum(["gate", "stewardship"]);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const SeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
  "nit",
]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 100,
  high: 80,
  medium: 60,
  low: 40,
  info: 20,
  nit: 10,
};

export const CategorySchema = z.enum([
  "correctness",
  "security",
  "performance",
  "testing",
  "maintainability",
  "style",
  "docs",
  "rules",
  "requirements",
  "dependency",
  "reliability",
  "other",
]);
export type Category = z.infer<typeof CategorySchema>;

export const RiskTierSchema = z.enum([
  "trivial",
  "lite",
  "full",
  "security",
  "thorough",
]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const SessionStageSchema = z.enum([
  "queued",
  "policy",
  "graph",
  "planning",
  "specialists",
  "verification",
  "discourse",
  "judge",
  "prove",
  "publish",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStage = z.infer<typeof SessionStageSchema>;

export const SessionStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  /** Some units failed after max heal retries; partial findings still published. */
  "completed_with_errors",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Self-heal strategies applied when a review unit crashes. */
export const HealStrategySchema = z.enum([
  "retry_fresh_context",
  "fallback_simple_runner",
  "split_unit",
  "skip_with_gap_note",
]);
export type HealStrategy = z.infer<typeof HealStrategySchema>;

export const FindingStatusSchema = z.enum([
  "open",
  "acknowledged",
  "fixed",
  "dismissed",
  "wontfix",
  "false_positive",
  "reopened",
  "suppressed",
]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const AgentRoleSchema = z.enum([
  "coordinator",
  "generalist",
  "correctness",
  "security",
  "performance",
  "testing",
  "rules",
  "requirements",
  "discourse",
  "evidence",
  "prove",
  "judge",
  "verifier",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ModelProviderSchema = z.enum([
  "openai",
  "anthropic",
  "xai",
  "openai-compatible",
  "litellm",
  "openrouter",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const TriggerSchema = z.enum([
  "webhook",
  "cli",
  "api",
  "action",
  "mcp",
  "schedule",
  "manual",
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const ReviewDepthSchema = z.enum(["fast", "normal", "deep", "thorough"]);
export type ReviewDepth = z.infer<typeof ReviewDepthSchema>;

export const CrossRepoEdgeTypeSchema = z.enum([
  "depends_on_api",
  "publishes_package",
  "shares_proto",
  "deploys_with",
  "imports",
  "custom",
]);
export type CrossRepoEdgeType = z.infer<typeof CrossRepoEdgeTypeSchema>;
