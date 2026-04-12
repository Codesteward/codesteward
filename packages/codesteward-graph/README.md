# codesteward-graph

Multi-language structural code graph builder — parses source repositories into
`LexicalNode` + edge data and writes to Neo4j or JanusGraph.

Part of the [Codesteward MCP](https://github.com/bitkaio/codesteward-mcp) project.
For full documentation, setup guides, and the MCP server, see the main repository.

## What it does

- Parses 13 languages via tree-sitter AST (TypeScript, JavaScript, Python, Java, Go,
  Rust, PHP, C#, Kotlin, Scala, C, C++); COBOL via regex
- Extracts functions, classes, imports, call graphs, inheritance chains, and auth guard
  annotations (`GUARDED_BY` / `PROTECTED_BY` edges)
- Resolves cross-file call relationships in a single post-parse pass
- Writes to Neo4j or JanusGraph with tenant + repo namespacing; operates in stub mode
  without a graph backend

## Install

```bash
# Core languages (TypeScript, JavaScript, Python, Java)
uv add "codesteward-graph[graph]"

# All 14 languages
uv add "codesteward-graph[graph-all]"

# JanusGraph backend (alternative to Neo4j)
uv add "codesteward-graph[janusgraph]"

# Without tree-sitter (COBOL only; all other parsers will raise ImportError)
uv add codesteward-graph
```

## Quick usage

```python
import asyncio
from codesteward.engine.graph_builder import GraphBuilder

async def main():
    builder = GraphBuilder()          # stub mode — no graph backend
    summary = await builder.build_graph(
        repo_path="/path/to/repo",
        tenant_id="local",
        repo_id="my-repo",
    )
    print(summary)

asyncio.run(main())
```

## License

BSD 3-Clause — Copyright (c) 2026, bitkaio LLC
