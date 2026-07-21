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

function isInfraSpawnError(msg: string): boolean {
  return /spawn\s|EACCES|ENOENT|graph MCP stdio|Permission denied|binary not found/i.test(
    msg,
  );
}

/**
 * Graph tools for specialists. Scope is pinned by the orchestrator — agents
 * cannot switch tenant_id. Optional repoId on query is limited to allowedRepoIds.
 */
export function createGraphTools(graph: GraphClient, scope: GraphToolScope) {
  const defaultRebuildPath = (): string | undefined => {
    const root = scope.workspaceRoot?.trim();
    return root || undefined;
  };

  const graph_status = tool(
    async () => {
      try {
        const s = await graph.status({
          tenantId: scope.tenantId,
          repoId: scope.repoId,
        });
        const lastBuild =
          (s as { last_build?: unknown }).last_build ??
          (s as { lastBuild?: unknown }).lastBuild ??
          null;
        const needsRebuild = lastBuild == null;
        return JSON.stringify({
          ...s,
          available: true,
          tenantId: scope.tenantId,
          repoId: scope.repoId,
          ...(needsRebuild
            ? {
                next_step:
                  "Graph has no last_build for this repo. Call graph_rebuild (omit repoPath — uses this unit workspace), then graph_query.",
              }
            : {
                next_step:
                  "Graph is indexed. Call graph_query (lexical/referential/dependency) for structural evidence.",
              }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const infra = isInfraSpawnError(msg);
        return JSON.stringify({
          available: false,
          error: msg,
          tenantId: scope.tenantId,
          repoId: scope.repoId,
          hint: infra
            ? "Graph MCP failed to start (worker infrastructure). graph_rebuild will fail the same way — continue with file tools/Diff; ops must fix GRAPH_MCP_COMMAND / codesteward-mcp install."
            : "Graph unreachable or error — try graph_rebuild once, else continue without structural evidence.",
          next_step: infra
            ? "Do not retry graph tools for this unit; use read_file/sandbox and packed context."
            : "Call graph_rebuild (no repoPath), then graph_status, then graph_query.",
        });
      }
    },
    {
      name: "graph_status",
      description:
        "Return Codesteward Graph status for the current repo (nodes, edges, last_build). If last_build is null, call graph_rebuild before graph_query.",
      schema: z.object({}),
    },
  );

  const graph_rebuild = tool(
    async ({ repoPath, changedFiles }) => {
      try {
        // Default to this unit's workspace so agents never invent host paths
        const rawPath = (repoPath ?? "").trim() || defaultRebuildPath();
        const safePath = assertRebuildPath(scope, rawPath);
        if (!safePath) {
          return JSON.stringify({
            ok: false,
            error:
              "graph_rebuild needs a workspace path; none pinned for this unit (orchestrator should set unit repoPath).",
          });
        }
        const r = await graph.rebuild({
          tenantId: scope.tenantId,
          repoId: scope.repoId,
          repoPath: safePath,
          changedFiles: changedFiles ?? undefined,
        });
        return JSON.stringify({
          ...r,
          ok: true,
          repoId: scope.repoId,
          next_step: "Call graph_query for structural evidence on this repo.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          ok: false,
          error: msg,
          hint: isInfraSpawnError(msg)
            ? "Graph MCP cannot start — not an agent path issue. Continue without graph."
            : "Rebuild failed; continue with file tools if appropriate.",
        });
      }
    },
    {
      name: "graph_rebuild",
      description:
        "Parse/rebuild the structural graph for THIS unit's repository. Prefer omitting repoPath (defaults to the unit workspace). Call when graph_status shows last_build=null or empty results, then graph_query.",
      schema: z.object({
        repoPath: z
          .string()
          .optional()
          .describe("Optional; defaults to this unit workspace. Do not pass host/session paths."),
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
        const text = JSON.stringify(r);
        // Empty / no-build style results: nudge rebuild once
        const emptyHint =
          /"results"\s*:\s*\[\s*\]/.test(text) ||
          /last_build["']?\s*:\s*null/.test(text)
            ? {
                next_step:
                  "Empty graph results — if you have not rebuilt this unit yet, call graph_rebuild then retry graph_query.",
              }
            : {};
        return JSON.stringify({ ...r, ...emptyHint }).slice(0, 12000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          available: false,
          error: msg,
          queryType,
          query,
          next_step: isInfraSpawnError(msg)
            ? "Graph MCP down — skip graph for this unit."
            : "If the graph was never built, call graph_rebuild then retry; else continue without structural evidence.",
        });
      }
    },
    {
      name: "graph_query",
      description:
        "Query the structural code graph for this review (and allowed linked repos). queryType: lexical|referential|semantic|dependency. If empty and no prior rebuild this unit, call graph_rebuild first.",
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
