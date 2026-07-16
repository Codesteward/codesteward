---
sidebar_position: 3
title: "Architecture"
description: "UI, API, workers, Postgres, graph, and identity."
---

# Architecture

```text
┌──────────────┐  SPA OIDC (PKCE)  ┌─────────────────┐
│  UI :8080    │ ───────────────►  │  Keycloak IdP   │
│  React       │ ◄── access_token ─│  MFA / federated│
└──────┬───────┘                   └─────────────────┘
       │ Bearer JWT
       ▼
┌──────────────┐   enqueue    ┌──────────────────────────────┐
│  API :8081   │ ───────────► │  Postgres jobs (SoT)         │
│  Hono        │              │  + optional NATS/Rabbit/Pulsar│
└──────┬───────┘              └──────────────┬───────────────┘
       │ sessions / findings                 │ claim
       ▼                                     ▼
┌──────────────┐                    ┌─────────────────┐
│  Postgres    │                    │  Workers        │
│  product SoT │                    │  (HPA / KEDA)   │
└──────────────┘                    └────────┬────────┘
                                             │
              ┌──────────────────────────────┼────────────────────────┐
              ▼                              ▼                        ▼
     Graph MCP (stdio in worker)     Model router              Sandbox / Prove
     Neo4j · Janus · GraphQLite      OpenAI · Anthropic · xAI   local · docker · k8s
```

| Layer | Role |
|-------|------|
| **UI** | Product surface; browser holds OIDC tokens |
| **API** | Auth, sessions, webhooks, enqueue |
| **Worker** | Orchestrator, specialists, judge, SCM publish |
| **Graph** | Structural intelligence via MCP (embedded in workers) |
| **Queue** | Postgres by default; optional broker for KEDA wake-up only |

## Data plane

- **Postgres** — sessions, findings, jobs, learning, users/orgs (when not pure IdP shadow)  
- **Workspace disk** — SCM clones under `{STEW_WORKSPACE_DIR}/{orgId}/{sessionId}`  
- **Graph store** — shared Neo4j/Janus recommended; namespaced by product `orgId`  

## Trust boundaries

- Tenant org admins manage members, connectors, models, policy  
- **Platform operators** manage install-wide runtime, license, queue recovery, graph rebuild  
- Workers should not share unjailed shells across orgs — see [Multi-tenant workers](../ops/multi-tenant-workers)  

Deep dive: [How a review works](../pipeline/overview)
