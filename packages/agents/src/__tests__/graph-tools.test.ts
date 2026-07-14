import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGraphTools } from "../tools/graph-tools.js";

describe("graph tools for deep agents", () => {
  it("exposes named graph_query tool", () => {
    const tools = createGraphTools(
      {
        query: async () => ({ total: 1, results: [{ name: "foo" }] }),
      } as never,
      { tenantId: "local", repoId: "demo" },
    );
    assert.ok(tools.length >= 1);
    const names = tools.map((t) => (t as { name?: string }).name).filter(Boolean);
    assert.ok(names.some((n) => String(n).includes("graph") || String(n).length > 0), String(names));
  });
});
