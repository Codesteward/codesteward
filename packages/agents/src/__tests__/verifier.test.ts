import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FindingCandidate } from "@codesteward/core";
import type { ModelRouter } from "@codesteward/model-router";
import type { Policy } from "@codesteward/policy";
import { verifyFindings } from "../verifier.js";

function mockRouter(content: string): ModelRouter {
  return {
    createChatModel() {
      return {
        complete: async () => ({ content, tokenConfidence: undefined }),
      };
    },
  } as unknown as ModelRouter;
}

const policy = {
  verificationBar: "full",
  severityFloor: "medium",
} as Policy;

const baseFinding = (over: Partial<FindingCandidate> = {}): FindingCandidate => ({
  title: "SQL injection",
  body: "User input concatenated into query",
  path: "src/db.ts",
  startLine: 10,
  category: "security",
  severity: "high",
  confidence: 0.85,
  reasoning:
    "Checked callers of query(); no parameterization on the login path; request.body.q flows into SQL.",
  agents: ["security"],
  ...over,
});

describe("verifyFindings senior batch", () => {
  it("forwards specialist reasoning and drops false positives", async () => {
    const findings = [
      baseFinding(),
      baseFinding({
        title: "Style nit",
        body: "prefer const",
        severity: "low",
        reasoning: "Pure style preference with no bug risk.",
        agents: ["rules"],
      }),
    ];
    const router = mockRouter(
      JSON.stringify({
        verdicts: [
          {
            index: 0,
            verdict: "keep",
            reason: "Specialist reasoning shows real taint into SQL.",
          },
          {
            index: 1,
            verdict: "drop",
            reason: "Style-only; below review bar.",
          },
        ],
      }),
    );
    const out = await verifyFindings(findings, policy, router, {
      contextText: "### FILE: src/db.ts\nquery(`SELECT * FROM t WHERE q=${req.body.q}`)",
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.title, "SQL injection");
    assert.equal(out[0]!.verification.verdict, "keep");
    assert.equal(out[0]!.verification.verifiedBy, "senior-verifier");
  });

  it("skips LLM when verificationBar is off", async () => {
    let called = 0;
    const router = {
      createChatModel() {
        called += 1;
        return { complete: async () => ({ content: "{}" }) };
      },
    } as unknown as ModelRouter;
    const out = await verifyFindings(
      [baseFinding()],
      { ...policy, verificationBar: "off" } as Policy,
      router,
    );
    assert.equal(called, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.verification.verifiedBy, "policy");
  });
});
