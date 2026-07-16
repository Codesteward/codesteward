/**
 * Three-level confidence model:
 * - confidence (product): evidence-derived, gates + audit + UI primary
 * - modelConfidence: specialist JSON self-report (diagnostic)
 * - tokenConfidence: mean token prob from provider logprobs when available
 */

export interface ConfidenceSignals {
  modelConfidence?: number;
  tokenConfidence?: number;
  /** Path is present and not a placeholder */
  hasPath?: boolean;
  hasLine?: boolean;
  hasBody?: boolean;
  hasGraphEvidence?: boolean;
  hasDiffEvidence?: boolean;
  hasSastEvidence?: boolean;
  hasProveEvidence?: boolean;
  hasPolicyEvidence?: boolean;
  discourseAgree?: boolean;
  discourseChallenge?: boolean;
  verificationVerdict?: "keep" | "drop" | "downgrade" | "upgrade";
  /** Distinct agent roles that emitted / agreed on this finding */
  agentCount?: number;
}

function clamp01(n: number, lo = 0.1, hi = 0.98): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Derive product confidence from pipeline evidence.
 * Model/token self-scores are weak secondary signals only (± small delta).
 */
export function scoreProductConfidence(s: ConfidenceSignals): number {
  let score = 0.5;

  if (s.hasPath) score += 0.1;
  if (s.hasLine) score += 0.15;
  if (s.hasBody) score += 0.05;
  if (s.hasGraphEvidence) score += 0.15;
  if (s.hasDiffEvidence) score += 0.08;
  if (s.hasSastEvidence) score += 0.12;
  if (s.hasProveEvidence) score += 0.12;
  if (s.hasPolicyEvidence) score += 0.05;
  if (s.discourseAgree) score += 0.1;
  if (s.discourseChallenge) score -= 0.2;
  if ((s.agentCount ?? 1) >= 2) score += 0.08;

  switch (s.verificationVerdict) {
    case "keep":
      score += 0.08;
      break;
    case "upgrade":
      score += 0.05;
      break;
    case "downgrade":
      score -= 0.1;
      break;
    case "drop":
      score -= 0.35;
      break;
    default:
      break;
  }

  // Weak secondary: model self-report (±0.05 around 0.5)
  if (typeof s.modelConfidence === "number" && Number.isFinite(s.modelConfidence)) {
    score += (clamp01(s.modelConfidence, 0, 1) - 0.5) * 0.1;
  }
  // Weaker: token/logprob mean (±0.03 around 0.5)
  if (typeof s.tokenConfidence === "number" && Number.isFinite(s.tokenConfidence)) {
    score += (clamp01(s.tokenConfidence, 0, 1) - 0.5) * 0.06;
  }

  return clamp01(score);
}

export function signalsFromFindingLike(f: {
  path?: string;
  startLine?: number;
  endLine?: number;
  body?: string;
  modelConfidence?: number;
  tokenConfidence?: number;
  evidence?: Array<{ type?: string }>;
  verification?: { verdict?: string };
  agents?: unknown[];
  discourseAgree?: boolean;
  discourseChallenge?: boolean;
}): ConfidenceSignals {
  const path = (f.path ?? "").trim();
  const hasPath = Boolean(path && path !== "unknown" && path !== ".");
  const hasLine =
    (typeof f.startLine === "number" && f.startLine > 0) ||
    (typeof f.endLine === "number" && f.endLine > 0);
  const body = (f.body ?? "").trim();
  const hasBody = body.length >= 24;
  const types = new Set(
    (f.evidence ?? [])
      .map((e) => String(e?.type ?? "").toLowerCase())
      .filter(Boolean),
  );
  const verdict = f.verification?.verdict;
  return {
    modelConfidence: f.modelConfidence,
    tokenConfidence: f.tokenConfidence,
    hasPath,
    hasLine,
    hasBody,
    hasGraphEvidence: types.has("graph"),
    hasDiffEvidence: types.has("diff"),
    hasSastEvidence: types.has("sast"),
    hasProveEvidence: types.has("prove"),
    hasPolicyEvidence: types.has("policy"),
    discourseAgree: f.discourseAgree ?? types.has("discourse"),
    discourseChallenge: f.discourseChallenge,
    verificationVerdict:
      verdict === "keep" ||
      verdict === "drop" ||
      verdict === "downgrade" ||
      verdict === "upgrade"
        ? verdict
        : undefined,
    agentCount: Array.isArray(f.agents) ? Math.max(1, f.agents.length) : 1,
  };
}

/** Recompute product `confidence` from current fields/evidence; preserve model/token layers. */
export function applyProductConfidence<
  T extends {
    path?: string;
    startLine?: number;
    endLine?: number;
    body?: string;
    confidence?: number;
    modelConfidence?: number;
    tokenConfidence?: number;
    evidence?: Array<{ type?: string }>;
    verification?: { verdict?: string };
    agents?: unknown[];
  },
>(finding: T, extra?: Partial<ConfidenceSignals>): T & { confidence: number } {
  const signals = { ...signalsFromFindingLike(finding), ...extra };
  return {
    ...finding,
    confidence: scoreProductConfidence(signals),
  };
}

/**
 * Mean token probability from OpenAI-style logprobs content array.
 * Returns undefined when empty / unsupported.
 */
export function meanTokenConfidence(
  tokens: Array<{ logprob?: number | null }> | undefined | null,
): number | undefined {
  if (!tokens?.length) return undefined;
  const probs: number[] = [];
  for (const t of tokens) {
    if (typeof t.logprob === "number" && Number.isFinite(t.logprob)) {
      probs.push(Math.exp(t.logprob));
    }
  }
  if (!probs.length) return undefined;
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  return clamp01(mean, 0, 1);
}

export interface EmptyScanSignals {
  /** Specialist self-report that the empty result is thorough (0–1) */
  modelConfidence?: number;
  tokenConfidence?: number;
  pathsReviewed?: number;
  filesReviewed?: number;
  usedGraph?: boolean;
  /** Response parsed as valid JSON with findings: [] */
  validEmptyJson?: boolean;
}

/**
 * Product confidence when a specialist returns **zero findings**.
 * Answers: “how sure are we that nothing was missed?” (not finding severity).
 */
export function scoreEmptyScanConfidence(s: EmptyScanSignals): number {
  let score = 0.42;
  if (s.validEmptyJson) score += 0.1;
  if ((s.pathsReviewed ?? 0) > 0) score += 0.12;
  if ((s.filesReviewed ?? 0) > 0) score += 0.1;
  if ((s.pathsReviewed ?? 0) >= 3 || (s.filesReviewed ?? 0) >= 3) score += 0.05;
  if (s.usedGraph) score += 0.12;
  if (typeof s.modelConfidence === "number" && Number.isFinite(s.modelConfidence)) {
    score += (clamp01(s.modelConfidence, 0, 1) - 0.5) * 0.2;
  }
  if (typeof s.tokenConfidence === "number" && Number.isFinite(s.tokenConfidence)) {
    score += (clamp01(s.tokenConfidence, 0, 1) - 0.5) * 0.08;
  }
  return clamp01(score);
}
