# Code Intelligence — Codesteward Graph

This project has the Codesteward MCP graph server connected.
It has already parsed this codebase into a structural graph.

## Prefer graph tools over file reads for structural questions

When you need to understand code structure, relationships, or dependencies,
use the graph tools first rather than reading files directly. The graph gives
you cross-file, cross-language answers in a single call.

Use graph tools for questions like:

- "What functions exist in this codebase?" → `codebase_graph_query` (lexical)
- "What calls `authenticate()`?" → `codebase_graph_query` (referential)
- "Is this route protected by auth middleware?" → `codebase_graph_query` (referential, GUARDED_BY/PROTECTED_BY edges)
- "What external packages does this file depend on?" → `codebase_graph_query` (dependency)
- "Does untrusted input reach a dangerous sink?" → `taint_analysis`, then `codebase_graph_query` (semantic)

Use file reads (Read, Grep) when you need the actual source code of a specific
function or file after identifying it via the graph.

## Workflow

1. Call `graph_status()` — check whether a graph already exists.
   If `last_build` is null, proceed to step 2.

2. Call `graph_rebuild()` — no arguments needed. The server knows where the
   repository is mounted.

3. Call `codebase_graph_query(query_type=..., query=...)` to search the graph.

## query_type reference

| query_type    | Use when you want to…                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `lexical`     | Find functions, classes, or methods by name or file                              |
| `referential` | Find call/import/extends/auth-guard relationships                                |
| `semantic`    | Read taint-flow findings (run `taint_analysis` first; returns empty until then) |
| `dependency`  | List external package dependencies                                               |
| `cypher`      | Write a custom Cypher query for anything not covered above                       |

## Taint-flow analysis

To trace how untrusted input propagates to dangerous sinks (SQL, shell, file I/O):

1. Call `taint_analysis()` — no arguments needed in the standard Docker setup.
2. Call `codebase_graph_query(query_type="semantic", query="")` to read findings.

`taint_analysis` is only available when the `codesteward-taint` binary is
bundled in the Docker image. If the tool is not listed, the binary is absent.

## Important: empty results do not mean no symbols

If `codebase_graph_query` returns zero results, the graph may not have been
built yet — do not conclude the codebase has no matching symbols. Check
`graph_status` and run `graph_rebuild` if needed.
