import type { GraphClient } from "@codesteward/graph-client";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GraphToolScope } from "../graph-scope.js";
import { isPathInsideRoot, resolveInsideRoot, tenantIsolationMode } from "../path-jail.js";
import { resolve } from "node:path";

function assertRepoAllowed(scope: GraphToolScope, repoId: string): void {
  const allowed = scope.allowedRepoIds;
  if (!allowed?.length) return;
  if (allowed.includes(repoId)) return;
  throw new Error(
    `graph repoId not allowed for this session: ${repoId.slice(0, 80)} (allowed: ${allowed.slice(0, 8).join(", ")})`,
  );
}

function assertRebuildPath(scope: GraphToolScope, repoPath: string | undefined): string | undefined {
  if (!repoPath?.trim()) return undefined;
  const mode = tenantIsolationMode();
  if (mode === "off" || !scope.workspaceRoot?.trim()) {
    return repoPath;
  }
  const root = resolve(scope.workspaceRoot);
  const abs = resolve(repoPath);
  // Absolute path must stay under session workspace (or equal it)
  if (!isPathInsideRoot(root, abs)) {
    // Also try relative resolution under workspace
    try {
      return resolveInsideRoot(root, repoPath);
    } catch {
      throw new Error(
        `graph_rebuild repoPath escapes session workspace (refusing ${repoPath.slice(0, 120)})`,
      );
    }
  }
  return abs;
}

/**
 * Graph tools for specialists. Scope is pinned by the orchestrator — agents
 * cannot switch tenant_id. Optional repoId on query is limited to allowedRepoIds.
 */
export function createGraphTools(graph: GraphClient, scope: GraphToolScope) {
  const graph_status = tool(
    async () => {
      try {
        const s = await graph.status({
          tenantId: scope.tenantId,
          repoId: scope.repoId,
        });
        return JSON.stringify(s);
      } catch (err) {
        return JSON.stringify({
          available: false,
          error: err instanceof Error ? err.message : String(err),
          tenantId: scope.tenantId,
          repoId: scope.repoId,
          hint: "Graph MCP unreachable or repo not indexed — continue without structural evidence",
        });
      }
    },
    {
      name: "graph_status",
      description: "Return Codesteward Graph status for the current repo (nodes, edges, last_build).",
      schema: z.object({}),
    },
  );

  const graph_rebuild = tool(
    async ({ repoPath, changedFiles }) => {
      try {
        const safePath = assertRebuildPath(scope, repoPath);
        const r = await graph.rebuild({
          tenantId: scope.tenantId,
          repoId: scope.repoId,
          repoPath: safePath,
          changedFiles: changedFiles ?? undefined,
        });
        return JSON.stringify(r);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "graph_rebuild",
      description:
        "Parse/rebuild the structural graph for this repository only (full or incremental). Path must be this session's workspace.",
      schema: z.object({
        repoPath: z.string().optional(),
        changedFiles: z.array(z.string()).optional(),
      }),
    },
  );

  const graph_query = tool(
    async ({ queryType, query, limit, repoId }) => {
      try {
        const rid = repoId ?? scope.repoId;
        assertRepoAllowed(scope, rid);
        const r = await graph.query(queryType, query ?? "", {
          tenantId: scope.tenantId,
          repoId: rid,
          limit: limit ?? 50,
        });
        return JSON.stringify(r).slice(0, 12000);
      } catch (err) {
        return JSON.stringify({
          available: false,
          error: err instanceof Error ? err.message : String(err),
          queryType,
          query,
        });
      }
    },
    {
      name: "graph_query",
      description:
        "Query the structural code graph for this review (and allowed linked repos). queryType: lexical|referential|semantic|dependency.",
      schema: z.object({
        queryType: z.enum(["lexical", "referential", "semantic", "dependency", "cypher", "gremlin"]),
        query: z.string().default(""),
        limit: z.number().int().positive().optional(),
        repoId: z
          .string()
          .optional()
          .describe("Optional linked repo id (must be in this session's allow-list)"),
      }),
    },
  );

  const graph_augment = tool(
    async ({ agentId, sourceId, edgeType, targetId, targetName, confidence, rationale }) => {
      try {
        const r = await graph.augment(
          agentId,
          [
            {
              source_id: sourceId,
              edge_type: edgeType,
              target_id: targetId,
              target_name: targetName,
              confidence,
              rationale,
            },
          ],
          { tenantId: scope.tenantId, repoId: scope.repoId },
        );
        return JSON.stringify(r);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "graph_augment",
      description: "Record an agent-inferred graph edge for this repo only (confidence < 1.0).",
      schema: z.object({
        agentId: z.string(),
        sourceId: z.string(),
        edgeType: z.string(),
        targetId: z.string(),
        targetName: z.string(),
        confidence: z.number().min(0).max(1),
        rationale: z.string().optional(),
      }),
    },
  );

  return [graph_status, graph_rebuild, graph_query, graph_augment];
}
