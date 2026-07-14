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

/**
 * Where a learning applies:
 * - org  — every repo in the org
 * - repo — one repository
 * - pr   — one pull/merge request (e.g. "defer this fix to a follow-up PR")
 */
export const LearningScopeSchema = z.enum(["org", "repo", "pr"]);
export type LearningScope = z.infer<typeof LearningScopeSchema>;

export const OrgMemorySchema = z.object({
  id: z.string(),
  orgId: z.string().default("local"),
  /**
   * Applicability scope. Inferred from repoId/prKey when missing (legacy rows).
   */
  scope: LearningScopeSchema.default("org"),
  repoId: z.string().optional(),
  /**
   * Stable PR key: `{repoId}#{prNumber}` e.g. `acme/api#42`.
   * Required when scope is `pr`.
   */
  prKey: z.string().optional(),
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

/** Build a stable PR-scoped memory key. */
export function makePrKey(repoId: string, prNumber: number | string): string {
  return `${repoId}#${prNumber}`;
}

/** Infer scope for legacy rows that predate the scope field. */
export function inferMemoryScope(m: {
  scope?: LearningScope | string | null;
  repoId?: string | null;
  prKey?: string | null;
}): LearningScope {
  if (m.scope === "org" || m.scope === "repo" || m.scope === "pr") return m.scope;
  if (m.prKey) return "pr";
  if (m.repoId) return "repo";
  return "org";
}

/**
 * Normalize scope + identifiers when creating or moving a memory.
 * Throws on invalid combinations.
 */
export function normalizeMemoryScopeFields(input: {
  scope?: LearningScope;
  repoId?: string | null;
  prKey?: string | null;
  prNumber?: number | null;
}): { scope: LearningScope; repoId?: string; prKey?: string } {
  let scope = input.scope;
  let repoId = input.repoId?.trim() || undefined;
  let prKey = input.prKey?.trim() || undefined;

  if (!scope) {
    scope = inferMemoryScope({ repoId, prKey });
  }

  if (scope === "org") {
    return { scope: "org" };
  }

  if (scope === "repo") {
    if (!repoId) {
      throw new Error("repo-scoped learning requires repoId");
    }
    return { scope: "repo", repoId };
  }

  // pr
  if (!repoId && prKey?.includes("#")) {
    repoId = prKey.slice(0, prKey.lastIndexOf("#"));
  }
  if (!prKey && repoId && input.prNumber != null) {
    prKey = makePrKey(repoId, input.prNumber);
  }
  if (!repoId || !prKey) {
    throw new Error("pr-scoped learning requires repoId and prKey (or prNumber)");
  }
  return { scope: "pr", repoId, prKey };
}
