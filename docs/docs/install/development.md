---
sidebar_position: 4
title: "Local development"
description: "Run API, worker, and UI from the monorepo."
---

# Local development

```bash
pnpm install && pnpm -r run build

export DATABASE_URL=postgres://steward:steward@localhost:5432/codesteward
pnpm migrate

export MODEL_PROVIDER=openai-compatible OPENAI_API_KEY=sk-...
# Optional offline graph
export GRAPH_MOCK=1

pnpm dev:api      # :8081
pnpm dev:worker
pnpm dev:ui       # :8080
```

## Docs site

```bash
pnpm dev:docs     # this Docusaurus site on :3000
pnpm build:docs
```

## CLI

```bash
pnpm stew -- doctor full
pnpm stew -- review -p . -r codesteward --tier thorough --depth thorough
pnpm stew -- findings export --sarif -s <sessionId>
```

## Layout (packages)

| Package | Role |
|---------|------|
| `api` | Hono HTTP API |
| `worker` | Job consumer |
| `ui` | React product UI |
| `agents` | Orchestrator + specialists |
| `db` | Postgres repositories + migrations |
| `graph-client` | Graph MCP client (stdio/HTTP/mock) |
| `cli` | `stew` |
