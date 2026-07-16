import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGraphTools } from "../tools/graph-tools.js";
import { join } from "node:path";

describe("graph tools multi-tenant isolation", () => {
  it("refuses graph_query for repo outside allow-list", async () => {
    const tools = createGraphTools(
      {
        query: async (_t: string, _q: string, opts: { repoId?: string }) => ({
          total: 1,
          results: [{ repoId: opts.repoId }],
        }),
      } as never,
      {
        tenantId: "org_a",
        repoId: "a/repo",
        allowedRepoIds: ["a/repo", "a/linked"],
      },
    );
    const graphQuery = tools.find((t) => (t as { name?: string }).name === "graph_query") as {
      invoke: (args: Record<string, unknown>) => Promise<string>;
    };
    assert.ok(graphQuery);
    const bad = await graphQuery.invoke({
      queryType: "lexical",
      query: "x",
      repoId: "evil/other-org",
    });
    assert.match(bad, /not allowed|escapes|error/i);
  });

  it("refuses graph_rebuild path outside workspace", async () => {
    const tools = createGraphTools(
      {
        rebuild: async () => ({ ok: true }),
      } as never,
      {
        tenantId: "org_a",
        repoId: "a/repo",
        workspaceRoot: join("/tmp", "ws", "org_a", "ses_1"),
      },
    );
    const rebuild = tools.find((t) => (t as { name?: string }).name === "graph_rebuild") as {
      invoke: (args: Record<string, unknown>) => Promise<string>;
    };
    const bad = await rebuild.invoke({
      repoPath: join("/tmp", "ws", "org_b", "ses_2"),
    });
    assert.match(bad, /escape|refus|error|false/i);
  });
});
