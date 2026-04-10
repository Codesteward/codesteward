# Codesteward — Setup Templates

Codesteward parses your codebase into a structural graph stored in Neo4j and exposes it as an MCP server your AI agent can query. Instead of reading files one by one, the agent calls `codebase_graph_query` to get cross-file answers — call chains, auth guards, dependency trees — in a single round trip.

This folder contains the config and instruction files you copy to connect it to your tool.

---

## How to use this folder

Every AI tool needs two things:

| | What it does | Where it lives |
|---|---|---|
| **MCP config** | Tells the tool where the server is running | Tool-specific location (see each section) |
| **Instructions file** | Tells the agent to use graph tools instead of reading files | Copied into your repo root |

Pick your tool below and follow its section. If you want the setup to work across all your repositories automatically, use the [Global setup](#global-setup) instead.

---

## Jump to your tool

**Per-project** — copy files into the repo you want to analyse (do this once per repo)

- [Claude Code](#claude-code)
- [Cursor](#cursor)
- [Windsurf](#windsurf)
- [VS Code — GitHub Copilot](#vs-code--github-copilot)
- [Gemini CLI](#gemini-cli)
- [OpenAI Codex CLI](#openai-codex-cli)

**Global** — configure once, works in every repository without any per-project files

- [Claude Code (Global)](#claude-code-global)
- [OpenAI Codex CLI (Global)](#openai-codex-cli-global)
- [Gemini CLI (Global)](#gemini-cli-global)

---

## Step 0 — Start the server

> **Skip this step if you are using stdio via uvx.** The client spawns the server automatically; nothing to start.

If you are using the Docker + Neo4j setup (recommended for persistent graphs):

```bash
# Run from the codesteward repository root
export REPO_PATH=/path/to/the/repo/you/want/to/analyse
docker compose up -d
```

The server starts at `http://localhost:3000/sse`. All MCP configs in this folder point to that address.

**Which should I use?**

| | Docker + Neo4j | stdio via uvx |
|---|---|---|
| Graph persists between sessions | Yes | No — rebuilt each time |
| Requires Docker | Yes | No |
| Requires [uv](https://docs.astral.sh/uv/) | No | Yes |
| Best for | Teams, daily use | Quick start, one-off analysis |

---

## Per-project setup

> **Note:** Run all `cp` commands from the root of the **codesteward repository**, not from the repo you are analysing.

---

### Claude Code

```bash
cp templates/.mcp.json  /path/to/your/repo/.mcp.json
cp templates/CLAUDE.md  /path/to/your/repo/CLAUDE.md
```

| File | Purpose |
|------|---------|
| `.mcp.json` | Registers the MCP server with Claude Code (picked up automatically) |
| `CLAUDE.md` | Loaded at session start — instructs the agent to use graph tools for structural questions |

> **Already have a `CLAUDE.md`?** Append instead of overwriting:
> ```bash
> cat templates/CLAUDE.md >> /path/to/your/repo/CLAUDE.md
> ```

> **Using stdio via uvx instead of Docker?** Replace the contents of `.mcp.json` with the stdio config from [Step 0](#step-0--start-the-server).

---

### Cursor

```bash
mkdir -p /path/to/your/repo/.cursor
cp templates/cursor/mcp.json  /path/to/your/repo/.cursor/mcp.json
cp templates/.cursorrules     /path/to/your/repo/.cursorrules
```

| File | Purpose |
|------|---------|
| `.cursor/mcp.json` | Registers the MCP server with Cursor |
| `.cursorrules` | Instructs Cursor to use graph tools for structural questions |

Reload the window after copying: `Ctrl+Shift+P` → *Reload Window*.

> **Prefer the newer rules format?** Copy `.cursorrules` to `.cursor/rules/codesteward.md` instead — same content, different location.

---

### Windsurf

```bash
cp templates/.windsurfrules /path/to/your/repo/.windsurfrules
```

| File | Purpose |
|------|---------|
| `.windsurfrules` | Instructs Windsurf to use graph tools for structural questions |

Register the MCP server via the Windsurf UI:

1. Open **Windsurf Settings → MCP Servers → Add Server**
2. Fill in:
   - **Name:** `codesteward-graph`
   - **Type:** `HTTP`
   - **URL:** `http://localhost:3000/sse`
3. Click **Save**, then reload the window.

---

### VS Code — GitHub Copilot

```bash
mkdir -p /path/to/your/repo/.vscode /path/to/your/repo/.github
cp templates/vscode/mcp.json         /path/to/your/repo/.vscode/mcp.json
cp templates/copilot-instructions.md /path/to/your/repo/.github/copilot-instructions.md
```

| File | Purpose |
|------|---------|
| `.vscode/mcp.json` | Registers the MCP server with VS Code |
| `.github/copilot-instructions.md` | Instructs Copilot to use graph tools for structural questions |

VS Code will prompt you to enable the server when it detects the config file. Accept the prompt, then reload the window.

---

### Gemini CLI

```bash
cp templates/GEMINI.md /path/to/your/repo/GEMINI.md
```

| File | Purpose |
|------|---------|
| `GEMINI.md` | Loaded each session — instructs the agent to use graph tools |

Gemini CLI has no project-level MCP config file. Register the server globally — see [Gemini CLI (Global)](#gemini-cli-global).

---

### OpenAI Codex CLI

```bash
cp templates/AGENTS.md /path/to/your/repo/AGENTS.md
```

| File | Purpose |
|------|---------|
| `AGENTS.md` | Loaded each session — instructs the agent to use graph tools |

Codex has no project-level MCP config file. Register the server globally — see [OpenAI Codex CLI (Global)](#openai-codex-cli-global).

---

## Global setup

Configure once in your home directory. The agent picks up the server and instructions automatically in every repository you open — no per-project files needed.

---

### Claude Code (Global)

**Step 1 — Register the MCP server**

Add the following block to `~/.claude/settings.json` (create the file if it does not exist). If the file already has other settings, add only the `mcpServers` object — do not overwrite the whole file.

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

Claude Code spawns the server as a subprocess — no Docker needed. `uvx` downloads and caches the package on first run. Omit the `env` block to run without Neo4j (graph held in memory per session).

**Step 2 — Add the global instruction file**

```bash
cp templates/global-claude-code/CLAUDE.md ~/.claude/CLAUDE.md
```

This file is loaded at the start of every Claude Code session. It derives `repo_id` from the current directory and tells the agent to check graph freshness before answering structural questions — works for any repository you open.

**Step 3 — Add the `/codesteward` skill** *(optional)*

```bash
mkdir -p ~/.claude/skills
cp templates/global-claude-code/codesteward-skill.md ~/.claude/skills/codesteward.md
```

Adds a `/codesteward` slash command you can invoke for an explicit guided workflow: status check → rebuild → query → taint scan.

---

### OpenAI Codex CLI (Global)

**Step 1 — Register the MCP server**

Add the following to `~/.codex/config.yaml` (create the file if it does not exist). If the file already has other settings, add only the `mcp_servers` block — do not overwrite the whole file.

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

**Step 2 — Add the global instruction file**

```bash
cp templates/global-codex/AGENTS.md ~/AGENTS.md
```

Codex reads `AGENTS.md` from `~/AGENTS.md`, the repo root, and the current directory (in that order). The global file covers every repository automatically.

---

### Gemini CLI (Global)

Gemini CLI only supports global MCP configuration. Add the server to `~/.gemini/settings.json` (create the file if it does not exist):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

Then copy `templates/GEMINI.md` into each repository you want to analyse (see [Gemini CLI](#gemini-cli) per-project setup above).

---

## Quick reference

| Tool | MCP config location | Instructions file |
|------|--------------------|--------------------|
| Claude Code | `<repo>/.mcp.json` | `<repo>/CLAUDE.md` |
| Claude Code (global) | `~/.claude/settings.json` | `~/.claude/CLAUDE.md` |
| Cursor | `<repo>/.cursor/mcp.json` | `<repo>/.cursorrules` |
| Windsurf | Settings UI | `<repo>/.windsurfrules` |
| VS Code / GitHub Copilot | `<repo>/.vscode/mcp.json` | `<repo>/.github/copilot-instructions.md` |
| Gemini CLI | `~/.gemini/settings.json` | `<repo>/GEMINI.md` |
| OpenAI Codex (per-project) | `~/.codex/config.yaml` | `<repo>/AGENTS.md` |
| OpenAI Codex (global) | `~/.codex/config.yaml` | `~/AGENTS.md` |

---

## Verify the connection

After completing setup, restart your tool and open a repository. Then ask the agent:

> *"Use graph_status to check if the codebase graph has been built."*

The agent should call `graph_status()` and return metadata including node and edge counts. If `last_build` is null, the graph has not been indexed yet — tell it to build:

> *"Run graph_rebuild to index this codebase."*

Once the graph is built, test a structural query:

> *"Use codebase_graph_query to find all functions that call authenticate."*

**If the agent reads files instead of calling graph tools**, check two things:
1. The instructions file (`CLAUDE.md`, `.cursorrules`, etc.) is in the **project root** of the repo you opened.
2. The MCP server config is in the **correct location** for your tool (see the quick reference table above).

---

For detailed troubleshooting and all supported languages, see [AGENT_SETUP.md](../AGENT_SETUP.md).
