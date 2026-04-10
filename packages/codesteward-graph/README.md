# codesteward-graph

Multi-language structural code graph builder — parses source repositories into
`LexicalNode` + edge data and writes to Neo4j.

Part of the [Codesteward MCP](https://github.com/bitkaio/codesteward-mcp) project.
For full documentation, setup guides, and the MCP server, see the main repository.

## What it does

- Parses 13 languages via tree-sitter AST (TypeScript, JavaScript, Python, Java, Go,
  Rust, PHP, C#, Kotlin, Scala, C, C++); COBOL via regex
- Extracts functions, classes, imports, call graphs, inheritance chains, and auth guard
  annotations (`GUARDED_BY` / `PROTECTED_BY` edges)
- Resolves cross-file call relationships in a single post-parse pass
- Writes to Neo4j with tenant + repo namespacing; operates in stub mode without Neo4j

## Install

```bash
# Core languages (TypeScript, JavaScript, Python, Java)
uv add "codesteward-graph[graph]"

# All 14 languages
uv add "codesteward-graph[graph-all]"

# Without tree-sitter (COBOL only; all other parsers will raise ImportError)
uv add codesteward-graph
```

## Quick usage

```python
import asyncio
from codesteward.engine.graph_builder import GraphBuilder

async def main():
    builder = GraphBuilder()          # stub mode — no Neo4j
    summary = await builder.build_graph(
        repo_path="/path/to/repo",
        tenant_id="local",
        repo_id="my-repo",
    )
    print(summary)

asyncio.run(main())
```

## Ignoring files and directories

By default, the graph builder skips common build artifacts and cache directories
(`node_modules`, `dist`, `.venv`, `target`, etc.).

For project-specific exclusions, place a `.codestewardignore` file in the root of
the repository being analyzed. It uses the same gitignore pattern syntax:

```gitignore
# Exclude generated files
**/*.generated.ts

# Exclude an entire directory
internal/

# Exclude specific paths
src/fixtures/large-dataset.py
```

The file is optional — if absent, only the built-in blocklist applies.

## License

BSD 3-Clause — Copyright (c) 2026, bitkaio LLC
