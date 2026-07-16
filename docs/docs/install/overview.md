---
sidebar_position: 1
title: "Install overview"
description: "Choose Compose, Helm, or local monorepo development."
---

# Install overview

Codesteward Review is a **self-hosted** monorepo product. Pick a path by maturity:

| Path | Use when |
|------|----------|
| **[Compose category](../getting-started/quickstart)** | Evaluate on a laptop / shared demo host |
| **[Compose profiles](./compose)** | Add Neo4j, Janus, queue brokers, Keycloak alone |
| **[Helm](./helm)** | Production Kubernetes |
| **[Local monorepo](./development)** | Contribute or debug packages |

## Production checklist

1. **Postgres** with durable storage (`DATABASE_URL` on API **and** workers)  
2. **Keycloak** (or compatible OIDC) + public HTTPS URLs for UI and API  
3. **Workers** scaled separately from API (HPA or KEDA)  
4. **Graph**: Neo4j or JanusGraph; workers embed Graph MCP over stdio  
5. **Model keys** via env and/or org Models UI (encrypted at rest in product store)  
6. **SCM** GitHub App + webhook to `/v1/webhooks/github`  
7. **Backups** for Postgres (and graph DB)  

## Network surfaces

| Port (typical) | Service |
|----------------|---------|
| 8080 | UI (nginx / static) |
| 8081 | API |
| 8083 | Keycloak (compose demo) |
| 5432 | Postgres |
| 7687 / 7474 | Neo4j (if used) |

## Images

CI builds combined **API + worker** runtime images and a **UI** image. Graph MCP runs **inside the worker** (no separate graph-mcp Deployment). Keycloak can use a themed image for production login chrome.

Next: [Helm](./helm) · [Compose](./compose)
