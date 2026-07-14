import { z } from "zod";
import { ReviewModeSchema, RiskTierSchema, ReviewDepthSchema } from "./enums.js";
import { CrossRepoBudgetSchema } from "./cross-repo.js";

export const ScmProviderNameSchema = z.enum([
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
  "gitea",
]);

export const ReviewJobSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  mode: ReviewModeSchema,
  tenantId: z.string().default("local"),
  repoId: z.string(),
  repoPath: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  baseBranch: z.string().optional(),
  prNumber: z.number().optional(),
  riskTier: RiskTierSchema.default("full"),
  depth: ReviewDepthSchema.default("normal"),
  paths: z.array(z.string()).optional(),
  maxConcurrent: z.number().int().positive().optional(),
  enqueuedAt: z.string(),
  attempts: z.number().int().nonnegative().default(0),
  /** Enable cross-repo fan-out */
  crossRepo: z.boolean().optional().default(true),
  crossRepoBudget: CrossRepoBudgetSchema.optional(),
  /** SCM publish after gate */
  scm: z
    .object({
      provider: ScmProviderNameSchema.default("github"),
      owner: z.string(),
      repo: z.string(),
      prNumber: z.number(),
      publish: z.boolean().default(true),
    })
    .optional(),
  /** Webhook delivery id for idempotency */
  webhookDeliveryId: z.string().optional(),
  installationId: z.string().optional(),
  /** Force full review even if last_reviewed_sha is set */
  fullReview: z.boolean().optional(),
  /** Diff patches for packing (path → patch text) */
  patches: z
    .array(
      z.object({
        path: z.string(),
        status: z.enum(["added", "modified", "removed", "renamed"]).optional(),
        patch: z.string().optional(),
        additions: z.number().optional(),
        deletions: z.number().optional(),
        previousPath: z.string().optional(),
      }),
    )
    .optional(),
});
export type ReviewJob = z.infer<typeof ReviewJobSchema>;
