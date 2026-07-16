---
sidebar_position: 3
title: "Prerequisites"
description: "What you need before installing Codesteward Review."
---

# Prerequisites

## Minimum (demo / laptop)

| Requirement | Notes |
|-------------|--------|
| Docker Compose | Category stack |
| CPU / RAM | ~4+ CPU, 8+ GB RAM recommended for full stack |
| Disk | Clones + Postgres + graph; plan for workspace growth |
| LLM API access | OpenAI / Anthropic / xAI / compatible |

## Production

| Requirement | Notes |
|-------------|--------|
| **Postgres** | Required job + product SoT (`DATABASE_URL`) |
| **Kubernetes** (typical) | Helm chart: API, workers, UI |
| **Keycloak** (or OIDC IdP) | Recommended identity SoT |
| **Graph backend** | Neo4j or JanusGraph shared across workers |
| **SCM credentials** | GitHub App preferred for GitHub |
| **Secrets management** | API keys, DB URL, webhook secrets |
| **Outbound HTTPS** | To LLM providers and SCM APIs |

## Optional

| Component | When |
|-----------|------|
| NATS / RabbitMQ / Pulsar | KEDA queue-depth autoscaling |
| Docker-in-Docker / Docker socket | Strict sandbox for agent tools |
| Object storage | Future WORM audit (not required for v1) |

## Skills on your team

Someone comfortable with containers or Helm, OIDC/Keycloak basics, and reading worker logs will unblock install quickly. Deep LLM expertise is optional — start with one provider and the default specialist matrix.
