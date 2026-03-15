# Codesteward MCP Graph Server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that parses source code into a structural graph and exposes it as queryable tools for AI agents and IDE extensions.

Supports **14 languages** via tree-sitter AST parsing: TypeScript, JavaScript, Python, Java, Go, Rust, PHP, C#, Kotlin, Scala, C, C++, and SQL context tagging. COBOL is parsed with a lightweight regex-based parser — no tree-sitter grammar is available for it.

## Tools

| Tool | Description |
| ---- | ----------- |
| `graph_rebuild` | Parse a repository and write the structural graph to Neo4j (or stub mode without Neo4j) |
| `codebase_graph_query` | Query the graph via named templates (`lexical`, `referential`, `semantic`, `dependency`) or raw Cypher |
| `graph_augment` | Add agent-inferred relationships (confidence < 1.0) to the graph |
| `graph_status` | Return metadata about the current graph: node/edge counts, last build time, Neo4j connectivity |

## Quick Start

### Zero-install (stdio via uvx)

No Docker, no Neo4j, no pre-install.  Add this to your MCP client config
(Claude Code, Cursor, Windsurf, etc.):

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

Requires [uv](https://docs.astral.sh/uv/).  `uvx` downloads and caches the
package on first run.  The graph is re-built each session (no Neo4j persistence).

### Docker + Neo4j (persistent graph)

```bash
# 1. Point the server at your repository
export REPO_PATH=/path/to/your/repository    # or add to .env

# 2. Start Neo4j + MCP server
docker compose up -d

# 3. Copy config files into the repo you want to analyse
cp templates/.mcp.json /path/to/your/repository/
cp templates/CLAUDE.md /path/to/your/repository/
```

The server runs at **`http://localhost:3000/sse`**.  Call `graph_rebuild()` with
no arguments — the server already knows the repo path from the volume mount.

### Manual Docker run

```bash
docker run -p 3000:3000 \
  -v /path/to/your/repo:/repos/project:ro \
  -e NEO4J_PASSWORD=secret \
  ghcr.io/bitkaio/codesteward-mcp:latest
```

For full setup instructions covering Claude Code, Cursor, Windsurf, Gemini CLI,
VS Code / GitHub Copilot, Continue.dev, and Claude Desktop, see
**[AGENT_SETUP.md](AGENT_SETUP.md)**.

## Installation

### Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- Neo4j 5+ (optional — runs in stub mode without it)

### Install options

```bash
# Core languages (TypeScript, JavaScript, Python, Java)
uv pip install -e ".[graph]"

# All 14 languages
uv pip install -e ".[graph-all]"

# Individual language extras
uv pip install -e ".[graph-go]"       # Go
uv pip install -e ".[graph-rust]"     # Rust
uv pip install -e ".[graph-csharp]"   # C#
uv pip install -e ".[graph-kotlin]"   # Kotlin
uv pip install -e ".[graph-scala]"    # Scala
uv pip install -e ".[graph-c]"        # C
uv pip install -e ".[graph-cpp]"      # C++
uv pip install -e ".[graph-php]"      # PHP

# No tree-sitter (regex fallback only, no native deps)
uv pip install -e "."
```

## Configuration

All settings can be provided via environment variables, a YAML config file, or CLI flags. Priority: **CLI flags > env vars > YAML file > defaults**.

| Setting | Env var | Default | Description |
| ------- | ------- | ------- | ----------- |
| Transport | `TRANSPORT` | `sse` | `sse`, `http`, or `stdio` |
| Host | `HOST` | `0.0.0.0` | HTTP bind host |
| Port | `PORT` | `3000` | HTTP bind port |
| Neo4j URI | `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| Neo4j user | `NEO4J_USER` | `neo4j` | Neo4j username |
| Neo4j password | `NEO4J_PASSWORD` | _(empty)_ | Neo4j password — **required to enable Neo4j** |
| Default tenant | `DEFAULT_TENANT_ID` | `local` | Tenant namespace used when tools omit `tenant_id` |
| Default repo | `DEFAULT_REPO_ID` | _(empty)_ | Repo ID used when tools omit `repo_id` |
| Default repo path | `DEFAULT_REPO_PATH` | `/repos/project` | Server-side path used when `graph_rebuild` is called without `repo_path` |
| Workspace | `WORKSPACE_BASE` | `workspace` | Directory for build metadata |
| Log level | `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |

## Graph Model

### Nodes — `LexicalNode`

Every parsed symbol is stored as a `LexicalNode` with properties:

| Property | Description |
| -------- | ----------- |
| `node_id` | Stable unique ID: `{node_type}:{tenant_id}:{repo_id}:{file}:{name}` |
| `node_type` | `function`, `class`, `method`, `file`, `module`, `external` |
| `name` | Symbol name |
| `file` | Repo-relative file path |
| `line_start` / `line_end` | Source location |
| `language` | Detected language |
| `tenant_id` / `repo_id` | Multi-tenancy namespace |
| `confidence` | `1.0` for parser-emitted nodes; `< 1.0` for agent-inferred |

### Edges

| Edge type | Emitted by | Meaning |
| --------- | ---------- | ------- |
| `CALLS` | Parser | Function A calls function B |
| `IMPORTS` | Parser | File/module imports another |
| `EXTENDS` | Parser | Class inherits from another |
| `GUARDED_BY` | Parser | Function is protected by a decorator/annotation (e.g. `@login_required`, `@UseGuards`, `@PreAuthorize`, FastAPI `Depends`) |
| `PROTECTED_BY` | Parser | Function is protected by router-scope middleware (`APIRouter`, Express `router.use()`, Gin group, Actix scope, Laravel route group, ASP.NET `MapGroup().RequireAuthorization()`) |
| `DEPENDS_ON` | Parser | File depends on an external package |
| `DATA_FLOW` | Parser | Data flows from one node to another |
| `calls` / `guarded_by` etc. | `graph_augment` | Agent-inferred edges (confidence < 1.0) |

### Auth guard edge types

`GUARDED_BY` and `PROTECTED_BY` are the two mechanism for representing auth guards:

- **`GUARDED_BY`** — the guard is applied directly to the function (Python decorator, TypeScript/Java annotation, FastAPI `Depends`)
- **`PROTECTED_BY`** — the guard is applied at the router/group scope above the function (FastAPI `APIRouter(dependencies=[...])`, Express `router.use()`, Gin `group.Use()`, Actix `scope().wrap()`, Laravel `Route::middleware()->group()`, ASP.NET `MapGroup().RequireAuthorization()`)

## Development

```bash
# Setup
uv venv && source .venv/bin/activate
uv pip install -e ".[graph,dev]"

# Run tests
pytest tests/ -v

# Run the server locally
codesteward-mcp --transport http --port 3000

# Lint + type-check
ruff check src/ tests/
mypy src/
```

## License

BSD 3-Clause License — Copyright (c) 2026, bitkaio LLC
