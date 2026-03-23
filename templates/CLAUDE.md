# Code Intelligence — Codesteward Graph

This project has the Codesteward MCP graph server connected (see `.mcp.json`).
It has already parsed this codebase into a structural graph.

## Prefer graph tools over filesystem reads for structural questions

When you need to understand code structure, relationships, or dependencies,
**use the graph tools first** rather than reading files directly. The graph
gives you cross-file, cross-language answers in a single call; reading files
one-by-one cannot.

Use the graph tools for questions like:

- "What functions exist in this codebase?" → `codebase_graph_query` (lexical)
- "What calls `authenticate()`?" → `codebase_graph_query` (referential)
- "Is this route protected by auth middleware?" → `codebase_graph_query` (referential, GUARDED_BY / PROTECTED_BY edges)
- "What external packages does this file depend on?" → `codebase_graph_query` (dependency)
- "Does untrusted input reach a dangerous sink?" → `taint_analysis`, then `codebase_graph_query` (semantic)

Use filesystem tools (`Read`, `Grep`) when you need the actual source code of
a specific function or file after identifying it via the graph.

## Workflow

Before your first structural query in a session:

```text
graph_status()
```

If `last_build` is null or the graph looks stale relative to recent changes:

```text
graph_rebuild()
```

No arguments needed — the server knows where the repository is.

Then query:

```text
codebase_graph_query(query_type="referential", query="authenticate")
```

## query_type reference

| query_type    | Use when you want to…                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `lexical`     | Find functions, classes, or methods by name or file                              |
| `referential` | Find call/import/extends/auth-guard relationships                                 |
| `semantic`    | Read taint-flow findings (run `taint_analysis` first; returns empty until then) |
| `dependency`  | List external package dependencies                                               |
| `cypher`      | Raw Cypher query (Neo4j backend)                                                 |
| `gremlin`     | Raw Gremlin query (JanusGraph backend)                                           |

## Taint-flow analysis

To trace how untrusted input propagates to dangerous sinks (SQL, shell, file I/O):

```text
taint_analysis()
```

No arguments needed in the standard Docker setup. After it completes, query the findings:

```text
codebase_graph_query(query_type="semantic", query="")
```

`taint_analysis` is only available when the `codesteward-taint` binary is
bundled in the Docker image. If the tool is not listed, the binary is absent.

## Recording inferred relationships

If you identify a relationship through reasoning that the parser could not
detect (e.g. a dynamic call, a runtime-resolved dependency), record it:

```python
graph_augment(
    agent_id="your-agent-id",
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
