# Setting Up Codesteward Graph

## Automatic setup (recommended)

One command. Detects your AI tools, registers the MCP server, merges workflow
instructions — nothing is overwritten.

```bash
uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp setup
```

Uses **GraphQLite** by default: an embedded SQLite graph that persists to
`~/.codesteward/graph.db`. No Docker, no database server.

To remove everything:

```bash
uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp setup --uninstall
```

### What it does

The setup command:

1. Detects which AI tools you have installed
2. Registers the `codesteward-graph` MCP server in each tool's global config
3. Merges graph-first workflow instructions into `~/.claude/CLAUDE.md` and
   `~/AGENTS.md` (Claude Code / Codex) — idempotent, safe to re-run
4. Installs the `/codesteward` skill for Claude Code

### Supported tools

| Tool | Config file | Instructions file |
| ---- | ----------- | ----------------- |
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/mcp.json` | — |
| Cline | `cline_mcp_settings.json` (VS Code globalStorage) | — |
| Gemini CLI | `~/.gemini/settings.json` | — |
| Codex CLI | `~/.codex/config.yaml` | `~/AGENTS.md` |

### Alternative backends

```bash
# Neo4j (requires a running Neo4j 5+ server)
uvx --from "codesteward-mcp[graph-all]" codesteward-mcp setup --backend neo4j

# JanusGraph (requires a running JanusGraph 1.0+ server)
uvx --from "codesteward-mcp[graph-all,janusgraph]" codesteward-mcp setup --backend janusgraph
```

---

## Manual setup guides

If you prefer to configure manually, or need per-tool details:

- [Claude Code](claude-code.md)
- [Cursor & Cline](cursor-cline.md)
- [Codex CLI](codex.md)
- [Gemini CLI](gemini.md)
- [Windsurf, VS Code / Copilot, Claude Desktop](other-tools.md)
- [Docker (Neo4j / JanusGraph)](docker.md)

---

## Enabling taint analysis (optional)

Place the [`codesteward-taint`](https://github.com/bitkaio/codesteward-taint/releases)
binary anywhere on your `PATH`:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/bitkaio/codesteward-taint/releases/latest/download/codesteward-taint-darwin-arm64 \
     -o /usr/local/bin/codesteward-taint
chmod +x /usr/local/bin/codesteward-taint
```

The MCP server detects the binary at startup and registers `taint_analysis`
automatically.
