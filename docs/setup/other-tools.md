# Windsurf, VS Code / Copilot, Claude Desktop — Manual Setup

These tools are not yet supported by the `codesteward-mcp setup` command.
Configure them manually using the instructions below.

## Windsurf

1. Open **Windsurf Settings** → **MCP Servers**
2. Click **Add Server** and enter:
   - Name: `codesteward-graph`
   - Type: `stdio`
   - Command: `uvx`
   - Args: `--from codesteward-mcp[graph-all,graphqlite] codesteward-mcp --transport stdio`
3. Save and reload the window.

### Per-project instructions

```bash
cp templates/.windsurfrules /path/to/your/project/
```

## VS Code — GitHub Copilot

Add this to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
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

VS Code will prompt you to enable the server. Accept and reload.

### Per-project instructions

```bash
mkdir -p .github
cp templates/copilot-instructions.md .github/copilot-instructions.md
```

## Claude Desktop

Add this to the Claude Desktop config file:

| Platform | Path |
| -------- | ---- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

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

Restart Claude Desktop after saving.

## Continue.dev

Add this to `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "codesteward-graph",
      "transport": {
        "type": "stdio",
        "command": "uvx",
        "args": [
          "--from", "codesteward-mcp[graph-all,graphqlite]",
          "codesteward-mcp", "--transport", "stdio"
        ]
      }
    }
  ]
}
```
