# Claude Code — Manual Setup

## 1. Register the MCP server globally

Add this to `~/.claude/settings.json` (merge into your existing file):

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

Claude Code spawns the MCP server as a subprocess — no Docker, no volume
mounts, no separate process to manage. `uvx` downloads and caches the
package on first run.

### Alternative backends

**Neo4j** — replace the entry above with:

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all]",
        "codesteward-mcp", "--transport", "stdio"
      ],
      "env": {
        "GRAPH_BACKEND": "neo4j",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "your-password"
      }
    }
  }
}
```

**JanusGraph** — replace the entry above with:

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all,janusgraph]",
        "codesteward-mcp", "--transport", "stdio"
      ],
      "env": {
        "GRAPH_BACKEND": "janusgraph",
        "JANUSGRAPH_URL": "ws://localhost:8182/gremlin"
      }
    }
  }
}
```

## 2. Add workflow instructions to `~/.claude/CLAUDE.md`

Append the following to your existing `~/.claude/CLAUDE.md` (do not replace
the entire file if you already have other instructions):

```bash
# From the codesteward repo:
cat templates/global-claude-code/CLAUDE.md >> ~/.claude/CLAUDE.md
```

Or use the setup command which merges idempotently:

```bash
uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp setup
```

## 3. (Optional) Install the `/codesteward` skill

```bash
mkdir -p ~/.claude/skills
cp templates/global-claude-code/codesteward-skill.md ~/.claude/skills/codesteward.md
```

Type `/codesteward` in any session for a guided workflow (rebuild, query,
taint scan).

## Usage

```bash
cd /path/to/your/project
claude
```

The agent will automatically derive `repo_id` from the directory name,
check `graph_status`, rebuild if needed, and prefer graph queries for
structural questions.
