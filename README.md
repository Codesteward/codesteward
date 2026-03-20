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
  Parse any repository into a queryable Neo4j graph via tree-sitter AST — and expose it as an MCP tool interface your AI agent can call directly.
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
| `graph_rebuild` | Parse a repository and write the structural graph to Neo4j (or run in stub mode without Neo4j) |
| `codebase_graph_query` | Query via named templates (`lexical`, `referential`, `semantic`, `dependency`) or raw Cypher |
| `graph_augment` | Add agent-inferred relationships (confidence < 1.0) back into the graph |
| `graph_status` | Return metadata: node/edge counts, last build time, Neo4j connectivity |
| `taint_analysis` | *(optional)* Run taint-flow analysis via the `codesteward-taint` binary and write `TAINT_FLOW` edges to Neo4j |

## Quick Start

### Zero-install — stdio via uvx

No Docker, no Neo4j, no pre-install. Add this to your MCP client config (Claude Code, Cursor, Windsurf, etc.):

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

Requires [uv](https://docs.astral.sh/uv/). `uvx` downloads and caches the package on first run. The graph is rebuilt each session (no Neo4j persistence).

### Docker + Neo4j — persistent graph

```bash
# 1. Point the server at your repository
export REPO_PATH=/path/to/your/repository

# 2. Start Neo4j + MCP server
docker compose up -d

# 3. Copy config templates into the repo you want to analyse
cp templates/.mcp.json /path/to/your/repository/
cp templates/CLAUDE.md /path/to/your/repository/
```

The server runs at **`http://localhost:3000/sse`**. Call `graph_rebuild()` with no arguments — the server already knows the repo path from the volume mount.

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
```

Requires Python 3.12+. Neo4j 5+ is optional — the server runs in stub mode without it.

## Configuration

All settings can be provided via environment variables, a YAML config file, or CLI flags.
Priority: **CLI flags > env vars > YAML file > defaults**.

| Setting | Env var | Default | Description |
| ------- | ------- | ------- | ----------- |
| Transport | `TRANSPORT` | `sse` | `sse`, `http`, or `stdio` |
| Host | `HOST` | `0.0.0.0` | HTTP bind host |
| Port | `PORT` | `3000` | HTTP bind port |
| Neo4j URI | `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| Neo4j user | `NEO4J_USER` | `neo4j` | Neo4j username |
| Neo4j password | `NEO4J_PASSWORD` | *(empty)* | Leave empty for stub mode |
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
uv sync --all-packages --extra graph

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
