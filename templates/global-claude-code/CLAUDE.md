# Code Intelligence — Codesteward Graph

Codesteward is connected globally as an MCP server. It parses any repository into a structural
graph and exposes queryable tools. **Follow the workflow below at the start of every session.**

## Step 1 — Derive repo context (always first)

Before doing anything else, resolve the repo identity from the working directory:

```text
repo_id   = last path segment of $PWD   (e.g. /repos/serving-api  → "serving-api")
repo_path = $PWD
tenant_id = "local"
```

## Step 2 — Check the graph

Call `graph_status` with the derived `repo_id`:

```text
graph_status(repo_id="<repo_id>")
```

Read `last_build` in the response:

- **null or missing** → the repository has never been indexed; go to Step 3.
- **present** → graph exists. If it looks stale relative to recent changes the user mentions,
  go to Step 3. Otherwise skip to Step 4.

## Step 3 — Build (or rebuild) the graph

```text
graph_rebuild(repo_path="<repo_path>", repo_id="<repo_id>")
```

This parses every source file in the repository and writes the structural graph to the configured backend.
Report back: node count, edge count, languages detected.

## Step 4 — Answer structural questions via the graph

**Prefer graph tools over reading files** for any question about structure, relationships,
or dependencies. The graph resolves cross-file and cross-language relationships in a single
call; reading files one-by-one cannot.

Always include `repo_id` on every call:

```text
codebase_graph_query(query_type="lexical",     query="<name>",  repo_id="<repo_id>")
codebase_graph_query(query_type="referential", query="<name>",  repo_id="<repo_id>")
codebase_graph_query(query_type="dependency",  query="",        repo_id="<repo_id>")
codebase_graph_query(query_type="cypher",      query="<cypher>",repo_id="<repo_id>")
```

Use `Read` / `Grep` only when you need the actual source lines of a specific file or function
after identifying it via the graph.

## query_type reference

| query_type    | Use when you want to…                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `lexical`     | Find functions, classes, or methods by name or file                              |
| `referential` | Find call/import/extends/auth-guard relationships                                |
| `semantic`    | Read taint-flow findings (run `taint_analysis` first; returns empty until then)  |
| `dependency`  | List external package dependencies                                               |
| `cypher`      | Raw Cypher query (Neo4j backend)                                                 |
| `gremlin`     | Raw Gremlin query (JanusGraph backend)                                           |

## Taint-flow analysis (optional)

If `taint_analysis` appears in the available tools, trace untrusted input to dangerous sinks:

```text
taint_analysis(repo_id="<repo_id>")
```

Then read the findings:

```text
codebase_graph_query(query_type="semantic", query="", repo_id="<repo_id>")
```

If `taint_analysis` is not listed, the `codesteward-taint` binary is not installed.

## Recording inferred relationships

If you identify a relationship through reasoning that the parser could not detect
(e.g. a dynamic call, a runtime-resolved dependency), record it:

```python
graph_augment(
    agent_id="your-agent-id",
    repo_id="<repo_id>",
    additions=[{
        "source_id": "<node_id from query result>",
        "edge_type": "calls",
        "target_id": "<node_id from query result>",
        "target_name": "function_name",
        "confidence": 0.85,
        "rationale": "Called dynamically via registry lookup at line 42"
    }]
)
```
