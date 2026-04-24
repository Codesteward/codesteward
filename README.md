<p align="center">
  <img src="assets/codesteward-logo.png" alt="Codesteward" width="320" />
</p>

<p align="center">
  <a href="https://pypi.org/project/codesteward-mcp/"><img src="https://img.shields.io/pypi/v/codesteward-mcp?color=0078d4&label=codesteward-mcp" alt="PyPI codesteward-mcp"></a>
  <a href="https://pypi.org/project/codesteward-graph/"><img src="https://img.shields.io/pypi/v/codesteward-graph?color=00b4d8&label=codesteward-graph" alt="PyPI codesteward-graph"></a>
  <a href="https://github.com/bitkaio/codesteward/releases"><img src="https://img.shields.io/github/v/release/bitkaio/codesteward?color=1a1a2e&label=release" alt="GitHub Release"></a>
  <a href="https://pypi.org/project/codesteward-mcp/"><img src="https://img.shields.io/pypi/pyversions/codesteward-mcp" alt="Python Versions"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License"></a>
</p>

<p align="center">
  <strong>Structural code graph server for AI agents.</strong><br>
  Parse any repository into a queryable graph via tree-sitter AST — and expose it as an MCP tool interface your AI agent can call directly. Supports Neo4j, JanusGraph, or GraphQLite (embedded SQLite — zero setup for local dev).
</p>

---

## What it does

Codesteward parses your codebase into a persistent structural graph and exposes four [Model Context Protocol](https://modelcontextprotocol.io) tools that AI agents (Claude Code, Cursor, Windsurf, Copilot, …) can call to answer questions like:

- *"Which functions are protected by JWT auth?"*
- *"What does `process_payment` call, transitively?"*
- *"Which files depend on this external package?"*
- *"Is this route guarded by an auth middleware?"*

Rather than scanning files repeatedly, the agent queries a pre-built graph — cross-file relationships, call chains, auth guards, and dependency edges all resolved in a single query.

**Supported languages:** TypeScript · JavaScript · Python · Java · Go · Rust · PHP · C# · Kotlin · Scala · C · C++ · SQL *(context tagging)* · COBOL *(regex)*

## MCP Tools

| Tool | Description |
| ---- | ----------- |
| `graph_rebuild` | Parse a repository and write the structural graph to the configured backend (Neo4j, JanusGraph, or GraphQLite) or run in stub mode |
| `codebase_graph_query` | Query via named templates (`lexical`, `referential`, `semantic`, `dependency`) or raw passthrough (`cypher` / `gremlin`) |
| `graph_augment` | Add agent-inferred relationships (confidence < 1.0) back into the graph |
| `graph_status` | Return metadata: node/edge counts, last build time, Neo4j connectivity |
| `taint_analysis` | *(optional)* Run taint-flow analysis via the `codesteward-taint` binary and write `TAINT_FLOW` edges to Neo4j |

## Claude Code Plugin

The fastest way to use Codesteward with Claude Code is the official plugin — it wires up the MCP server and installs three focused skills (`/codesteward`, `/codesteward-security`, `/codesteward-deps`) in one command:

```bash
claude plugin add https://github.com/codesteward/codesteward-plugin
```

No separate server setup needed. The plugin auto-starts `codesteward-mcp` with the GraphQLite backend via `uvx`. See the **[codesteward-plugin](https://github.com/codesteward/codesteward-plugin)** for full details.

For other AI tools (Cursor, Cline, Codex, Gemini) or alternative backends (Neo4j, JanusGraph), use the Quick Start below.

---

## Quick Start

### Automatic setup (recommended)

One-time setup. Works across every repository on your machine without any per-project config.

```bash
uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp setup
```

This auto-detects your AI tools (Claude Code, Cursor, Cline, Codex CLI, Gemini CLI), registers the MCP server globally, and merges workflow instructions into your existing config files — nothing is overwritten.

Uses **GraphQLite** by default: an embedded SQLite graph that persists to `~/.codesteward/graph.db`. No Docker, no database server, no background processes.

To remove everything: `uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp setup --uninstall`

**Prerequisites:** [uv](https://docs.astral.sh/uv/) · *(optional)* [`codesteward-taint`](https://github.com/bitkaio/codesteward-taint/releases) on `PATH`

#### Usage — open any repo and start asking

```bash
cd /path/to/your/project
claude   # or: cursor, cline, codex, gemini
```

```text
# The agent will automatically:
graph_status(repo_id="my-project")
graph_rebuild(repo_path="/path/to/your/project", repo_id="my-project")   # if stale
codebase_graph_query(query_type="referential", query="authenticate", repo_id="my-project")
```

No `.mcp.json`, no per-project config, no repeated setup.

For manual per-tool setup, Docker deployments, and alternative backends (Neo4j, JanusGraph), see the **[setup guides](docs/setup/)**.

---

### Manual setup — GraphQLite (local dev, no server)

If you prefer to configure manually, add this to your MCP client config:

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "type": "stdio",
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all,graphqlite]",
        "codesteward-mcp", "--transport", "stdio"
      ]
    }
  }
}
```

> **Note:** Claude Code requires `"type": "stdio"` in the server config. Other tools
> (Cursor, Cline) don't need it.

| Tool | Config file |
| ---- | ----------- |
| Claude Code | `~/.claude.json` (under `mcpServers`) |
| Cursor | `~/.cursor/mcp.json` |
| Cline | `cline_mcp_settings.json` in VS Code globalStorage |
| Codex CLI | `~/.codex/config.yaml` (under `mcp_servers`) |
| Gemini CLI | `~/.gemini/settings.json` (under `mcpServers`) |

Requires [uv](https://docs.astral.sh/uv/). `uvx` downloads and caches the package on first run. The graph persists to `~/.codesteward/graph.db` across sessions.

### Docker + Neo4j — persistent graph

```bash
# 1. Point the server at your repository
export REPO_PATH=/path/to/your/repository

# 2. Start Neo4j + MCP server
docker compose -f docker-compose.neo4j.yml up -d

# 3. Copy config templates into the repo you want to analyse
cp templates/.mcp.json /path/to/your/repository/
cp templates/CLAUDE.md /path/to/your/repository/
```

The server runs at **`http://localhost:3000/sse`**. Call `graph_rebuild()` with no arguments — the server already knows the repo path from the volume mount.

### Docker + JanusGraph — persistent graph (Apache 2.0)

```bash
# 1. Point the server at your repository
export REPO_PATH=/path/to/your/repository

# 2. Start JanusGraph + MCP server
docker compose -f docker-compose.janusgraph.yml up -d

# 3. Copy config templates into the repo you want to analyse
cp templates/.mcp.json /path/to/your/repository/
cp templates/CLAUDE.md /path/to/your/repository/
```

Same workflow as the Neo4j stack — all named query templates work identically. Raw query passthrough uses Gremlin instead of Cypher.

### Manual Docker run

```bash
docker run -p 3000:3000 \
  -v /path/to/your/repo:/repos/project:ro \
  -e NEO4J_PASSWORD=secret \
  ghcr.io/bitkaio/codesteward-mcp:latest
```

For full setup instructions covering all AI tools, see the **[setup guides](docs/setup/)**.

## Installation

```bash
# All 14 languages + GraphQLite (recommended for local dev)
uv pip install "codesteward-mcp[graph-all,graphqlite]"

# Core languages only (TypeScript, JavaScript, Python, Java) + GraphQLite
uv pip install "codesteward-mcp[graph,graphqlite]"

# Individual language extras
uv pip install "codesteward-mcp[graph-go,graphqlite]"       # Go
uv pip install "codesteward-mcp[graph-rust,graphqlite]"     # Rust
uv pip install "codesteward-mcp[graph-csharp,graphqlite]"   # C#
uv pip install "codesteward-mcp[graph-kotlin,graphqlite]"   # Kotlin
uv pip install "codesteward-mcp[graph-scala,graphqlite]"    # Scala
uv pip install "codesteward-mcp[graph-c,graphqlite]"        # C
uv pip install "codesteward-mcp[graph-cpp,graphqlite]"      # C++
uv pip install "codesteward-mcp[graph-php,graphqlite]"      # PHP

# Neo4j backend (alternative — requires a running Neo4j 5+ server)
uv pip install "codesteward-mcp[graph-all]"

# JanusGraph backend (alternative — requires a running JanusGraph 1.0+ server)
uv pip install "codesteward-mcp[graph-all,janusgraph]"
```

Requires Python 3.12+. GraphQLite is the default backend for local development — an embedded SQLite graph database that requires no external services. The graph persists to `~/.codesteward/graph.db` across sessions.

## Configuration

All settings can be provided via environment variables, a YAML config file, or CLI flags.
Priority: **CLI flags > env vars > YAML file > defaults**.

| Setting | Env var | Default | Description |
| ------- | ------- | ------- | ----------- |
| Transport | `TRANSPORT` | `sse` | `sse`, `http`, or `stdio` |
| Host | `HOST` | `0.0.0.0` | HTTP bind host |
| Port | `PORT` | `3000` | HTTP bind port |
| Graph backend | `GRAPH_BACKEND` | `auto` | `auto`, `neo4j`, `janusgraph`, or `graphqlite`. Auto-detects: Neo4j if password set, JanusGraph if URL changed, otherwise GraphQLite |
| Neo4j URI | `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| Neo4j user | `NEO4J_USER` | `neo4j` | Neo4j username |
| Neo4j password | `NEO4J_PASSWORD` | *(empty)* | Set to enable Neo4j backend |
| JanusGraph URL | `JANUSGRAPH_URL` | `ws://localhost:8182/gremlin` | Gremlin Server WebSocket URL |
| GraphQLite DB path | `GRAPHQLITE_DB_PATH` | `~/.codesteward/graph.db` | SQLite database file path |
| Default tenant | `DEFAULT_TENANT_ID` | `local` | Tenant namespace |
| Default repo | `DEFAULT_REPO_ID` | *(empty)* | Repo ID |
| Default repo path | `DEFAULT_REPO_PATH` | `/repos/project` | Server-side path for `graph_rebuild` |
| Workspace | `WORKSPACE_BASE` | `workspace` | Directory for build metadata |
| Log level | `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |

## Taint Analysis (optional)

The `taint_analysis` tool is registered automatically when the `codesteward-taint` binary is on
`PATH`. Without it the server starts normally and the other four tools are unaffected.

### Docker

Pass `--build-arg TAINT_VERSION=<version>` to download and bundle the binary:

```bash
docker build --build-arg TAINT_VERSION=0.1.0 -t codesteward-mcp:taint .
```

### Standalone

Download a pre-built binary from the
[codesteward-taint releases](https://github.com/bitkaio/codesteward-taint/releases) and place it
on `PATH`:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/bitkaio/codesteward-taint/releases/latest/download/codesteward-taint-darwin-arm64 \
     -o /usr/local/bin/codesteward-taint
chmod +x /usr/local/bin/codesteward-taint
```

### Workflow

```text
graph_rebuild          # build the structural graph first
taint_analysis         # trace taint paths; writes TAINT_FLOW edges to Neo4j
codebase_graph_query   # query_type="semantic" to read findings
```

## Graph Model

### Nodes — `LexicalNode`

Every parsed symbol becomes a `LexicalNode`:

| Property | Description |
| -------- | ----------- |
| `node_id` | Stable unique ID: `{node_type}:{tenant_id}:{repo_id}:{file}:{name}` |
| `node_type` | `function`, `class`, `method`, `file`, `module`, `external` |
| `name` | Symbol name |
| `file` | Repo-relative file path |
| `line_start` / `line_end` | Source location |
| `language` | Detected language |
| `tenant_id` / `repo_id` | Multi-tenancy namespace |
| `confidence` | `1.0` for parser-emitted; `< 1.0` for agent-inferred |

### Edges

| Edge type | Meaning |
| --------- | ------- |
| `CALLS` | Function A calls function B (cross-file resolved) |
| `IMPORTS` | File/module imports another |
| `EXTENDS` | Class inherits from another |
| `GUARDED_BY` | Function protected by a decorator/annotation (`@login_required`, `@UseGuards`, FastAPI `Depends`, `@PreAuthorize`, …) |
| `PROTECTED_BY` | Function protected by router-scope middleware (`APIRouter`, Express `router.use()`, Gin group, Actix scope, Laravel route group, ASP.NET `MapGroup().RequireAuthorization()`) |
| `DEPENDS_ON` | File depends on an external package |
| `TAINT_FLOW` | Untrusted input reaches a dangerous sink (written by `codesteward-taint`; queryable via `semantic`) |
| `calls` / `guarded_by` / `taint_flow` / … | Agent-inferred edges with `confidence < 1.0` via `graph_augment` |

## Development

```bash
# Setup
uv venv && source .venv/bin/activate
uv sync --all-packages --extra graph-all

# Run tests
pytest tests/ -v

# Run the server locally
codesteward-mcp --transport sse --port 3000

# Lint + type-check
ruff check src/ tests/
mypy src/
```

## Releases

See [CHANGELOG.md](CHANGELOG.md) for the full history or browse [GitHub Releases](https://github.com/bitkaio/codesteward/releases).

## License

Apache License 2.0 — Copyright (c) 2026, bitkaio LLC
