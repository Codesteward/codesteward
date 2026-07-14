import type {
  GraphAugmentResult,
  GraphQueryResult,
  GraphQueryType,
  GraphRebuildResult,
  GraphStatus,
  RepoScope,
} from "./types.js";

export function mockStatus(_scope: RepoScope): GraphStatus {
  return {
    backend_connected: true,
    graph_backend: "mock",
    last_build: new Date().toISOString(),
    nodes: { total: 42 },
    edges: { total: 100 },
    stub: true,
  };
}

export function mockRebuild(_scope: RepoScope): GraphRebuildResult {
  return {
    mode: "full",
    files_parsed: 10,
    nodes: { total: 42 },
    edges: { total: 100 },
    duration_ms: 5,
    backend_connected: true,
    graph_backend: "mock",
  };
}

export function mockQuery(
  queryType: GraphQueryType,
  query: string,
  _scope: RepoScope,
): GraphQueryResult {
  return {
    query_type: queryType,
    total: query ? 1 : 0,
    results: query
      ? [
          {
            node_id: `function:local:demo:src/example.ts:${query || "example"}`,
            type: "function",
            name: query || "example",
            file: "src/example.ts",
            line_start: 1,
            line_end: 20,
            language: "typescript",
          },
        ]
      : [],
    stub: true,
  };
}

export function mockAugment(count: number): GraphAugmentResult {
  return { status: "ok", written: count, skipped: 0, edges: [] };
}
