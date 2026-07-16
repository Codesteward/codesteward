---
sidebar_position: 3
title: "Kubernetes (Helm)"
description: "Production chart for API, UI, and scaled workers."
---

# Kubernetes (Helm)

Chart path: `deploy/helm/codesteward`.

## Requirements

| Requirement | How |
|-------------|-----|
| **DATABASE_URL** | Secret `secrets.databaseUrl` or in-cluster Postgres (`database.enabled`) |
| **API auth** | `STEW_API_KEY` / OIDC strongly recommended for production |
| **Graph backend** | `graph.backend`: `neo4j` (default) or `janusgraph` |
| **Sandbox** | Default null; `docker` for strict isolation |

## Install sketch

```bash
kubectl create secret generic codesteward-secrets \
  --from-literal=databaseUrl='postgres://steward:SECRET@pg-host:5432/codesteward' \
  --from-literal=apiKey=$STEW_API_KEY \
  --from-literal=openaiApiKey=$OPENAI_API_KEY \
  --from-literal=githubToken=$GITHUB_TOKEN \
  --from-literal=githubWebhookSecret=$GITHUB_WEBHOOK_SECRET

helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set worker.hpa.maxReplicas=20 \
  --set worker.maxConcurrent=8 \
  --set graph.backend=neo4j \
  --set sandbox.provider=null
```

## Scale model

```text
Postgres job queue (FOR UPDATE SKIP LOCKED)
Workers HPA: min…max on CPU
Optional KEDA on broker depth (STEW_QUEUE_BROKER)
Each pod: STEW_MAX_CONCURRENT specialist slots
```

KEDA example:

```bash
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set worker.queueBroker=rabbitmq \
  --set worker.keda.enabled=true \
  --set worker.keda.broker=rabbitmq \
  --set worker.hpa.enabled=false
```

## Graph in workers

There is **no** standalone graph-mcp Deployment. Each worker spawns `codesteward-mcp` over **stdio** and writes to a **shared** Neo4j/Janus. Graph `tenant_id` = product **orgId**.

Details: chart `README.md` in the monorepo and [Multi-tenant workers](../ops/multi-tenant-workers).
