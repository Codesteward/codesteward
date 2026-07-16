---
sidebar_position: 4
title: "Job queue"
description: "Postgres SoT and optional NATS/Rabbit/Pulsar wake-up."
---

# Job queue

## Source of truth: Postgres

```bash
DATABASE_URL=postgres://...
```

Workers claim jobs with `FOR UPDATE SKIP LOCKED`. There is **no** file-backed job queue — it does not survive multi-replica deploys.

## Optional broker (wake-up only)

For KEDA / faster fan-out:

```bash
STEW_QUEUE_BROKER=rabbitmq   # or nats | pulsar
RABBITMQ_URL=amqp://...
```

Jobs are still written to Postgres first; broker publish is best-effort.

## Disaster recovery

If the broker loses messages:

1. Workers **still process** pending jobs via Postgres poll  
2. Platform operators can **republish** pending jobs to rehydrate broker depth:

```http
GET  /v1/platform/queue
POST /v1/platform/queue/republish
```

UI: **Settings → Platform ops → Job queue recovery**

Compose helper: `deploy/compose/docker-compose.queue.yml`.
