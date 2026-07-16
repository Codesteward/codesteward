---
sidebar_position: 2
title: "Kubernetes quick start"
description: "Install Codesteward Review on a cluster with Helm from GHCR (OCI)."
---

# Kubernetes quick start

Use this path when you already have a Kubernetes cluster and want a real install (not Docker Compose on a laptop).

Charts and images are published to **GitHub Container Registry** under the official monorepo:

**[github.com/Codesteward/codesteward](https://github.com/Codesteward/codesteward)** → GHCR path **`ghcr.io/codesteward/codesteward`** (org/repo lowercased).

| Artifact | Reference |
|----------|-----------|
| **Helm chart** | `oci://ghcr.io/codesteward/codesteward/charts/codesteward` |
| **App (API + worker)** | `ghcr.io/codesteward/codesteward:<version>` |
| **UI** | `ghcr.io/codesteward/codesteward/ui:<version>` |
| **Keycloak (optional)** | `ghcr.io/codesteward/codesteward/keycloak:<upstream-kc-version>` |

:::tip Compose vs Kubernetes
**First try on a laptop?** Use the [Compose quick start](./quickstart).  
**Cluster / production-shaped?** Stay here, then deepen with [Helm reference](../install/helm).
:::

## Prerequisites

- Kubernetes **1.27+** (kind, k3s, EKS, GKE, AKS, …)  
- [Helm 3.10+](https://helm.sh/docs/intro/install/)  
- `kubectl` context pointing at your cluster  
- Ability to pull from GHCR (public packages, or `docker login ghcr.io` / imagePullSecrets)  
- An **LLM API key** (OpenAI, Anthropic, SpaceXAI, or compatible)  

## 1. Namespace + secrets

```bash
export VERSION=1.2.0   # product version (no leading v)
export CHART=oci://ghcr.io/codesteward/codesteward/charts/codesteward
export NS=codesteward

kubectl create namespace "$NS"

kubectl -n "$NS" create secret generic codesteward-secrets \
  --from-literal=databaseUrl='postgres://steward:CHANGE_ME@codesteward-postgres:5432/codesteward' \
  --from-literal=databasePassword='CHANGE_ME' \
  --from-literal=apiKey="$(openssl rand -hex 24)" \
  --from-literal=openaiApiKey="$OPENAI_API_KEY"
```

For a **managed Postgres** outside the cluster, set `databaseUrl` to that URL and skip in-cluster Postgres in the next step (`database.enabled=false`).

## 2. Install the chart (eval / small cluster)

This turns on **in-cluster Postgres** and the chart’s Neo4j defaults so you can boot without external DBs. Prefer external managed databases for production.

```bash
helm upgrade --install codesteward "$CHART" \
  --version "$VERSION" \
  --namespace "$NS" \
  --create-namespace \
  --set image.repository=ghcr.io/codesteward/codesteward \
  --set image.tag="$VERSION" \
  --set ui.image.repository=ghcr.io/codesteward/codesteward/ui \
  --set ui.image.tag="$VERSION" \
  --set database.enabled=true \
  --set secrets.existingSecret=codesteward-secrets \
  --set graph.backend=neo4j \
  --wait --timeout 15m
```

If the chart expects secrets differently (inline `secrets.*` vs `existingSecret`), match [Helm install](../install/helm) / chart `values.yaml` in the monorepo.

**From a git checkout** (without waiting for an OCI publish):

```bash
git clone https://github.com/Codesteward/codesteward.git
cd codesteward
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --namespace "$NS" \
  --set image.tag="$VERSION" \
  --set database.enabled=true
```

## 3. Port-forward and open the UI

```bash
kubectl -n "$NS" port-forward svc/codesteward-ui 8080:80
# API (optional):
# kubectl -n "$NS" port-forward svc/codesteward-api 8081:8081
```

Open http://localhost:8080 — complete bootstrap / IdP login, add models, connect SCM, start a **Gate** review.

Service names may include the release name prefix; list them with:

```bash
kubectl -n "$NS" get svc
```

## 4. Production-shaped install (sketch)

```bash
# External Postgres + existing Neo4j
kubectl -n "$NS" create secret generic codesteward-secrets \
  --from-literal=databaseUrl='postgres://steward:SECRET@pg.internal:5432/codesteward' \
  --from-literal=apiKey="$STEW_API_KEY" \
  --from-literal=openaiApiKey="$OPENAI_API_KEY" \
  --from-literal=githubToken="$GITHUB_TOKEN" \
  --from-literal=githubWebhookSecret="$GITHUB_WEBHOOK_SECRET"

helm upgrade --install codesteward "$CHART" \
  --version "$VERSION" \
  --namespace "$NS" \
  --set image.repository=ghcr.io/codesteward/codesteward \
  --set image.tag="$VERSION" \
  --set ui.image.repository=ghcr.io/codesteward/codesteward/ui \
  --set ui.image.tag="$VERSION" \
  --set database.enabled=false \
  --set graph.backend=neo4j \
  --set graph.neo4j.uri='bolt://neo4j.internal:7687' \
  --set worker.hpa.maxReplicas=20 \
  --set worker.maxConcurrent=8 \
  --set sandbox.provider=null
```

Then wire **Ingress / TLS**, **OIDC (Keycloak)**, and **GitHub App webhooks** to the public API URL. See [Identity](../configure/identity), [Connectors](../configure/connectors), and [Install overview](../install/overview).

## 5. Verify

```bash
kubectl -n "$NS" get pods
kubectl -n "$NS" logs deploy/codesteward-api --tail=50
kubectl -n "$NS" logs deploy/codesteward-worker --tail=50
```

Workers should claim jobs when `DATABASE_URL` matches the API. If sessions stay `queued`, check worker pods and Postgres connectivity.

## Pull the chart only

```bash
helm pull oci://ghcr.io/codesteward/codesteward/charts/codesteward --version "$VERSION"
helm show values oci://ghcr.io/codesteward/codesteward/charts/codesteward --version "$VERSION"
```

If packages are private on your account:

```bash
echo "$GITHUB_TOKEN" | helm registry login ghcr.io -u USERNAME --password-stdin
```

## Next steps

- [Helm reference](../install/helm) — HPA, KEDA, graph backends  
- [Multi-tenant workers](../ops/multi-tenant-workers) — isolation for shared clusters  
- [Job queue](../configure/queue) — Postgres SoT + optional broker  
- [First review](./first-review) — product walkthrough after the UI is up  
