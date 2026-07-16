---
sidebar_position: 2
title: "Docker Compose"
description: "Category stack and optional compose profiles."
---

# Docker Compose

Compose files live under `deploy/compose/` in the monorepo.

## Category stack (recommended demo)

```bash
pnpm compose:category        # up --build -d
pnpm compose:category:down
```

Includes API, worker, UI, Postgres, graph path, and Keycloak with Codesteward theme.

## Other stacks

| File / command | Purpose |
|----------------|---------|
| `docker-compose.demo.yml` | Lighter demo variants |
| `docker-compose.keycloak.yml` | IdP alone (`pnpm compose:keycloak`) |
| `docker-compose.neo4j.yml` | Shared Neo4j |
| `docker-compose.janusgraph.yml` | JanusGraph alternative |
| `docker-compose.queue.yml` | RabbitMQ / NATS profiles for hybrid queue |

Example queue overlay:

```bash
docker compose -f deploy/compose/docker-compose.category.yml \
  -f deploy/compose/docker-compose.queue.yml --profile rabbitmq up -d
```

Then set on API + worker:

```bash
STEW_QUEUE_BROKER=rabbitmq
RABBITMQ_URL=amqp://steward:steward@rabbitmq:5672
```

## Environment

Minimum interesting env:

```bash
DATABASE_URL=postgres://...
OPENAI_API_KEY=...          # or ANTHROPIC_API_KEY / SpaceXAI / compatible
OIDC_ISSUER=https://...     # when using Keycloak
```

See [Environment reference](../reference/environment).
