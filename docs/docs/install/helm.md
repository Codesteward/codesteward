---
sidebar_position: 3
title: "Kubernetes (Helm)"
description: "Production chart — install from GHCR OCI or from the monorepo."
---

# Kubernetes (Helm)

Chart source in-repo: [`deploy/helm/codesteward`](https://github.com/Codesteward/codesteward/tree/main/deploy/helm/codesteward).

**Published releases** push the chart to GHCR as an OCI artifact under the official repo:

```text
oci://ghcr.io/codesteward/codesteward/charts/codesteward
```

Images:

| Image | Reference |
|-------|-----------|
| API + worker | `ghcr.io/codesteward/codesteward` |
| UI | `ghcr.io/codesteward/codesteward/ui` |
| Keycloak (optional) | `ghcr.io/codesteward/codesteward/keycloak` |

For a guided first install on a cluster, see **[Kubernetes quick start](../getting-started/kubernetes)**.

## Install from GHCR (recommended)

```bash
export VERSION=1.1.0
export CHART=oci://ghcr.io/codesteward/codesteward/charts/codesteward

# Only if the package is private:
# echo "$GITHUB_TOKEN" | helm registry login ghcr.io -u USERNAME --password-stdin

helm show values "$CHART" --version "$VERSION"

helm upgrade --install codesteward "$CHART" \
  --version "$VERSION" \
  --namespace codesteward --create-namespace \
  --set image.repository=ghcr.io/codesteward/codesteward \
  --set image.tag="$VERSION" \
  --set ui.image.repository=ghcr.io/codesteward/codesteward/ui \
  --set ui.image.tag="$VERSION" \
  --set database.enabled=false
  # + secrets / graph URI via --set or -f values-prod.yaml
```

Chart version and `appVersion` track the product tag (`v1.1.0` → `1.1.0`). Container images for that release use the same semver tags (except Keycloak, which uses **upstream Keycloak** versions).

## Install from git checkout

```bash
git clone https://github.com/Codesteward/codesteward.git
cd codesteward

helm upgrade --install codesteward ./deploy/helm/codesteward \
  --namespace codesteward --create-namespace \
  --set image.tag=1.1.0
```

## Requirements

| Requirement | How |
|-------------|-----|
| **DATABASE_URL** | Secret `secrets.databaseUrl` / existing secret, or `database.enabled` for in-cluster Postgres |
| **API auth** | `STEW_API_KEY` / OIDC strongly recommended for production |
| **Graph backend** | `graph.backend`: `neo4j` (default) or `janusgraph` |
| **Sandbox** | Default null; `docker` for strict isolation |

## Secrets sketch

```bash
kubectl create namespace codesteward

kubectl -n codesteward create secret generic codesteward-secrets \
  --from-literal=databaseUrl='postgres://steward:SECRET@pg-host:5432/codesteward' \
  --from-literal=apiKey=$STEW_API_KEY \
  --from-literal=openaiApiKey=$OPENAI_API_KEY \
  --from-literal=githubToken=$GITHUB_TOKEN \
  --from-literal=githubWebhookSecret=$GITHUB_WEBHOOK_SECRET
```

Wire the secret name according to chart `values.yaml` (`secrets.existingSecret` or equivalent).

## Scale model

```text
Postgres job queue (FOR UPDATE SKIP LOCKED)
Workers HPA: min…max on CPU
Optional KEDA on broker depth (STEW_QUEUE_BROKER)
Each pod: STEW_MAX_CONCURRENT specialist slots
```

KEDA example:

```bash
helm upgrade --install codesteward oci://ghcr.io/codesteward/codesteward/charts/codesteward \
  --version "$VERSION" \
  --set worker.queueBroker=rabbitmq \
  --set worker.keda.enabled=true \
  --set worker.keda.broker=rabbitmq \
  --set worker.hpa.enabled=false
```

## Graph in workers

There is **no** standalone graph-mcp Deployment. Each worker spawns `codesteward-mcp` over **stdio** and writes to a **shared** Neo4j/Janus. Graph `tenant_id` = product **orgId**.

## Keycloak image

Optional themed IdP image: `ghcr.io/codesteward/codesteward/keycloak`. Tags = **upstream Keycloak** version (not product semver). See monorepo `deploy/helm/codesteward/README.md` and `deploy/compose/keycloak/KEYCLOAK_VERSION`.

## Related

- [Kubernetes quick start](../getting-started/kubernetes)  
- [Multi-tenant workers](../ops/multi-tenant-workers)  
- [Job queue](../configure/queue)  
- [Scaling](../ops/scaling)  
