import { z } from "zod";
import {
  AgentRoleSchema,
  CategorySchema,
  FindingStatusSchema,
  SeveritySchema,
} from "./enums.js";

export const EvidenceSchema = z.object({
  id: z.string(),
  type: z.enum([
    "graph",
    "tool",
    "prove",
    "sast",
    "discourse",
    "diff",
    "policy",
    /** Structured specialist rationale (not raw multi-turn chat). */
    "reasoning",
  ]),
  summary: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  artifactUri: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  orgId: z.string().default("local"),
  repoId: z.string(),
  tenantId: z.string().default("local"),
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbolId: z.string().optional(),
  title: z.string().min(1),
  body: z.string().default(""),
  category: CategorySchema,
  severity: SeveritySchema,
  /**
   * Product confidence (0–1) — evidence-derived, used for gates/audit/UI primary score.
   * Not the model’s self-report.
   */
  confidence: z.number().min(0).max(1).default(0.7),
  /**
   * Specialist self-reported confidence from JSON (0–1). Diagnostic only; never sole gate input.
   */
  modelConfidence: z.number().min(0).max(1).optional(),
  /**
   * Mean token probability from provider logprobs when available (0–1). Optional; not all providers expose it.
   */
  tokenConfidence: z.number().min(0).max(1).optional(),
  fingerprint: z.string(),
  status: FindingStatusSchema.default("open"),
  agents: z.array(AgentRoleSchema).default([]),
  ruleIds: z.array(z.string()).default([]),
  /** Plain-language remediation guidance (always optional). */
  suggestion: z.string().optional(),
  /**
   * Concrete code that would fix the issue (replacement snippet or small patch body).
   * Populated when org runtime STEW_SUGGESTED_CODE_FIXES=1.
   */
  suggestedFix: z.string().optional(),
  /** Optional excerpt of current code for grounding / line relocate. */
  existingCode: z.string().optional(),
  /**
   * Specialist rationale: why the issue is real, what was checked, and key caveats.
   * Forwarded to the senior verifier (not raw multi-turn chat transcripts).
   */
  reasoning: z.string().optional(),
  evidence: z.array(EvidenceSchema).default([]),
  verification: z
    .object({
      verdict: z.enum(["keep", "drop", "downgrade", "upgrade"]).optional(),
      reason: z.string().optional(),
      verifiedBy: z.string().optional(),
    })
    .optional(),
  scmCommentId: z.string().optional(),
  crossRepoOriginRepoId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingCandidateSchema = FindingSchema.omit({
  id: true,
  fingerprint: true,
  status: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  sessionId: true,
  orgId: true,
  repoId: true,
  tenantId: true,
  evidence: true,
  agents: true,
  ruleIds: true,
  tags: true,
  confidence: true,
  modelConfidence: true,
  tokenConfidence: true,
  body: true,
}).extend({
  title: z.string().min(1),
  category: CategorySchema,
  severity: SeveritySchema,
  path: z.string(),
});
export type FindingCandidate = z.infer<typeof FindingCandidateSchema>;
