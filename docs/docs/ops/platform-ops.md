---
sidebar_position: 3
title: "Platform ops UI"
description: "Install-wide analytics, runtime config, and queue recovery."
---

# Platform ops UI

Platform operators (not mere org admins) get install-wide tools:

| Tool | Purpose |
|------|---------|
| **Platform settings** | Health, identity status, graph rebuild, license, platform GitHub App |
| **Platform runtime** | Install-wide env knobs (clone, DeepAgents, graph, worker, …) |
| **Platform ops** | Latency, specialist error rates, queue depth, token estimates |
| **Queue recovery** | Republish pending Postgres jobs to the optional broker |

![Platform ops](/img/screenshots/platform-ops.png)

Tenant admins use org **Analytics** for product metrics within their org only.
