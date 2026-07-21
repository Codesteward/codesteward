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

  it("graph_rebuild defaults repoPath to unit workspaceRoot", async () => {
    const root = join("/tmp", "ws", "org_a", "ses_1");
    let seen: string | undefined;
    const tools = createGraphTools(
      {
        rebuild: async (opts: { repoPath?: string }) => {
          seen = opts.repoPath;
          return { ok: true, nodes: 1 };
        },
      } as never,
      {
        tenantId: "org_a",
        repoId: "Codesteward/codesteward-session-summarizer",
        workspaceRoot: root,
      },
    );
    const rebuild = tools.find((t) => (t as { name?: string }).name === "graph_rebuild") as {
      invoke: (args: Record<string, unknown>) => Promise<string>;
    };
    const out = await rebuild.invoke({});
    assert.match(out, /"ok"\s*:\s*true/);
    assert.equal(seen, root);
  });

  it("graph_status surfaces next_step when last_build is null", async () => {
    const tools = createGraphTools(
      {
        status: async () => ({ last_build: null, nodes: null, edges: null }),
      } as never,
      { tenantId: "org_a", repoId: "a/repo", workspaceRoot: "/tmp/ws" },
    );
    const status = tools.find((t) => (t as { name?: string }).name === "graph_status") as {
      invoke: (args: Record<string, unknown>) => Promise<string>;
    };
    const out = await status.invoke({});
    assert.match(out, /graph_rebuild/i);
    assert.match(out, /next_step/i);
  });

  it("graph_status spawn errors tell agent not to loop rebuild", async () => {
    const tools = createGraphTools(
      {
        status: async () => {
          throw new Error("spawn codesteward-mcp EACCES");
        },
      } as never,
      { tenantId: "local", repoId: "Codesteward/codesteward-session-summarizer" },
    );
    const status = tools.find((t) => (t as { name?: string }).name === "graph_status") as {
      invoke: (args: Record<string, unknown>) => Promise<string>;
    };
    const out = await status.invoke({});
    assert.match(out, /available"\s*:\s*false/);
    assert.match(out, /infrastructure|Do not retry|MCP/i);
  });
});
