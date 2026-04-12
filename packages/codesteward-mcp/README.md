# codesteward-mcp

MCP server that exposes a structural codebase graph as queryable tools for AI agents.

Depends on [`codesteward-graph`](https://pypi.org/project/codesteward-graph/) for parsing.
See the [full documentation and setup guide](https://github.com/bitkaio/codesteward-mcp).

## Quick start (zero install)

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all,graphqlite]",
        "codesteward-mcp", "--transport", "stdio"
      ]
    }
  }
}
```

GraphQLite is the default backend — an embedded SQLite graph database, no server
needed. The graph persists to `~/.codesteward/graph.db` across sessions.

## Install

```bash
# Core languages (TypeScript, JavaScript, Python, Java) + GraphQLite
uv pip install "codesteward-mcp[graph,graphqlite]"

# All 14 languages + GraphQLite
uv pip install "codesteward-mcp[graph-all,graphqlite]"

# Neo4j backend (alternative — requires a running Neo4j server)
uv pip install "codesteward-mcp[graph-all]"

# JanusGraph backend (alternative — requires a running JanusGraph server)
uv pip install "codesteward-mcp[graph-all,janusgraph]"
```

## Tools

| Tool | Description |
| ---- | ----------- |
| `graph_rebuild` | Parse a repository into the structural graph |
| `codebase_graph_query` | Query the graph (`lexical`, `referential`, `semantic`, `dependency`, raw Cypher/Gremlin) |
| `graph_augment` | Add agent-inferred relationships to the graph |
| `graph_status` | Return graph metadata (node/edge counts, last build time) |

## License

Apache License 2.0 — Copyright (c) 2026, bitkaio LLC
