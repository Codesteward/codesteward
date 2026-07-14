import { z } from "zod";
import { CrossRepoEdgeTypeSchema } from "./enums.js";

export const CrossRepoPathFilterSchema = z.object({
  from: z.array(z.string()).default([]),
  to: z.array(z.string()).default([]),
});
export type CrossRepoPathFilter = z.infer<typeof CrossRepoPathFilterSchema>;

export const CrossRepoLinkSchema = z.object({
  id: z.string(),
  orgId: z.string().default("local"),
  fromRepoId: z.string(),
  toRepoId: z.string(),
  edgeType: CrossRepoEdgeTypeSchema.default("depends_on_api"),
  /** Optional path globs restricting when fan-out applies */
  pathFilters: CrossRepoPathFilterSchema.default({ from: [], to: [] }),
  /** Local filesystem roots for linked repos (demo / self-host) */
  fromRepoPath: z.string().optional(),
  toRepoPath: z.string().optional(),
  hints: z
    .object({
      packageName: z.string().optional(),
      apiPrefix: z.string().optional(),
      protoPath: z.string().optional(),
      notes: z.string().optional(),
    })
    .default({}),
  maxDepth: z.number().int().positive().default(2),
  /** Soft token budget for fan-out context from this edge */
  tokenBudget: z.number().int().positive().default(50_000),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CrossRepoLink = z.infer<typeof CrossRepoLinkSchema>;

export const CrossRepoBudgetSchema = z.object({
  maxRepos: z.number().int().positive().default(5),
  maxDepth: z.number().int().positive().default(2),
  maxExtraUnits: z.number().int().positive().default(20),
  maxTokens: z.number().int().positive().default(200_000),
});
export type CrossRepoBudget = z.infer<typeof CrossRepoBudgetSchema>;

export function defaultCrossRepoBudget(): CrossRepoBudget {
  return CrossRepoBudgetSchema.parse({
    maxRepos: Number(process.env.CROSS_REPO_MAX_REPOS ?? 5),
    maxDepth: Number(process.env.CROSS_REPO_MAX_DEPTH ?? 2),
    maxExtraUnits: Number(process.env.CROSS_REPO_MAX_UNITS ?? 20),
    maxTokens: Number(process.env.CROSS_REPO_MAX_TOKENS ?? 200_000),
  });
}
