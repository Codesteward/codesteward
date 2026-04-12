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
      "args": ["codesteward-mcp[graph-all]", "--transport", "stdio"]
    }
  }
}
```

## Install

```bash
# Core languages (TypeScript, JavaScript, Python, Java)
uv pip install "codesteward-mcp[graph]"

# All 14 languages
uv pip install "codesteward-mcp[graph-all]"

# JanusGraph backend (alternative to Neo4j)
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

BSD 3-Clause License — Copyright (c) 2026, bitkaio LLC
