# Codesteward Helm chart

Production deployment with Neo4j/JanusGraph graph, API, UI, and **horizontally scaled workers**.

## Install from GHCR (OCI)

Official repo: [Codesteward/codesteward](https://github.com/Codesteward/codesteward).  
Each product release (`vX.Y.Z`) packages this chart and pushes it to GHCR:

```bash
VERSION=1.4.0

helm install codesteward oci://ghcr.io/codesteward/codesteward/charts/codesteward \
  --version "$VERSION" \
  --namespace codesteward --create-namespace \
  --set image.repository=ghcr.io/codesteward/codesteward \
  --set image.tag="$VERSION" \
  --set ui.image.repository=ghcr.io/codesteward/codesteward/ui \
  --set ui.image.tag="$VERSION"
```

| Artifact | Reference |
|----------|-----------|
| Chart | `oci://ghcr.io/codesteward/codesteward/charts/codesteward` |
| App | `ghcr.io/codesteward/codesteward` |
| UI | `ghcr.io/codesteward/codesteward/ui` |
| Keycloak | `ghcr.io/codesteward/codesteward/keycloak` |

The `.tgz` is also attached to the GitHub Release. Product docs: **Kubernetes quick start**.

## Production requirements

| Requirement | How |
|-------------|-----|
| **DATABASE_URL** | **Required.** Set `secrets.databaseUrl` (or enable `database.enabled` for in-cluster Postgres). Job queue SoT is Postgres only; API/worker refuse to start without it. |
| **STEW_API_KEY** | Strongly recommended. Set `secrets.apiKey`. When unset, API is open (dev mode). |
| **Graph backend** | `graph.backend`: `neo4j` (default) or `janusgraph`. Wire external DB or use compose profiles. |
| **Sandbox** | Default `sandbox.provider: null`. Use `local`/`docker` for Prove; `k8s` only when workers have kubectl + RBAC. |

## Scale model (50+ concurrent units)

```
Default queue: Postgres (DATABASE_URL) — single backend, SKIP LOCKED
Optional broker: STEW_QUEUE_BROKER=nats|rabbitmq|pulsar (PG remains SoT)

HPA workers (CPU): min 2 … max 20   # worker.hpa — disable when using KEDA
KEDA (queue depth): worker.keda.enabled + worker.queueBroker
Each pod: STEW_MAX_CONCURRENT=8 specialist slots
```

### Optional queue broker + KEDA

Minimal installs use **Postgres only** as the job queue.

For queue-depth autoscaling:

1. Run NATS JetStream, RabbitMQ, or Pulsar  
2. Set on API **and** workers: `STEW_QUEUE_BROKER` + URL (`NATS_URL` / `RABBITMQ_URL` / `PULSAR_URL`)  
3. Install [KEDA](https://keda.sh), set:

```bash
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set worker.queueBroker=rabbitmq \
  --set worker.keda.enabled=true \
  --set worker.keda.broker=rabbitmq \
  --set worker.hpa.enabled=false
# secret codesteward-secrets must include rabbitmqUrl=amqp://...
```

Compose helper: `docker-compose.queue.yml` (profiles `rabbitmq` / `nats`).

```bash
# External Postgres (recommended)
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

# Or optional in-cluster Postgres (small/dev only)
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set database.enabled=true \
  --set secrets.databaseUrl='postgres://steward:steward@codesteward-postgres:5432/codesteward' \
  --set secrets.databasePassword=steward
```

## Graph (embedded in workers)

There is **no graph-mcp Deployment**. Each worker runs `codesteward-mcp` over **stdio** and
talks to a **shared** Neo4j or JanusGraph (recommended) or local GraphQLite.

| `graph.backend` | Notes |
|-----------------|-------|
| `neo4j` | Default production — set `graph.neo4j.uri` or use in-cluster Neo4j |
| `janusgraph` | Apache-2.0 alternative |
| `graphqlite` | Single-worker / demo (`GRAPHQLITE_PATH=/data/graph.db`) |

`tenant_id` for graph nodes = **product orgId** (multi-tenant isolation).

Compose stacks: `docker-compose.neo4j.yml`, `docker-compose.janusgraph.yml`, `docker-compose.demo.yml`.

## Keycloak (optional themed IdP)

Helm does **not** require a git checkout for the login theme. Pull the published image whose
**tag equals upstream Keycloak**:

```bash
# Same version string as quay.io/keycloak/keycloak:26.7.0
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set keycloak.enabled=true \
  --set keycloak.image.repository=ghcr.io/codesteward/codesteward/keycloak \
  --set keycloak.image.tag=26.7.0 \
  --set secrets.keycloakAdminPassword="$KC_ADMIN_PASSWORD"
```

Pin / CI source of truth: `deploy/compose/keycloak/KEYCLOAK_VERSION`.  
Weekly workflow `.github/workflows/keycloak-base-update.yml` rebuilds when upstream ships a new release.

Use an external IdP instead: leave `keycloak.enabled=false` and set `OIDC_*` on the API/UI.

## Auth

- API: `Authorization: Bearer <STEW_API_KEY>` when `secrets.apiKey` set
- Webhooks: `/v1/webhooks/github` (HMAC) and `/v1/webhooks/gitlab` (token) — auth exempt
- PR mention trigger: default `@codesteward` (`webhooks.mentionToken` / `STEW_MENTION_TOKEN`); e.g. `@codesteward review`
- Optional OIDC: set `OIDC_ISSUER` (stub/status endpoint; full SSO is optional enterprise enhancement)
