---
name: steward-map
description: Map cross-repo links, blast radius, and dependency edges via CodeSteward Graph + fan-out.
version: 1.0.0
---

# Steward Map Skill

Use when the user wants structural navigation: who calls what, auth guards,
cross-repo fan-out, or org repo-link previews.

## Prerequisites

- Monorepo built: `pnpm install && pnpm -r run build`
- Graph: `GRAPH_MOCK=1` offline, or Codesteward MCP on `:3000`
- Optional API: `pnpm dev:api`

## Commands

```bash
# Graph status / rebuild
pnpm stew -- graph status -r <repoId>
pnpm stew -- graph rebuild -r <repoId> -p .

# Lexical / referential queries (via MCP or graph client)
pnpm stew -- graph query lexical createApp
pnpm stew -- graph query referential handleGitHubWebhook

# Cross-repo links via API
curl -s localhost:8081/v1/org/repo-links
curl -s -X POST localhost:8081/v1/org/repo-links/preview \
  -H 'content-type: application/json' \
  -d '{"repoId":"my-api","paths":["src/"]}'
```

## When reviewing

1. Rebuild graph for the head SHA / changed files.
2. For each high-risk path, query referential edges (callers/callees).
3. If org links exist, run fan-out preview before deep specialist work.
4. Surface cross-repo units in the session progress stream.

## MCP tools

- `stew_graph_status`
- Graph MCP: `graph_status`, `graph_rebuild`, `codebase_graph_query`
