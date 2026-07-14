import type { FindingCandidate } from "@codesteward/core";
import type { ModelRouter } from "@codesteward/model-router";
import type { Policy } from "@codesteward/policy";

export type Verdict = "keep" | "drop" | "downgrade" | "upgrade";

export interface VerifiedFinding extends FindingCandidate {
  verification: {
    verdict: Verdict;
    reason: string;
    verifiedBy: string;
  };
}

/**
 * Verifier second pass — keep/drop/downgrade.
 * Uses cheap model when verificationBar is sample/full.
 */
export async function verifyFindings(
  findings: FindingCandidate[],
  policy: Policy,
  modelRouter: ModelRouter,
): Promise<VerifiedFinding[]> {
  if (policy.verificationBar === "off") {
    return findings.map((f) => ({
      ...f,
      verification: { verdict: "keep" as const, reason: "verification off", verifiedBy: "policy" },
    }));
  }

  const sample =
    policy.verificationBar === "sample"
      ? findings.filter((_, i) => i % 5 === 0)
      : findings;
  const sampleSet = new Set(sample);

  const out: VerifiedFinding[] = [];
  for (const f of findings) {
    if (!sampleSet.has(f)) {
      out.push({
        ...f,
        verification: { verdict: "keep", reason: "not sampled", verifiedBy: "sample-policy" },
      });
      continue;
    }
    try {
      const model = modelRouter.createChatModel("verifier");
      const res = await model.complete({
        system:
          'You verify code review findings. Reply JSON: {"verdict":"keep"|"drop"|"downgrade"|"upgrade","reason":"..."}',
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              title: f.title,
              body: f.body,
              path: f.path,
              severity: f.severity,
              category: f.category,
            }),
          },
        ],
        jsonMode: true,
        temperature: 0,
      });
      const parsed = peelVerdict(res.content);
      out.push({
        ...f,
        severity:
          parsed.verdict === "downgrade" ? downgrade(f.severity) : f.severity,
        verification: {
          verdict: parsed.verdict,
          reason: parsed.reason,
          verifiedBy: "verifier",
        },
      });
    } catch (err) {
      out.push({
        ...f,
        verification: {
          verdict: "keep",
          reason: `verifier error: ${err instanceof Error ? err.message : String(err)}`,
          verifiedBy: "verifier-fallback",
        },
      });
    }
  }
  return out.filter((f) => f.verification.verdict !== "drop");
}

function peelVerdict(content: string): { verdict: Verdict; reason: string } {
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    const j = JSON.parse(content.slice(start, end + 1)) as {
      verdict?: string;
      reason?: string;
    };
    const v = j.verdict;
    if (v === "keep" || v === "drop" || v === "downgrade" || v === "upgrade") {
      return { verdict: v, reason: j.reason ?? "" };
    }
  } catch {
    /* fallthrough */
  }
  return { verdict: "keep", reason: "unparseable verifier response" };
}

function downgrade(s: FindingCandidate["severity"]): FindingCandidate["severity"] {
  const order = ["critical", "high", "medium", "low", "info", "nit"] as const;
  const i = order.indexOf(s);
  return order[Math.min(i + 1, order.length - 1)]!;
}
