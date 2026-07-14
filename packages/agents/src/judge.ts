import {
  SEVERITY_RANK,
  type FindingCandidate,
  type Severity,
} from "@codesteward/core";
import type { Policy } from "@codesteward/policy";
import {
  applyNoiseStack,
  fingerprintOf,
  type NoiseOptions,
} from "./noise.js";

export interface JudgeResult {
  findings: FindingCandidate[];
  dropped: Array<{ title: string; reason: string }>;
}

export interface JudgeOptions extends NoiseOptions {
  /** Title/body patterns from negative org memories. */
  negativePatterns?: string[];
}

/**
 * Judge: noise stack (severity floor, nit cap, fingerprint dedupe,
 * re-review convergence, learning suppressions).
 */
export function judgeFindings(
  candidates: FindingCandidate[],
  policy: Policy,
  opts: JudgeOptions = {},
): JudgeResult {
  // Pre-filter by negative title/body patterns from learning
  const dropped: Array<{ title: string; reason: string }> = [];
  let input = candidates;
  if (opts.negativePatterns?.length) {
    const patterns = opts.negativePatterns
      .map((p) => {
        try {
          return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch {
          return null;
        }
      })
      .filter((x): x is RegExp => Boolean(x));
    input = candidates.filter((c) => {
      for (const re of patterns) {
        if (re.test(c.title) || re.test(c.body ?? "")) {
          dropped.push({ title: c.title, reason: "negative memory pattern" });
          return false;
        }
      }
      return true;
    });
  }

  const noise = applyNoiseStack(input, policy, opts);
  return {
    findings: noise.findings,
    dropped: [...dropped, ...noise.dropped],
  };
}

export function severityCounts(findings: { severity: Severity }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.severity] = (out[f.severity] ?? 0) + 1;
  }
  return out;
}

export { fingerprintOf, applyNoiseStack };
