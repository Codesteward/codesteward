# CodeSteward Helm chart

Production deployment with Neo4j/JanusGraph graph, API, UI, and **horizontally scaled workers**.

## Production requirements

| Requirement | How |
|-------------|-----|
| **DATABASE_URL** | **Required.** Set `secrets.databaseUrl` (or enable `database.enabled` for in-cluster Postgres). Without it, multi-replica API/workers corrupt file queues. |
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

## Graph backends

| values.graph.backend | Notes |
|----------------------|-------|
| `graphqlite` | Demo / small |
| `neo4j` | Default production |
| `janusgraph` | Apache-2.0 alternative |

For local graph stacks: `deploy/compose/docker-compose.neo4j.yml` and `docker-compose.janusgraph.yml`.

## Auth

- API: `Authorization: Bearer <STEW_API_KEY>` when `secrets.apiKey` set
- Webhooks: `/v1/webhooks/github` (HMAC) and `/v1/webhooks/gitlab` (token) — auth exempt
- PR mention trigger: default `@codesteward` (`webhooks.mentionToken` / `STEW_MENTION_TOKEN`); e.g. `@codesteward review`
- Optional OIDC: set `OIDC_ISSUER` (stub/status endpoint; full SSO is optional enterprise enhancement)
