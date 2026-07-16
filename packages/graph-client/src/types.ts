import { z } from "zod";

export const GraphQueryTypeSchema = z.enum([
  "lexical",
  "referential",
  "semantic",
  "dependency",
  "cypher",
  "gremlin",
]);
export type GraphQueryType = z.infer<typeof GraphQueryTypeSchema>;

export interface GraphStatus {
  backend_connected: boolean;
  graph_backend: string;
  last_build: string | null;
  nodes: { total: number | null } | null;
  edges: { total: number | null } | null;
  stub?: boolean;
}

export interface GraphRebuildResult {
  mode: "full" | "incremental";
  files_parsed?: number;
  nodes: { total: number };
  edges: { total: number };
  duration_ms?: number;
  backend_connected?: boolean;
  graph_backend?: string;
}

export interface GraphQueryResult {
  query_type: string;
  total: number;
  results: Array<Record<string, unknown>>;
  stub?: boolean;
}

export interface GraphAugmentAddition {
  source_id: string;
  edge_type: string;
  target_id: string;
  target_name: string;
  confidence: number;
  rationale?: string;
}

export interface GraphAugmentResult {
  status: "ok" | "partial";
  written: number;
  skipped: number;
  edges?: unknown[];
  skip_details?: unknown[];
}

export interface GraphClientOptions {
  /**
   * MCP base URL (HTTP/SSE only):
   * - streamable HTTP: `http://host:3000/mcp`
   * - classic SSE: `http://host:3000/sse`
   * Prefer **stdio / embedded** on workers (no sidecar). Set GRAPH_MCP_URL only for
   * rare external graph servers.
   */
  baseUrl?: string;
  /**
   * - `stdio` / `embedded`: spawn `codesteward-mcp --transport stdio` in-process (default for workers)
   * - `http` / `sse` / `auto`: remote GRAPH_MCP_URL
   */
  transport?: "http" | "sse" | "stdio" | "embedded" | "auto";
  tenantId?: string;
  repoId?: string;
  mock?: boolean;
  fetchImpl?: typeof fetch;
  /** Override stdio command (default GRAPH_MCP_COMMAND or codesteward-mcp) */
  stdioCommand?: string;
}

export interface RepoScope {
  tenantId: string;
  repoId: string;
}
