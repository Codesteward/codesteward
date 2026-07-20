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

/** Worker job kinds — review runs the agent pipeline; pr_outcome scores merge results. */
export const JobKindSchema = z.enum(["review", "pr_outcome"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const ReviewJobSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  mode: ReviewModeSchema,
  /**
   * `review` (default) — full agentic review.
   * `pr_outcome` — post-merge outcome analysis (no specialists).
   * Omitted on legacy jobs → treated as review.
   */
  jobKind: JobKindSchema.optional(),
  tenantId: z.string().default("local"),
  /**
   * Product organization id (multi-tenant). Used for workspace layout
   * `{STEW_WORKSPACE_DIR}/{orgId}/{sessionId}` and optional worker claim affinity
   * (`STEW_WORKER_ORG_IDS`). Distinct from graph tenantId when SaaS uses both.
   */
  orgId: z.string().optional(),
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
  /**
   * Opaque job metadata (webhook triage focus, PR body snippet, merge outcome, etc.).
   * Not used for scheduling — free-form context for the orchestrator / outcome job.
   */
  metadata: z.record(z.unknown()).optional(),
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
