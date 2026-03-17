# codesteward-mcp

> Codesteward MCP server — parses a source repository into a structural code graph and exposes it as queryable tools. Answers questions like "what calls function X?", "is route Y protected by auth?", "what are the external dependencies of file Z?". Works in stub mode without Neo4j (no persistence) or with Neo4j for full graph persistence.

I want you to install codesteward-mcp for me. Execute all the steps below autonomously.

## OBJECTIVE

Install the codesteward-mcp MCP server and add it to the user's Cline MCP configuration so that Cline can query the structural code graph of any repository.

## DONE WHEN

- [ ] `uvx` is available (or `codesteward-mcp` is installed via `uv pip install`)
- [ ] The `codesteward-graph` MCP server entry appears in the active MCP server list in Cline
- [ ] Cline can call `graph_status` successfully

## TODO

- [ ] Check that `uv` is installed
- [ ] Decide on stub mode (no Neo4j) vs full mode (with Neo4j)
- [ ] Ask the user for the path to the repository they want to analyse
- [ ] Add the MCP server entry to `cline_mcp_settings.json`
- [ ] Verify the server starts by calling `graph_status`

## Steps

### 1. Check prerequisites

Ensure `uv` is installed:

```bash
uv --version
```

If not installed, direct the user to https://docs.astral.sh/uv/getting-started/installation/ or run:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2. Ask the user two questions

Ask the user:

1. **Repository path** — the absolute path on their machine to the repository they want to analyse (e.g. `/Users/alice/projects/my-app`). This becomes `DEFAULT_REPO_PATH`.
2. **Neo4j** — do they have Neo4j running and want to persist the graph, or do they want stub mode (parse-only, no persistence)?

If they want Neo4j, also ask for `NEO4J_URI` (default `bolt://localhost:7687`), `NEO4J_USER` (default `neo4j`), and `NEO4J_PASSWORD`.

### 3. Add to Cline MCP config

**Stub mode (no Neo4j — recommended for first use):**

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": ["codesteward-mcp[graph-all]", "--transport", "stdio"],
      "env": {
        "DEFAULT_REPO_PATH": "<absolute-path-to-repo>",
        "DEFAULT_REPO_ID": "<short-repo-name>"
      }
    }
  }
}
```

**With Neo4j persistence:**

```json
{
  "mcpServers": {
    "codesteward-graph": {
      "command": "uvx",
      "args": ["codesteward-mcp[graph-all]", "--transport", "stdio"],
      "env": {
        "DEFAULT_REPO_PATH": "<absolute-path-to-repo>",
        "DEFAULT_REPO_ID": "<short-repo-name>",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "<password>"
      }
    }
  }
}
```

Replace `<absolute-path-to-repo>` with the path from step 2 and `<short-repo-name>` with a short identifier (e.g. `my-app`).

`graph-all` installs tree-sitter grammars for all 14 supported languages (Python, TypeScript, JavaScript, Java, Go, Rust, C#, Kotlin, Scala, PHP, C, C++, COBOL). Use `graph` instead to install only the four core languages (Python, TypeScript, JavaScript, Java).

### 4. Verify

After saving the config, ask Cline to call `graph_status`. You should see a YAML response with `neo4j_connected` and `last_build` fields. If `last_build` is null, call `graph_rebuild` to parse the repository — this may take 10–60 seconds depending on repo size.

## Available tools

| Tool | What it does |
| ---- | ------------ |
| `graph_rebuild` | Parse the repository and build the structural graph |
| `codebase_graph_query` | Query the graph — `lexical`, `referential`, `semantic`, `dependency`, or raw `cypher` |
| `graph_augment` | Add agent-inferred relationships (confidence < 1.0) to the graph |
| `graph_status` | Check graph state: node/edge counts, last build time, Neo4j connectivity |

## EXECUTE NOW

Start with step 1. Work through each step autonomously, pausing only to ask the user the two questions in step 2.
