import { z } from "zod";
import {
  AgentRoleSchema,
  CategorySchema,
  FindingStatusSchema,
  SeveritySchema,
} from "./enums.js";

export const EvidenceSchema = z.object({
  id: z.string(),
  type: z.enum(["graph", "tool", "prove", "sast", "discourse", "diff", "policy"]),
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
  confidence: z.number().min(0).max(1).default(0.7),
  fingerprint: z.string(),
  status: FindingStatusSchema.default("open"),
  agents: z.array(AgentRoleSchema).default([]),
  ruleIds: z.array(z.string()).default([]),
  suggestion: z.string().optional(),
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
  body: true,
}).extend({
  title: z.string().min(1),
  category: CategorySchema,
  severity: SeveritySchema,
  path: z.string(),
});
export type FindingCandidate = z.infer<typeof FindingCandidateSchema>;
