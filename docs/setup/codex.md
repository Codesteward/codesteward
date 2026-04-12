# Codex CLI — Manual Setup

## 1. Register the MCP server globally

Add this to `~/.codex/config.yaml` (merge into your existing file):

```yaml
mcp_servers:
  codesteward-graph:
    command: uvx
    args:
      - "--from"
      - "codesteward-mcp[graph-all,graphqlite]"
      - "codesteward-mcp"
      - "--transport"
      - "stdio"
```

## 2. Add workflow instructions at `~/AGENTS.md`

Codex reads `AGENTS.md` from `~/AGENTS.md` (global), the repo root, and the
current directory in that order.

```bash
# From the codesteward repo:
cat templates/global-codex/AGENTS.md >> ~/AGENTS.md
```

Or use the setup command which merges idempotently:

```bash
uvx --from "codesteward-mcp[graph-all,graphqlite]" codesteward-mcp setup
```

## Usage

```bash
cd /path/to/your/project
codex
```

The agent will automatically derive `repo_id` from the directory name,
check `graph_status`, rebuild if needed, and prefer graph queries for
structural questions.
