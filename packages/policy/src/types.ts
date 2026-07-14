import { z } from "zod";
import { SeveritySchema } from "@codesteward/core";

export const PathRuleSchema = z.object({
  id: z.string(),
  pathScope: z.string(),
  title: z.string().optional(),
  guidance: z.string(),
  severity: SeveritySchema.optional(),
  sourcePath: z.string(),
});
export type PathRule = z.infer<typeof PathRuleSchema>;

/**
 * Effective policy resolved from STEWARD.md + .codesteward/rules.
 * IMPORTANT: In production, load only from the **base branch** checkout
 * to prevent PR authors from relaxing gates on the PR branch.
 */
export const PolicySchema = z.object({
  severityFloor: SeveritySchema.default("low"),
  nitCap: z.number().int().nonnegative().default(5),
  maxFindings: z.number().int().positive().default(50),
  skipGlobs: z.array(z.string()).default([
    "**/node_modules/**",
    "**/dist/**",
    "**/*.lock",
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/vendor/**",
    "**/.git/**",
  ]),
  includeGlobs: z.array(z.string()).default(["**/*"]),
  verificationBar: z
    .enum(["off", "sample", "full"])
    .default("full"),
  requireGraph: z.boolean().default(false),
  /**
   * Severities that fail the merge gate (Check Run + REQUEST_CHANGES).
   * Default: critical + high. Empty array = never block on severity alone.
   */
  blockSeverities: z.array(SeveritySchema).default(["critical", "high"]),
  /**
   * enforce: fail Check Run / request changes on block severities.
   * advisory: post comments only; Check Run stays neutral/success with notes.
   */
  gateMode: z.enum(["enforce", "advisory"]).default("enforce"),
  /** When true, incomplete graph degrades thorough/security to incomplete (fail check in enforce). */
  requireGraphForThorough: z.boolean().default(true),
  proveOnSeverity: SeveritySchema.optional(),
  focus: z.array(z.string()).default([]),
  ignoreRules: z.array(z.string()).default([]),
  customSections: z.record(z.string()).default({}),
  pathRules: z.array(PathRuleSchema).default([]),
  rawStewardMd: z.string().optional(),
  source: z.enum(["default", "steward.md", "merged"]).default("default"),
});
export type Policy = z.infer<typeof PolicySchema>;
