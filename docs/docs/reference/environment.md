---
sidebar_position: 1
title: "Environment variables"
description: "Common env knobs for API, worker, and UI."
---

# Environment variables

This is a **practical subset** — not every flag. Prefer Platform / org runtime UI when available.

## Core

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | **Required** product + job SoT |
| `STEW_API_KEY` | API key mode / break-glass |
| `STEW_WORKSPACE_DIR` | Clone root |
| `STEW_MAX_CONCURRENT` | Specialist concurrency per job |
| `STEW_INLINE_WORKER` | `0` = external workers only |
| `STEW_JOB_LEASE_MS` | Stale running-job reclaim |

## Models

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / … | Host-level provider keys |
| `MODEL_PROVIDER` | Default provider selection |
| `STEW_LLM_MAX_RETRIES` | LLM retry budget |
| `STEW_LLM_REQUEST_TIMEOUT_MS` | Per-request timeout |
| `STEW_SPECIALIST_TIMEOUT_MS` | Specialist wall clock (default ~8m) |

## Identity

| Variable | Purpose |
|----------|---------|
| `OIDC_ISSUER` | Keycloak / OIDC issuer |
| `STEW_IDENTITY_MODE` | e.g. keycloak |
| `STEW_PLATFORM_ADMIN_EMAILS` | Extra platform operators |
| `KEYCLOAK_ADMIN_CLIENT_ID` / `SECRET` | Members provisioning API |

## Queue / scale

| Variable | Purpose |
|----------|---------|
| `STEW_QUEUE_BROKER` | `nats` \| `rabbitmq` \| `pulsar` |
| `NATS_URL` / `RABBITMQ_URL` / `PULSAR_URL` | Broker endpoints |
| `STEW_WORKER_ORG_IDS` | Org-affine claim filter |
| `STEW_TENANT_ISOLATION` | `off` \| `path` \| `strict` |

## Graph

| Variable | Purpose |
|----------|---------|
| `GRAPH_MOCK` | Offline mock graph |
| `GRAPH_MCP_MODE` | `stdio` default |
| `GRAPH_BACKEND` | `neo4j` \| `janusgraph` \| `graphqlite` |
| `NEO4J_URI` / `JANUSGRAPH_URL` | Shared graph DB |

## Publish

| Variable | Purpose |
|----------|---------|
| `STEW_PUBLISH_SARIF` | GitHub Code Scanning upload |
| `STEW_MENTION_TOKEN` | PR comment trigger (default `@codesteward`) |
| `STEW_SUGGESTED_FIX_MIN_CONFIDENCE` | Gate for suggested fixes |

SCM tokens: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN` + username, `AZURE_DEVOPS_TOKEN`, `GITEA_TOKEN` as needed.
