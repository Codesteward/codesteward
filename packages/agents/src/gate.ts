import { SEVERITY_RANK, type Severity } from "@codesteward/core";
import type { Policy } from "@codesteward/policy";

export type GateVerdict = "approve" | "comment" | "request_changes" | "unknown";
export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "action_required";

export interface GateOutcome {
  verdict: GateVerdict;
  /** PR review event */
  reviewEvent: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  checkConclusion: CheckConclusion;
  checkTitle: string;
  checkSummary: string;
  blockedBy: Array<{ severity: string; count: number }>;
  advisory: boolean;
  reasons: string[];
}

/**
 * Policy-driven merge gate: maps findings + session health to PR review + Check Run.
 */
export function evaluateGate(input: {
  policy: Policy;
  findings: Array<{ severity: string }>;
  sessionStatus: "completed" | "completed_with_errors" | "failed";
  graphDegraded?: boolean;
  riskTier?: string;
  depth?: string;
  findingCount: number;
}): GateOutcome {
  const advisory = input.policy.gateMode === "advisory";
  const reasons: string[] = [];
  const blockSet = new Set(
    (input.policy.blockSeverities?.length
      ? input.policy.blockSeverities
      : (["critical", "high"] as Severity[])
    ).map((s) => s.toLowerCase()),
  );

  const counts: Record<string, number> = {};
  for (const f of input.findings) {
    const s = String(f.severity).toLowerCase();
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const blockedBy = [...blockSet]
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => ({ severity: s, count: counts[s]! }))
    .sort((a, b) => (SEVERITY_RANK[b.severity as Severity] ?? 0) - (SEVERITY_RANK[a.severity as Severity] ?? 0));

  const thorough =
    input.riskTier === "thorough" || input.depth === "thorough";
  const graphRequired =
    input.policy.requireGraph ||
    (input.policy.requireGraphForThorough !== false && thorough);
  const graphBlocks =
    graphRequired && Boolean(input.graphDegraded);

  if (graphBlocks) {
    reasons.push("Structural graph degraded/unavailable while policy requires graph evidence");
  }
  if (input.sessionStatus === "failed") {
    reasons.push("Review session failed before producing a clean result");
  }
  if (blockedBy.length) {
    reasons.push(
      `Blocking severities present: ${blockedBy.map((b) => `${b.severity}×${b.count}`).join(", ")}`,
    );
  }

  const shouldBlock =
    input.sessionStatus === "failed" ||
    graphBlocks ||
    blockedBy.length > 0;

  if (advisory) {
    return {
      verdict: shouldBlock ? "comment" : input.findingCount ? "comment" : "approve",
      reviewEvent: "COMMENT",
      checkConclusion: shouldBlock ? "neutral" : "success",
      checkTitle: shouldBlock
        ? "CodeSteward (advisory): issues reported"
        : "CodeSteward (advisory): clear",
      checkSummary: shouldBlock
        ? `Advisory mode — would block in enforce: ${reasons.join("; ") || "findings present"}. ${input.findingCount} finding(s).`
        : `Advisory mode — no blocking issues. ${input.findingCount} finding(s).`,
      blockedBy,
      advisory: true,
      reasons,
    };
  }

  if (input.sessionStatus === "failed" || graphBlocks) {
    return {
      verdict: "unknown",
      reviewEvent: "COMMENT",
      checkConclusion: "failure",
      checkTitle: "CodeSteward: incomplete / failed",
      checkSummary: reasons.join("; ") || "Review failed",
      blockedBy,
      advisory: false,
      reasons,
    };
  }

  if (blockedBy.length) {
    return {
      verdict: "request_changes",
      reviewEvent: "REQUEST_CHANGES",
      checkConclusion: "failure",
      checkTitle: "CodeSteward: changes requested",
      checkSummary: `${input.findingCount} finding(s). ${reasons.join("; ")}`,
      blockedBy,
      advisory: false,
      reasons,
    };
  }

  if (input.findingCount > 0) {
    return {
      verdict: "comment",
      reviewEvent: "COMMENT",
      checkConclusion: "success",
      checkTitle: "CodeSteward: comments only",
      checkSummary: `${input.findingCount} non-blocking finding(s) posted as comments.`,
      blockedBy: [],
      advisory: false,
      reasons: ["Findings below block threshold"],
    };
  }

  return {
    verdict: "approve",
    reviewEvent: "COMMENT",
    checkConclusion: "success",
    checkTitle: "CodeSteward: passed",
    checkSummary: "No findings above the severity floor / block threshold.",
    blockedBy: [],
    advisory: false,
    reasons: ["Clean review"],
  };
}
