<p align="center">
  <img src="assets/codesteward-logo.png" alt="Codesteward" width="320" />
</p>

<p align="center">
  <a href="https://pypi.org/project/codesteward-mcp/"><img src="https://img.shields.io/pypi/v/codesteward-mcp?color=0078d4&label=codesteward-mcp" alt="PyPI codesteward-mcp"></a>
  <a href="https://pypi.org/project/codesteward-graph/"><img src="https://img.shields.io/pypi/v/codesteward-graph?color=00b4d8&label=codesteward-graph" alt="PyPI codesteward-graph"></a>
  <a href="https://github.com/bitkaio/codesteward/releases"><img src="https://img.shields.io/github/v/release/bitkaio/codesteward?color=1a1a2e&label=release" alt="GitHub Release"></a>
  <a href="https://pypi.org/project/codesteward-mcp/"><img src="https://img.shields.io/pypi/pyversions/codesteward-mcp" alt="Python Versions"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD%203--Clause-blue" alt="License"></a>
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

## Quick Start

### Global setup — recommended for local development

One-time setup. Works across every repository on your machine without any per-project config.
Supports **Claude Code** and **OpenAI Codex CLI**.

**Prerequisites:** [uv](https://docs.astral.sh/uv/) · A graph backend: Neo4j 5+, JanusGraph 1.0+, or GraphQLite (no server needed) · *(optional)* `codesteward-taint` on `PATH`

#### Claude Code

**1. Register the MCP server globally in `~/.claude/settings.json`**

Merge this into your existing file (or create it):

```json
{
  "mcpServers": {
    "codesteward": {
      "command": "uvx",
      "args": ["codesteward-mcp[graph-all]", "--transport", "stdio"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "your-neo4j-password"
      }
    }
  }
}
```

Claude Code spawns the MCP server as a subprocess — no Docker, no volume mounts, no separate process to manage. `uvx` downloads and caches the package on first run. Neo4j credentials are passed as env vars; omit them to run in stub mode (no persistence).

**JanusGraph alternative** — replace the `env` block above with:

```json
      "env": {
        "GRAPH_BACKEND": "janusgraph",
        "JANUSGRAPH_URL": "ws://localhost:8182/gremlin"
      }
```

Add `janusgraph` to the extras: `"codesteward-mcp[graph-all,janusgraph]"`.

**GraphQLite alternative (embedded — no server needed)** — the simplest option for local dev. Replace the `env` block with:

```json
      "env": {
        "GRAPH_BACKEND": "graphqlite"
      }
```

Add `graphqlite` to the extras: `"codesteward-mcp[graph-all,graphqlite]"`. The graph persists to `~/.codesteward/graph.db` by default; set `GRAPHQLITE_DB_PATH` to override. No Docker, no database server — just `uvx` and go.

**2. Add the global instruction file at `~/.claude/CLAUDE.md`**

```bash
cp templates/global-claude-code/CLAUDE.md ~/.claude/CLAUDE.md
```

This file is loaded into every Claude Code session automatically. It tells Claude to derive `repo_id` from the current directory, check whether the graph is fresh, rebuild if needed, and prefer graph queries over file reads for structural questions.

**3. *(Optional)* Add the `/codesteward` skill**

```bash
mkdir -p ~/.claude/skills
cp templates/global-claude-code/codesteward-skill.md ~/.claude/skills/codesteward.md
```

Type `/codesteward` in any session for an explicit guided workflow (rebuild → query → taint scan). The graph-first preference from `~/.claude/CLAUDE.md` applies automatically without invoking the skill.

#### OpenAI Codex CLI

**1. Register the MCP server globally in `~/.codex/config.yaml`**

Merge this into your existing file (or create it):

```yaml
mcp_servers:
  codesteward:
    command: uvx
    args:
      - "codesteward-mcp[graph-all]"
      - "--transport"
      - "stdio"
    env:
      NEO4J_URI: "bolt://localhost:7687"
      NEO4J_USER: "neo4j"
      NEO4J_PASSWORD: "your-neo4j-password"
```

For JanusGraph, replace the `env` block with `GRAPH_BACKEND: "janusgraph"` and `JANUSGRAPH_URL: "ws://localhost:8182/gremlin"`, and add the `janusgraph` extra to the args. For GraphQLite (no server), use `GRAPH_BACKEND: "graphqlite"` and add the `graphqlite` extra.

**2. Add the global instruction file at `~/AGENTS.md`**

```bash
cp templates/global-codex/AGENTS.md ~/AGENTS.md
```

Codex reads `AGENTS.md` from `~/AGENTS.md` (global), the repo root, and the current directory in that order. The global file gives Codex the same graph-first workflow instructions as Claude Code.

#### Shared: enable taint analysis (optional)

Place the [`codesteward-taint`](https://github.com/bitkaio/codesteward-taint/releases) binary anywhere on your `PATH`:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/bitkaio/codesteward-taint/releases/latest/download/codesteward-taint-darwin-arm64 \
     -o /usr/local/bin/codesteward-taint
chmod +x /usr/local/bin/codesteward-taint
```

The MCP server detects the binary at startup and registers `taint_analysis` automatically — for both clients.

#### Usage — open any repo and start asking

```bash
cd /repos/serving-api
claude   # or: codex
```

```text
# The agent will automatically:
graph_status(repo_id="serving-api")
graph_rebuild(repo_path="/repos/serving-api", repo_id="serving-api")   # if stale
codebase_graph_query(query_type="referential", query="authenticate", repo_id="serving-api")
```

No `.mcp.json`, no per-project `CLAUDE.md` / `AGENTS.md`, no repeated configuration.

---

### Zero-install — stdio via uvx with GraphQLite (persistent, no server)

No Docker, no database server, no pre-install. Add this to your MCP client config (Claude Code, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": ["codesteward-mcp[graph-all,graphqlite]", "--transport", "stdio"],
      "env": {
        "GRAPH_BACKEND": "graphqlite"
      }
    }
  }
}
```

Requires [uv](https://docs.astral.sh/uv/). `uvx` downloads and caches the package on first run. The graph persists to `~/.codesteward/graph.db` across sessions — no database server needed.

To run without any persistence (stub mode), omit `graphqlite` from the extras and the `env` block entirely.

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

For full setup instructions covering Claude Code, Cursor, Windsurf, Gemini CLI, VS Code / GitHub Copilot, Continue.dev, and Claude Desktop, see **[AGENT_SETUP.md](AGENT_SETUP.md)**.

## Installation

```bash
# Core languages (TypeScript, JavaScript, Python, Java)
uv pip install "codesteward-mcp[graph]"

# All 14 languages
uv pip install "codesteward-mcp[graph-all]"

# Individual language extras
uv pip install "codesteward-mcp[graph-go]"       # Go
uv pip install "codesteward-mcp[graph-rust]"     # Rust
uv pip install "codesteward-mcp[graph-csharp]"   # C#
uv pip install "codesteward-mcp[graph-kotlin]"   # Kotlin
uv pip install "codesteward-mcp[graph-scala]"    # Scala
uv pip install "codesteward-mcp[graph-c]"        # C
uv pip install "codesteward-mcp[graph-cpp]"      # C++
uv pip install "codesteward-mcp[graph-php]"      # PHP

# JanusGraph backend (alternative to Neo4j)
uv pip install "codesteward-mcp[graph-all,janusgraph]"

# GraphQLite backend (embedded SQLite — no server needed)
uv pip install "codesteward-mcp[graph-all,graphqlite]"
```

Requires Python 3.12+. A graph backend (Neo4j 5+, JanusGraph 1.0+, or GraphQLite) is optional — the server runs in stub mode without one. GraphQLite is recommended for local development as it requires no external services.

## Configuration

All settings can be provided via environment variables, a YAML config file, or CLI flags.
Priority: **CLI flags > env vars > YAML file > defaults**.

| Setting | Env var | Default | Description |
| ------- | ------- | ------- | ----------- |
| Transport | `TRANSPORT` | `sse` | `sse`, `http`, or `stdio` |
| Host | `HOST` | `0.0.0.0` | HTTP bind host |
| Port | `PORT` | `3000` | HTTP bind port |
| Graph backend | `GRAPH_BACKEND` | `neo4j` | `neo4j`, `janusgraph`, or `graphqlite` |
| Neo4j URI | `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| Neo4j user | `NEO4J_USER` | `neo4j` | Neo4j username |
| Neo4j password | `NEO4J_PASSWORD` | *(empty)* | Leave empty for stub mode |
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

BSD 3-Clause License — Copyright (c) 2026, bitkaio LLC
