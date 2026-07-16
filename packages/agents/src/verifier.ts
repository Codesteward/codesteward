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

export interface VerifyOptions {
  /**
   * Packed diff / file context from the review (shared across specialists).
   * Truncated again inside the verifier for token budget.
   */
  contextText?: string;
  /** Org learning / suppressions already applied to specialists. */
  learningGuidance?: string;
  /**
   * Max findings per senior-reviewer LLM call (default 10).
   * Batches run in parallel after the specialist barrier.
   */
  batchSize?: number;
  /** Cap context excerpt chars (default 14_000). */
  contextChars?: number;
}

const SENIOR_SYSTEM = `You are a principal software engineer and senior code-review lead (the bar competitors like CodeRabbit aim for).
Your job is NOT to re-discover every bug. Specialists already proposed findings in parallel (security, correctness, testing, rules, …). They do not see each other's work.

You receive:
1) Each candidate finding with title, body, path/lines, severity, specialist role(s), product/model confidence, optional suggested fix
2) **Specialist reasoning** — their structured thought process (why real, what checked, caveats). Prefer this over inventing alternative theories.
3) Optional packed diff/file context from the same review session

Decide for EACH finding: keep | drop | downgrade | upgrade.
- keep — real, actionable, well-grounded in path/line/context or specialist reasoning
- drop — false positive, style nit below the bar, duplicate of a stronger finding in the batch, or cannot be justified from context+reasoning
- downgrade — real but overstated severity
- upgrade — understated severity and evidence is strong

Be adversarial but fair. Prefer high signal. Do not invent files or APIs not present in context/reasoning.
Respond ONLY with JSON:
{"verdicts":[{"index":0,"verdict":"keep|drop|downgrade|upgrade","reason":"1-3 sentences citing specialist reasoning and/or code context"}]}
Include one entry per input finding index (0-based).`;

/**
 * Senior second-pass verification — batch review with specialist rationale.
 * Runs after all specialists finish (orchestrator barrier).
 */
export async function verifyFindings(
  findings: FindingCandidate[],
  policy: Policy,
  modelRouter: ModelRouter,
  opts: VerifyOptions = {},
): Promise<VerifiedFinding[]> {
  if (policy.verificationBar === "off") {
    return findings.map((f) => ({
      ...f,
      verification: {
        verdict: "keep" as const,
        reason: "verification off",
        verifiedBy: "policy",
      },
    }));
  }

  if (!findings.length) return [];

  const sample =
    policy.verificationBar === "sample"
      ? findings.filter((_, i) => i % 5 === 0)
      : findings;
  const sampleSet = new Set(sample);

  const toVerify: Array<{ finding: FindingCandidate; originalIndex: number }> = [];
  findings.forEach((f, originalIndex) => {
    if (sampleSet.has(f)) toVerify.push({ finding: f, originalIndex });
  });

  if (!toVerify.length) {
    return findings.map((f) => ({
      ...f,
      verification: {
        verdict: "keep" as const,
        reason: "not sampled",
        verifiedBy: "sample-policy",
      },
    }));
  }

  const batchSize = Math.max(
    1,
    opts.batchSize ?? Number(process.env.STEW_VERIFY_BATCH_SIZE ?? 10),
  );
  const contextChars =
    opts.contextChars ?? Number(process.env.STEW_VERIFY_CONTEXT_CHARS ?? 14_000);
  const contextSlice = opts.contextText?.slice(0, contextChars);
  const learningSlice = opts.learningGuidance?.slice(0, 2_000);

  const batches: Array<typeof toVerify> = [];
  for (let i = 0; i < toVerify.length; i += batchSize) {
    batches.push(toVerify.slice(i, i + batchSize));
  }

  // Parallel batch senior reviews (after specialist barrier)
  const batchResults = await Promise.all(
    batches.map((batch, batchIdx) =>
      verifyBatch({
        batch,
        batchIdx,
        modelRouter,
        policy,
        contextSlice,
        learningSlice,
      }),
    ),
  );

  const byOriginal = new Map<number, VerifiedFinding>();
  for (const part of batchResults) {
    for (const [origIdx, vf] of part) {
      byOriginal.set(origIdx, vf);
    }
  }

  const out: VerifiedFinding[] = [];
  findings.forEach((f, i) => {
    if (byOriginal.has(i)) {
      out.push(byOriginal.get(i)!);
    } else {
      out.push({
        ...f,
        verification: {
          verdict: "keep",
          reason: "not sampled",
          verifiedBy: "sample-policy",
        },
      });
    }
  });

  return out.filter((f) => f.verification.verdict !== "drop");
}

async function verifyBatch(input: {
  batch: Array<{ finding: FindingCandidate; originalIndex: number }>;
  batchIdx: number;
  modelRouter: ModelRouter;
  policy: Policy;
  contextSlice?: string;
  learningSlice?: string;
}): Promise<Map<number, VerifiedFinding>> {
  const { batch, modelRouter, policy, contextSlice, learningSlice } = input;
  const result = new Map<number, VerifiedFinding>();

  const payload = {
    severityFloor: policy.severityFloor ?? "medium",
    batchIndex: input.batchIdx,
    findings: batch.map(({ finding: f }, index) => ({
      index,
      title: f.title,
      body: (f.body ?? "").slice(0, 2_000),
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      severity: f.severity,
      category: f.category,
      agents: f.agents ?? [],
      confidence: f.confidence,
      modelConfidence: f.modelConfidence,
      // Prefer first-class field; fall back to evidence.type=reasoning payload
      reasoning: specialistReasoning(f)?.slice(0, 2_500) || undefined,
      suggestion: f.suggestion?.slice(0, 500),
      suggestedFix: f.suggestedFix?.slice(0, 800),
      existingCode: f.existingCode?.slice(0, 600),
      ruleIds: f.ruleIds,
      evidence: (f.evidence ?? []).slice(0, 6).map((e) => ({
        type: e.type,
        summary: e.summary?.slice(0, 300),
      })),
    })),
    reviewContext: contextSlice || undefined,
    orgLearning: learningSlice || undefined,
  };

  try {
    const model = modelRouter.createChatModel("verifier");
    const res = await model.complete({
      system: SENIOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify(payload),
        },
      ],
      jsonMode: true,
      temperature: 0,
    });
    const verdicts = peelVerdicts(res.content, batch.length);
    batch.forEach(({ finding: f, originalIndex }, index) => {
      const v = verdicts[index] ?? {
        verdict: "keep" as Verdict,
        reason: "missing verdict entry",
      };
      result.set(originalIndex, {
        ...f,
        severity: v.verdict === "downgrade" ? downgrade(f.severity) : f.severity,
        verification: {
          verdict: v.verdict,
          reason: v.reason,
          verifiedBy: "senior-verifier",
        },
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const { finding: f, originalIndex } of batch) {
      result.set(originalIndex, {
        ...f,
        verification: {
          verdict: "keep",
          reason: `verifier error: ${msg}`,
          verifiedBy: "verifier-fallback",
        },
      });
    }
  }

  return result;
}

function peelVerdicts(
  content: string,
  expected: number,
): Array<{ verdict: Verdict; reason: string }> {
  const fallback = Array.from({ length: expected }, () => ({
    verdict: "keep" as Verdict,
    reason: "unparseable verifier response",
  }));
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return fallback;
    const j = JSON.parse(content.slice(start, end + 1)) as {
      verdicts?: Array<{ index?: number; verdict?: string; reason?: string }>;
      verdict?: string;
      reason?: string;
    };
    if (Array.isArray(j.verdicts)) {
      const out = [...fallback];
      for (const row of j.verdicts) {
        const v = normalizeVerdict(row.verdict);
        if (!v) continue;
        if (typeof row.index === "number" && row.index >= 0 && row.index < out.length) {
          out[row.index] = { verdict: v, reason: row.reason ?? "" };
        }
      }
      // Fill remaining slots in array order when models omit indices
      let cursor = 0;
      for (const row of j.verdicts) {
        const v = normalizeVerdict(row.verdict);
        if (!v || typeof row.index === "number") continue;
        while (cursor < out.length && out[cursor]!.reason !== "unparseable verifier response") {
          cursor += 1;
        }
        if (cursor < out.length) {
          out[cursor] = { verdict: v, reason: row.reason ?? "" };
          cursor += 1;
        }
      }
      return out;
    }
    const single = normalizeVerdict(j.verdict);
    if (single && expected === 1) {
      return [{ verdict: single, reason: j.reason ?? "" }];
    }
  } catch {
    /* fallthrough */
  }
  return fallback;
}

function normalizeVerdict(v: string | undefined): Verdict | null {
  if (v === "keep" || v === "drop" || v === "downgrade" || v === "upgrade") return v;
  return null;
}

/** Structured rationale only — never raw multi-turn specialist chat. */
function specialistReasoning(f: FindingCandidate): string | undefined {
  if (f.reasoning?.trim()) return f.reasoning.trim();
  for (const e of f.evidence ?? []) {
    if (e.type !== "reasoning") continue;
    const text =
      (typeof e.payload?.text === "string" && e.payload.text) ||
      e.summary ||
      "";
    if (text.trim()) return text.trim();
  }
  return undefined;
}

function downgrade(s: FindingCandidate["severity"]): FindingCandidate["severity"] {
  const order = ["critical", "high", "medium", "low", "info", "nit"] as const;
  const i = order.indexOf(s);
  return order[Math.min(i + 1, order.length - 1)]!;
}
