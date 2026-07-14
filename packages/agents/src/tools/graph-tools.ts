import type { GraphClient } from "@codesteward/graph-client";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export function createGraphTools(
  graph: GraphClient,
  scope: { tenantId: string; repoId: string },
) {
  const graph_status = tool(
    async () => {
      try {
        const s = await graph.status(scope);
        return JSON.stringify(s);
      } catch (err) {
        // Soft-fail: specialists must continue without a hard tool exception
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
        const r = await graph.rebuild({
          ...scope,
          repoPath: repoPath ?? undefined,
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
      description: "Parse/rebuild the structural graph for this repository (full or incremental).",
      schema: z.object({
        repoPath: z.string().optional(),
        changedFiles: z.array(z.string()).optional(),
      }),
    },
  );

  const graph_query = tool(
    async ({ queryType, query, limit, repoId }) => {
      try {
        const r = await graph.query(queryType, query ?? "", {
          tenantId: scope.tenantId,
          repoId: repoId ?? scope.repoId,
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
        "Query the structural code graph. queryType: lexical|referential|semantic|dependency. Use for callers, auth guards, deps.",
      schema: z.object({
        queryType: z.enum(["lexical", "referential", "semantic", "dependency", "cypher", "gremlin"]),
        query: z.string().default(""),
        limit: z.number().int().positive().optional(),
        repoId: z.string().optional().describe("Optional other repo for cross-repo query"),
      }),
    },
  );

  const graph_augment = tool(
    async ({ agentId, sourceId, edgeType, targetId, targetName, confidence, rationale }) => {
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
        scope,
      );
      return JSON.stringify(r);
    },
    {
      name: "graph_augment",
      description: "Record an agent-inferred graph edge (confidence < 1.0).",
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
