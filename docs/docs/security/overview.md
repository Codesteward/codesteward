---
sidebar_position: 1
title: "Security overview"
description: "Self-host security model and operator responsibilities."
---

# Security overview

## Shared responsibility

| You operate | Codesteward provides |
|-------------|----------------------|
| Network, TLS, secrets, backups | App RBAC, org isolation features |
| Keycloak MFA / federation | JWT validation, role mapping |
| LLM vendor agreements | Prompt/tool boundaries in agents |
| SCM App permissions | Least-privilege connector patterns |
| Worker node hardening | Path jails, strict sandbox mode, claim affinity |

## Notable controls

- Policy from **base branch** only  
- Session **audit** with hashed specialist responses + redacted excerpts  
- **Path jail** + optional Docker sandbox for agent tools  
- Graph **tenant_id = orgId**  
- Secrets in env / encrypted connector & model stores (self-host)  

## Threats to plan for

- Prompt injection trying to read other tenants’ clones → isolation modes  
- Over-broad SCM tokens → prefer GitHub App with fine permissions  
- Unauthenticated API (`STEW_API_KEY` unset) → never in production  

Continue: [Session audit](./session-audit) · [Multi-tenant workers](../ops/multi-tenant-workers)
