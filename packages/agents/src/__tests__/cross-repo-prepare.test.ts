/**
 * Empirical proof: prepareCrossRepoReview calls graph.rebuild for EACH linked
 * repo that has a local path — not only the primary.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrossRepoLink } from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";
import { prepareCrossRepoReview } from "../cross-repo/prepare.js";

function link(
  from: string,
  to: string,
  paths?: { fromPath?: string; toPath?: string },
): CrossRepoLink {
  return {
    id: `lnk-${from}-${to}`,
    orgId: "local",
    fromRepoId: from,
    toRepoId: to,
    edgeType: "depends_on_api",
    pathFilters: { from: [], to: [] },
    fromRepoPath: paths?.fromPath,
    toRepoPath: paths?.toPath,
    hints: { packageName: "@acme/lib" },
    maxDepth: 2,
    tokenBudget: 50_000,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mockGraph(calls: Array<{ repoId?: string; repoPath?: string }>): GraphClient {
  return {
    status: async () => ({
      backend_connected: true,
      graph_backend: "mock",
      last_build: null,
      nodes: { total: 0 },
      edges: { total: 0 },
      stub: true,
    }),
    rebuild: async (opts) => {
      calls.push({ repoId: opts?.repoId, repoPath: opts?.repoPath });
      return {
        mode: "full",
        nodes: { total: 1 },
        edges: { total: 1 },
        files_parsed: 1,
      };
    },
    query: async () => ({ query_type: "dependency", total: 0, results: [], stub: true }),
    augment: async (_agent, additions) => ({
      status: "ok",
      written: additions.length,
      skipped: 0,
    }),
    queryAcross: async () => [],
  } as unknown as GraphClient;
}

describe("prepareCrossRepoReview graph rebuild (empirical)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("calls graph.rebuild once per linked repo path, not only primary", async () => {
    const root = mkdtempSync(join(tmpdir(), "xr-prep-"));
    dirs.push(root);
    const primaryPath = join(root, "primary");
    const libPath = join(root, "lib");
    const authPath = join(root, "auth");
    for (const p of [primaryPath, libPath, authPath]) {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "index.ts"), "export const x = 1;\n");
    }

    const rebuildCalls: Array<{ repoId?: string; repoPath?: string }> = [];
    const graph = mockGraph(rebuildCalls);

    const result = await prepareCrossRepoReview({
      sessionId: "sess-proof",
      primaryRepoId: "acme/api",
      primaryRepoPath: primaryPath,
      primaryPaths: ["src/app.ts"],
      links: [
        link("acme/api", "acme/lib", { toPath: libPath }),
        link("acme/api", "acme/auth", { toPath: authPath }),
      ],
      graph,
      tenantId: "local",
      rebuildPrimary: false, // orchestrator already rebuilt primary in graph stage
      rebuildLinkedGraphs: true,
    });

    // Linked graphs must be rebuilt
    const linkedIds = rebuildCalls.map((c) => c.repoId).sort();
    assert.deepEqual(
      linkedIds,
      ["acme/auth", "acme/lib"],
      `expected rebuild for both linked repos, got ${JSON.stringify(rebuildCalls)}`,
    );

    // Correct paths passed to MCP
    const byId = Object.fromEntries(
      rebuildCalls.map((c) => [c.repoId, c.repoPath]),
    );
    assert.equal(byId["acme/lib"], libPath);
    assert.equal(byId["acme/auth"], authPath);

    // Primary not rebuilt in this prepare when rebuildPrimary=false
    assert.ok(!rebuildCalls.some((c) => c.repoId === "acme/api"));

    assert.ok(result.rebuiltRepoIds.includes("acme/lib"));
    assert.ok(result.rebuiltRepoIds.includes("acme/auth"));
    assert.equal(result.units.length, 2);
    for (const u of result.units) {
      assert.equal(u.metadata?.crossRepo, true);
      assert.ok(
        typeof u.metadata?.repoPath === "string" && u.metadata.repoPath.length > 0,
        "unit must carry its own repoPath",
      );
      assert.notEqual(u.metadata?.repoPath, primaryPath);
    }

    // Edge seed ran
    assert.ok(result.edgeSeed.written >= 2, "expected cross-repo edges written");
  });

  it("rebuilds primary as well when rebuildPrimary=true", async () => {
    const root = mkdtempSync(join(tmpdir(), "xr-prim-"));
    dirs.push(root);
    const primaryPath = join(root, "primary");
    const libPath = join(root, "lib");
    mkdirSync(primaryPath, { recursive: true });
    mkdirSync(libPath, { recursive: true });
    writeFileSync(join(primaryPath, "a.ts"), "export {};\n");
    writeFileSync(join(libPath, "b.ts"), "export {};\n");

    const rebuildCalls: Array<{ repoId?: string; repoPath?: string }> = [];
    const result = await prepareCrossRepoReview({
      sessionId: "sess-prim",
      primaryRepoId: "acme/api",
      primaryRepoPath: primaryPath,
      primaryPaths: ["."],
      links: [link("acme/api", "acme/lib", { toPath: libPath })],
      graph: mockGraph(rebuildCalls),
      tenantId: "local",
      rebuildPrimary: true,
      rebuildLinkedGraphs: true,
    });

    const ids = new Set(rebuildCalls.map((c) => c.repoId));
    assert.ok(ids.has("acme/api"), "primary must be rebuilt");
    assert.ok(ids.has("acme/lib"), "linked must be rebuilt");
    assert.equal(rebuildCalls.length, 2);
    assert.deepEqual(result.rebuiltRepoIds.sort(), ["acme/api", "acme/lib"]);
  });

  it("does not call rebuild for missing linked repos", async () => {
    const root = mkdtempSync(join(tmpdir(), "xr-miss-"));
    dirs.push(root);
    const primaryPath = join(root, "primary");
    mkdirSync(primaryPath, { recursive: true });

    const rebuildCalls: Array<{ repoId?: string; repoPath?: string }> = [];
    const result = await prepareCrossRepoReview({
      sessionId: "sess-miss",
      primaryRepoId: "acme/api",
      primaryRepoPath: primaryPath,
      primaryPaths: ["."],
      // no toRepoPath and no clone auth → missing
      links: [link("acme/api", "acme/ghost")],
      graph: mockGraph(rebuildCalls),
      tenantId: "local",
      rebuildLinkedGraphs: true,
    });

    assert.equal(rebuildCalls.length, 0);
    assert.equal(result.units.length, 0);
    assert.ok(result.skipped.some((s) => s.repoId === "acme/ghost"));
  });
});
