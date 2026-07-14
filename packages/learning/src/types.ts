import { z } from "zod";

export const ReactionKindSchema = z.enum(["up", "down", "👍", "👎"]);
export type ReactionKind = z.infer<typeof ReactionKindSchema>;

export const FindingReactionSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  fingerprint: z.string().optional(),
  orgId: z.string().default("local"),
  repoId: z.string().optional(),
  userId: z.string().optional(),
  reaction: z.enum(["up", "down"]),
  note: z.string().optional(),
  createdAt: z.string(),
});
export type FindingReaction = z.infer<typeof FindingReactionSchema>;

export const MemoryKindSchema = z.enum([
  "steward_rule",
  "dismissal",
  "false_positive",
  "preference",
  "pattern",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const OrgMemorySchema = z.object({
  id: z.string(),
  orgId: z.string().default("local"),
  repoId: z.string().optional(),
  kind: MemoryKindSchema,
  /** Negative memories suppress similar findings in judge. */
  polarity: z.enum(["positive", "negative"]).default("negative"),
  fingerprint: z.string().optional(),
  pattern: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  source: z.string().optional(),
  weight: z.number().min(0).max(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrgMemory = z.infer<typeof OrgMemorySchema>;

export const RepoReviewStateSchema = z.object({
  repoId: z.string(),
  orgId: z.string().default("local"),
  /** SHA of the last successfully reviewed head (incremental gate). */
  lastReviewedSha: z.string().optional(),
  lastSessionId: z.string().optional(),
  lastPrNumber: z.number().optional(),
  updatedAt: z.string(),
});
export type RepoReviewState = z.infer<typeof RepoReviewStateSchema>;
