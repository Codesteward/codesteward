import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, lookupModelPrice, normalizeModelId } from "../pricing.js";
import { createTokenBudget } from "../budget.js";

describe("pricing", () => {
  it("normalizes openrouter and colon ids", () => {
    assert.equal(normalizeModelId("openai/gpt-4.1-mini"), "gpt-4.1-mini");
    assert.equal(normalizeModelId("openai:gpt-4.1"), "gpt-4.1");
  });

  it("looks up known mini model cheaper than default", () => {
    const mini = lookupModelPrice("gpt-4.1-mini");
    const def = lookupModelPrice("totally-unknown-model-xyz");
    assert.ok(mini.inputPerMTok < def.inputPerMTok);
  });

  it("estimates cost from prompt + completion", () => {
    const { costUsd } = estimateCostUsd({
      model: "gpt-4.1-mini",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    // 0.4 + 1.6 = 2.0
    assert.ok(Math.abs(costUsd - 2.0) < 1e-9);
  });
});

describe("token budget snapshot", () => {
  it("accumulates prompt, completion, cost across calls", () => {
    const b = createTokenBudget(1_000_000);
    b.record({
      promptTokens: 1000,
      completionTokens: 200,
      model: "gpt-4.1-mini",
    });
    b.record({
      promptTokens: 500,
      completionTokens: 100,
      model: "gpt-4.1-mini",
    });
    const snap = b.snapshot();
    assert.equal(snap.promptTokens, 1500);
    assert.equal(snap.completionTokens, 300);
    assert.equal(snap.totalTokens, 1800);
    assert.equal(snap.calls, 2);
    assert.ok(snap.costUsd > 0);
    assert.ok(snap.byModel?.["gpt-4.1-mini"]);
  });
});
