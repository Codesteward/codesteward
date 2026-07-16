---
sidebar_position: 2
title: "Scaling"
description: "Workers, API, UI, and queue-depth autoscaling."
---

# Scaling

| Concern | Approach |
|---------|----------|
| Concurrent reviews | Scale **workers**; raise `STEW_MAX_CONCURRENT` carefully |
| HTTP / webhooks | Scale **API** (JWT is stateless) |
| UI traffic | Scale **UI** static pods / CDN |
| Queue depth | Optional broker + **KEDA** |
| Multi-tenant isolation | Org-affine worker pools + strict sandbox |

## Worker notes

- Prefer **one job at a time per process** when applying org runtime env  
- Use **Docker/k8s sandbox** in multi-org shared pools (`STEW_TENANT_ISOLATION=strict`)  
- Graph MCP is **embedded** — scale workers, not a separate graph service  

See [Multi-tenant workers](./multi-tenant-workers) and [Job queue](../configure/queue).
