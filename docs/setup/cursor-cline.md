# Cursor & Cline — Manual Setup

Both Cursor and Cline use the same MCP server config format. The only
difference is the config file location.

## Cursor

Add this to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

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

Reload the Cursor window (`Ctrl+Shift+P` → *Reload Window*).

### Per-project instructions

Cursor does not have a global instructions file. To tell Cursor to prefer
graph queries, add one of these to the project root:

```bash
# From the codesteward repo:
cp templates/.cursorrules /path/to/your/project/
# or for the newer format:
mkdir -p /path/to/your/project/.cursor/rules
cp templates/.cursorrules /path/to/your/project/.cursor/rules/codesteward.md
```

## Cline

Cline stores its MCP config in VS Code's globalStorage directory:

| Platform | Path |
| -------- | ---- |
| macOS | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Linux | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

Add this to `cline_mcp_settings.json`:

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

Changes take effect immediately — no restart needed.

### Cline MCP Marketplace

Cline can also install Codesteward from its built-in MCP Marketplace. Search
for "codesteward" and click Install — Cline's AI agent will read the
`llms-install.md` file and configure everything automatically.

### Per-project instructions

Cline reads `.clinerules` from the project root. To tell Cline to prefer
graph queries:

```bash
cp templates/.clinerules /path/to/your/project/
```

Cline also reads `.cursorrules`, `.windsurfrules`, and `AGENTS.md` — any of
the per-project instruction templates will work.
