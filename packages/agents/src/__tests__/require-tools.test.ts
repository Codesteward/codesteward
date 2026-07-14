import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAgentRunner } from "../runner.js";

describe("require tool agents", () => {
  const prev = { ...process.env };
  after(() => {
    process.env = { ...prev };
  });
  it("STEW_USE_DEEPAGENTS=0 still allows simple", async () => {
    process.env.STEW_USE_DEEPAGENTS = "0";
    process.env.STEW_REQUIRE_TOOL_AGENTS = "1";
    const runner = createAgentRunner({
      modelRouter: { createChatModel: () => ({ complete: async () => ({ content: "{}" }) }) } as never,
      graph: { query: async () => ({ total: 0, results: [] }) } as never,
      policy: { severityFloor: "medium", pathRules: [] } as never,
    });
    assert.ok(runner);
  });
});
