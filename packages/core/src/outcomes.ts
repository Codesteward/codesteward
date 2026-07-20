/**
 * Review outcome types — automatic / indirect eval from human + merge signals.
 */
import { z } from "zod";

/** Per-finding disposition inferred at merge or from human action. */
export const FindingOutcomeKindSchema = z.enum([
  /** User or merge confirmed the issue was fixed / suggestion applied */
  "accepted",
  /** Explicit thumbs-up */
  "thumbs_up",
  /** Auto-fixed on re-review or merge path change */
  "fixed",
  /** Still open when PR merged — ignored */
  "unaddressed_at_merge",
  /** Marked false_positive / downvoted */
  "false_positive",
  /** Explicit dismiss / wontfix */
  "dismissed",
  /** User fixed something in a path we never flagged (candidate FN) */
  "agent_miss_candidate",
  /** Gate approved but critical finding left open */
  "gate_regret_miss",
  /** Gate blocked but only noise was raised */
  "gate_regret_noise",
  /** GitHub review thread marked resolved (soft accept of our comment) */
  "thread_resolved",
  /** GitHub review thread reopened */
  "thread_unresolved",
  /** External security advisory signal (FN / coverage candidate) */
  "security_advisory",
]);
export type FindingOutcomeKind = z.infer<typeof FindingOutcomeKindSchema>;

export const FindingOutcomeSchema = z.object({
  id: z.string(),
  orgId: z.string().default("local"),
  repoId: z.string(),
  prNumber: z.number().optional(),
  prKey: z.string().optional(),
  findingId: z.string().optional(),
  fingerprint: z.string().optional(),
  kind: FindingOutcomeKindSchema,
  sessionId: z.string().optional(),
  mergeSha: z.string().optional(),
  /** 0–1 heuristic confidence for automatic labels */
  confidence: z.number().min(0).max(1).default(1),
  note: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type FindingOutcome = z.infer<typeof FindingOutcomeSchema>;

export const PrOutcomeSchema = z.object({
  id: z.string(),
  orgId: z.string().default("local"),
  repoId: z.string(),
  prNumber: z.number(),
  prKey: z.string(),
  mergeSha: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  sessionIds: z.array(z.string()).default([]),
  /** Last gate verdict if known */
  gateVerdict: z.string().optional(),
  counts: z.object({
    posted: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    fixed: z.number().int().nonnegative(),
    thumbsUp: z.number().int().nonnegative(),
    falsePositive: z.number().int().nonnegative(),
    dismissed: z.number().int().nonnegative(),
    unaddressedAtMerge: z.number().int().nonnegative(),
    agentMissCandidates: z.number().int().nonnegative(),
  }),
  /** Split rates 0–1 */
  rates: z.object({
    fixAcceptRate: z.number().nullable(),
    noiseRate: z.number().nullable(),
    ignoreAtMergeRate: z.number().nullable(),
  }),
  pathsChanged: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type PrOutcome = z.infer<typeof PrOutcomeSchema>;

/** Eval fixture case derived from production outcomes. */
export const OutcomeEvalCaseSchema = z.object({
  id: z.string(),
  source: z.enum(["reaction", "status", "merge", "fn_candidate", "manual"]),
  expected: z.object({
    should_fire: z.boolean(),
    line_correct: z.boolean().optional(),
  }),
  predicted: z.object({
    fired: z.boolean(),
    line_correct: z.boolean().optional(),
  }),
  fingerprint: z.string().optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  severity: z.string().optional(),
  confidence: z.number().optional(),
  outcomeKind: FindingOutcomeKindSchema.optional(),
  orgId: z.string().optional(),
  repoId: z.string().optional(),
  prNumber: z.number().optional(),
});
export type OutcomeEvalCase = z.infer<typeof OutcomeEvalCaseSchema>;
