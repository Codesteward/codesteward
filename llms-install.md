# codesteward-mcp

> Codesteward MCP server — parses a source repository into a structural code graph and exposes it as queryable tools. Answers questions like "what calls function X?", "is route Y protected by auth?", "what are the external dependencies of file Z?". Uses GraphQLite (embedded SQLite) for persistent graph storage — no external database needed.

I want you to install codesteward-mcp for me. Execute all the steps below autonomously.

## OBJECTIVE

Install the codesteward-mcp MCP server and add it to the user's MCP configuration so that the AI agent can query the structural code graph of any repository.

## DONE WHEN

- [ ] `uvx` is available (or `codesteward-mcp` is installed via `uv pip install`)
- [ ] The `codesteward-graph` MCP server entry appears in the active MCP server list
- [ ] The agent can call `graph_status` successfully

## TODO

- [ ] Check that `uv` is installed
- [ ] Ask the user for the path to the repository they want to analyse
- [ ] Add the MCP server entry to the appropriate config file
- [ ] Verify the server starts by calling `graph_status`

## Steps

### 1. Check prerequisites

Ensure `uv` is installed:

```bash
uv --version
```

If not installed, direct the user to <https://docs.astral.sh/uv/getting-started/installation/> or run:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2. Ask the user one question

Ask the user:

1. **Repository path** — the absolute path on their machine to the repository they want to analyse (e.g. `/Users/alice/projects/my-app`). This becomes `DEFAULT_REPO_PATH`.

### 3. Add to MCP config

Add this entry to the MCP settings file. GraphQLite is the default backend — an embedded SQLite graph database that persists to `~/.codesteward/graph.db`. No external database server needed.

**For Cline** (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all,graphqlite]",
        "codesteward-mcp", "--transport", "stdio"
      ],
      "env": {
        "DEFAULT_REPO_PATH": "<absolute-path-to-repo>",
        "DEFAULT_REPO_ID": "<short-repo-name>"
      }
    }
  }
}
```

**For Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all,graphqlite]",
        "codesteward-mcp", "--transport", "stdio"
      ],
      "env": {
        "DEFAULT_REPO_PATH": "<absolute-path-to-repo>",
        "DEFAULT_REPO_ID": "<short-repo-name>"
      }
    }
  }
}
```

**For Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": [
        "--from", "codesteward-mcp[graph-all,graphqlite]",
        "codesteward-mcp", "--transport", "stdio"
      ],
      "env": {
        "DEFAULT_REPO_PATH": "<absolute-path-to-repo>",
        "DEFAULT_REPO_ID": "<short-repo-name>"
      }
    }
  }
}
```

Replace `<absolute-path-to-repo>` with the path from step 2 and `<short-repo-name>` with a short identifier (e.g. `my-app`).

`graph-all` installs tree-sitter grammars for all 14 supported languages (Python, TypeScript, JavaScript, Java, Go, Rust, C#, Kotlin, Scala, PHP, C, C++, COBOL). Use `graph` instead to install only the four core languages (Python, TypeScript, JavaScript, Java).

### 4. Verify

After saving the config, call `graph_status`. You should see a YAML response with `backend_connected` and `last_build` fields. If `last_build` is null, call `graph_rebuild` to parse the repository — this may take 10–60 seconds depending on repo size.

## Available tools

| Tool | What it does |
| ---- | ------------ |
| `graph_rebuild` | Parse the repository and build the structural graph |
| `codebase_graph_query` | Query the graph — `lexical`, `referential`, `semantic`, `dependency`, or raw `cypher` |
| `graph_augment` | Add agent-inferred relationships (confidence < 1.0) to the graph |
| `graph_status` | Check graph state: node/edge counts, last build time, backend connectivity |

## EXECUTE NOW

Start with step 1. Work through each step autonomously, pausing only to ask the user the question in step 2.
