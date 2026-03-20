You are executing an explicit Codesteward workflow. Follow these steps in order.

**Step 1 — Resolve repo context**

Derive from the current working directory:
- `repo_id`   = last path segment of `$PWD`  (e.g. `/repos/serving-api` → `"serving-api"`)
- `repo_path` = `$PWD`
- `tenant_id` = `"local"` (unless the user specified otherwise)

If the user passed arguments (e.g. `/codesteward rebuild`, `/codesteward taint`,
`/codesteward query <term>`), note the intent.

**Step 2 — Check graph freshness**

Call `graph_status(repo_id=<repo_id>)`.

- If `last_build` is null → proceed to Step 3 (rebuild needed).
- If `last_build` exists and no rebuild was requested → skip to Step 4.

**Step 3 — Rebuild (if needed or requested)**

Call `graph_rebuild(repo_path=<repo_path>, repo_id=<repo_id>)`.

Report: node count, edge count, languages detected.

**Step 4 — Query or analyse**

Choose based on user intent or the argument passed to `/codesteward`:

| Intent / argument | Action |
|---|---|
| `rebuild` | Already done in Step 3; report results. |
| `taint` or `scan` | Call `taint_analysis(repo_id=<repo_id>)`, then `codebase_graph_query(query_type="semantic", repo_id=<repo_id>)`. Summarise findings. |
| `query <term>` | Call `codebase_graph_query(query_type="referential", query=<term>, repo_id=<repo_id>)`. |
| `status` | Report the output from Step 2 and stop. |
| *(no argument / unclear)* | Ask the user: rebuild, query, or taint scan? |

**Step 5 — Summarise and suggest next step**

- Give a concise summary of what was found.
- Propose the most useful follow-up (e.g. "Run `taint_analysis` to check for unsafe data flows",
  or "Use `cypher` query type for custom traversal").
