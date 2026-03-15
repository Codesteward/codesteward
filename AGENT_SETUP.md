# Setting Up AI Tools with Codesteward Graph

This guide covers how to connect Codesteward's MCP graph server to your AI
coding tool so it uses structural graph queries instead of reading files
individually.

## How it works

Every MCP-compatible AI tool needs two things:

1. **An MCP server config** — a JSON file that tells the tool where the server
   is running.  The format is the same across all tools; only the file location
   differs.
2. **Project instructions** — a text file in the repository that tells the
   agent to prefer graph tools for structural questions.  Without this, the
   agent may fall back to reading files even though the graph server is
   connected.

Both files are in the `templates/` directory.  Copy the right ones for your
tool and drop them into the root of the repository you want to analyse.

---

## Choosing a transport

**HTTP (Docker — recommended for most users)**
The server runs as a persistent process. All tools connect to `http://localhost:3000/sse`.
Neo4j is included in the Docker setup for persistent graph storage.

**Stdio (uvx — zero install, no Docker)**
The MCP client starts the server as a subprocess on demand.
No Docker, no Neo4j, no background process — the graph is re-built each session (stub mode).
Install once with `uv` and add this to any client config:

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

Use HTTP+Docker when you want persistent graph storage across sessions and full
Neo4j query support.  Use stdio+uvx when you just want structural parsing without
managing any infrastructure.

---

## Step 1 — Start the server

```bash
# Set the path to the repository you want to analyse
export REPO_PATH=/path/to/your/repository      # macOS / Linux
set REPO_PATH=C:\path\to\your\repo             # Windows CMD
$env:REPO_PATH = "C:\path\to\your\repo"        # PowerShell

# Or create a .env file in the codesteward-mcp directory:
echo "REPO_PATH=/path/to/your/repository" > .env

# Start Neo4j + MCP server
docker compose up -d
```

The server starts at **`http://localhost:3000/sse`**.  It already knows the
repository path — tools call `graph_rebuild()` with no arguments.

---

## Step 2 — Connect your AI tool

### Claude Code

Claude Code reads `.mcp.json` from the **project root** automatically.  No
global config changes are needed.

```bash
# Inside the repository you want to analyse:
cp /path/to/codesteward-mcp/templates/.mcp.json .
```

Restart Claude Code (or open a new session) — the `codesteward-graph` server
will appear in the tool list.

**Global alternative** (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

---

### Cursor

Cursor reads MCP servers from `.cursor/mcp.json` in the **project root**
(project-scoped) or `~/.cursor/mcp.json` (global).

```bash
# Inside the repository you want to analyse:
mkdir -p .cursor
cp /path/to/codesteward-mcp/templates/cursor/mcp.json .cursor/mcp.json
```

Reload the Cursor window (`Ctrl+Shift+P` → *Reload Window*).

**Global alternative** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

---

### Windsurf

Windsurf reads MCP servers from the **Windsurf settings panel**.

1. Open **Windsurf Settings** → **MCP Servers**
2. Click **Add Server** and enter:
   - Name: `codesteward-graph`
   - Type: `HTTP`
   - URL: `http://localhost:3000/sse`
3. Click **Save** and reload the window.

Alternatively, if your Windsurf version supports a project-level config, create
`.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

---

### VS Code — GitHub Copilot

VS Code reads MCP servers from `.vscode/mcp.json` in the **workspace root**.

```bash
# Inside the repository you want to analyse:
mkdir -p .vscode
cp /path/to/codesteward-mcp/templates/vscode/mcp.json .vscode/mcp.json
```

VS Code will prompt you to enable the server.  Accept, then reload the window.

**Global alternative** (`settings.json`):

```json
{
  "mcp.servers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

---

### Gemini CLI

The Gemini CLI reads MCP servers from `~/.gemini/settings.json` (global only —
no project-level config as of Gemini CLI 1.x).

Add the server to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

The server will be available in all Gemini CLI sessions.

---

### Continue.dev

Continue reads MCP servers from `~/.continue/config.json` (global) or the
workspace-level `.continue/config.json`.

```json
{
  "mcpServers": [
    {
      "name": "codesteward-graph",
      "transport": {
        "type": "sse",
        "url": "http://localhost:3000/sse"
      }
    }
  ]
}
```

Restart the Continue extension after saving.

---

### Claude Desktop

Claude Desktop reads MCP servers from a global config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

Restart Claude Desktop after saving.

---

### Stdio transport — uvx (zero install, any tool)

The simplest option: no Docker, no Neo4j, no pre-install.
`uvx` downloads and caches the package on first run.

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

**Requires:** [uv](https://docs.astral.sh/uv/) installed on the system.
Works on macOS, Linux, and Windows.  The graph is re-built each session (no
Neo4j persistence), which is fine for most structural analysis tasks.

For a persistent graph across sessions, switch to the HTTP+Docker setup.

**Manual install alternative** (if `uvx` is not available):

```bash
uv pip install "codesteward-mcp[graph-all]"
# then use "command": "codesteward-mcp" in the config above
```

---

## Step 3 — Add project instructions

Connecting the MCP server makes the tools *available*, but the agent may still
reach for `grep` or file reads for structural questions unless you tell it
otherwise.  Add the appropriate instructions file to the root of the repository
you are analysing.

### Claude Code — `CLAUDE.md`

```bash
cp /path/to/codesteward-mcp/templates/CLAUDE.md .
# or append to an existing CLAUDE.md:
cat /path/to/codesteward-mcp/templates/CLAUDE.md >> CLAUDE.md
```

Claude Code reads `CLAUDE.md` from the project root on every session.

---

### Cursor — `.cursorrules`

```bash
cp /path/to/codesteward-mcp/templates/.cursorrules .
# or append to an existing .cursorrules:
cat /path/to/codesteward-mcp/templates/.cursorrules >> .cursorrules
```

Cursor also supports the newer `.cursor/rules/` directory.  Create
`.cursor/rules/codesteward.md` with the same content if you prefer that format.

---

### Gemini CLI — `GEMINI.md`

```bash
cp /path/to/codesteward-mcp/templates/GEMINI.md .
```

Gemini CLI reads `GEMINI.md` from the project root, similar to `CLAUDE.md`.

---

### Windsurf — `.windsurfrules`

```bash
cp /path/to/codesteward-mcp/templates/.windsurfrules .
# or append to an existing .windsurfrules:
cat /path/to/codesteward-mcp/templates/.windsurfrules >> .windsurfrules
```

---

### GitHub Copilot — `.github/copilot-instructions.md`

```bash
mkdir -p .github
cp /path/to/codesteward-mcp/templates/copilot-instructions.md \
   .github/copilot-instructions.md
```

GitHub Copilot in VS Code reads `.github/copilot-instructions.md` as workspace
instructions.

---

### OpenAI Codex — `AGENTS.md`

```bash
cp /path/to/codesteward-mcp/templates/AGENTS.md .
# or append to an existing AGENTS.md:
cat /path/to/codesteward-mcp/templates/AGENTS.md >> AGENTS.md
```

Codex reads `AGENTS.md` from the project root on every session, the same way
Claude Code reads `CLAUDE.md`.

---

## Step 4 — Verify the connection

Ask your AI tool a structural question about the codebase:

> "Use graph_status to check if the codebase graph has been built."

The agent should call `graph_status()` and return a YAML result.  If
`last_build` is null, tell it to rebuild:

> "Run graph_rebuild to parse the codebase."

Once the graph is built, test a query:

> "Use codebase_graph_query to find all functions that call authenticate."

If you see results, everything is working.  If the agent reads files instead of
calling graph tools, check that the instructions file was added to the project
root and that the MCP server config is in the right location for your tool.

---

## Templates reference

| File | Copy to | For |
| ---- | ------- | --- |
| `templates/.mcp.json` | `.mcp.json` | Claude Code (project-level) |
| `templates/cursor/mcp.json` | `.cursor/mcp.json` | Cursor (project-level) |
| `templates/vscode/mcp.json` | `.vscode/mcp.json` | VS Code / GitHub Copilot |
| `templates/CLAUDE.md` | `CLAUDE.md` | Claude Code instructions |
| `templates/.cursorrules` | `.cursorrules` | Cursor instructions |
| `templates/GEMINI.md` | `GEMINI.md` | Gemini CLI instructions |
| `templates/.windsurfrules` | `.windsurfrules` | Windsurf instructions |
| `templates/copilot-instructions.md` | `.github/copilot-instructions.md` | GitHub Copilot instructions |
| `templates/AGENTS.md` | `AGENTS.md` | OpenAI Codex instructions |

All MCP config files point to `http://localhost:3000/sse`.  If you run the
server on a different host or port, update the `url` field accordingly.
