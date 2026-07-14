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
   * MCP base URL:
   * - streamable HTTP: `http://host:3000/mcp`
   * - classic SSE: `http://host:3000/sse`
   * With transport `auto`, `/mcp` is probed first; 404 falls back to SSE.
   */
  baseUrl?: string;
  /** Default `auto` — detect streamable HTTP vs classic SSE. */
  transport?: "http" | "sse" | "stdio" | "auto";
  tenantId?: string;
  repoId?: string;
  mock?: boolean;
  fetchImpl?: typeof fetch;
}

export interface RepoScope {
  tenantId: string;
  repoId: string;
}
