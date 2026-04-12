# Gemini CLI — Manual Setup

## 1. Register the MCP server globally

Add this to `~/.gemini/settings.json`:

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

The server will be available in all Gemini CLI sessions.

## 2. Per-project instructions

Gemini CLI reads `GEMINI.md` from the project root:

```bash
cp templates/GEMINI.md /path/to/your/project/
```

## Usage

```bash
cd /path/to/your/project
gemini
```
