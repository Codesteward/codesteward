# Codesteward Graph — Code Intelligence

This workspace has the Codesteward MCP graph server connected.
It has already parsed this codebase into a structural graph.

## Use graph tools for structural questions

When answering questions about code structure, call relationships, or
dependencies, prefer the Codesteward graph tools over reading or searching
files directly. The graph provides cross-file, cross-language answers in
a single call.

**graph_status** — Call this at the start of any structural analysis to check
whether the graph is ready. If `last_build` is null, call `graph_rebuild` first.

**graph_rebuild** — Parse or refresh the graph. No arguments are required in
the standard Docker setup. Call this before querying if the graph does not exist
or after significant code changes.

**codebase_graph_query** — Search the graph. Use the `query_type` parameter:

- `lexical` — find functions, classes, methods by name or file
- `referential` — find call/import/extends relationships and auth guards
- `semantic` — read taint-flow findings (run `taint_analysis` first; returns empty until then)
- `dependency` — list external package dependencies
- `cypher` — custom Cypher query

**taint_analysis** — Trace how untrusted input propagates to dangerous sinks
(SQL, shell, file I/O). Run this before querying `semantic`. Only available
when the `codesteward-taint` binary is bundled in the Docker image.

**graph_augment** — Record a relationship you inferred through reasoning that
the parser could not detect statically. Use `node_id` values from query results
as `source_id` and `target_id`.

## Important: empty results do not mean no symbols

If `codebase_graph_query` returns zero results, the graph may not have been
built yet — do not conclude the codebase has no matching symbols. Check
`graph_status` and run `graph_rebuild` if needed.
