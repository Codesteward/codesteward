---
sidebar_position: 1
title: "Identity (Keycloak)"
description: "OIDC login, MFA, org groups, and product roles."
---

# Identity (Keycloak)

Recommended production mode: **Keycloak as identity source of truth**.

## How login works

1. Browser hits the UI unauthenticated  
2. SPA redirects to **Keycloak** (Codesteward login theme)  
3. User completes password / MFA / federated SSO (configured only in Keycloak)  
4. SPA receives tokens (PKCE); API validates **Bearer JWT** via JWKS  

Break-glass local password form: `/login?local=1` only (not the default path when IdP is configured).

## Org multi-tenancy

Keycloak groups: `/orgs/{slug}` → token `groups` claim.  
Product roles (realm): `steward-admin` | `steward-reviewer` | `steward-viewer`.

| Product role | Capabilities |
|--------------|--------------|
| **Viewer** | Read sessions, findings, dashboards |
| **Reviewer** | Start reviews, react, export |
| **Admin** | Members, connectors, models, policy, SCIM |

**Platform operators** (install-wide) are separate: first bootstrap / first OIDC user on empty install, `STEW_PLATFORM_ADMIN_EMAILS`, or `platform_admin` flag.

## MFA & enterprise SSO

Configure **only in Keycloak** (Microsoft Entra, Google, Okta, …). Codesteward does not re-implement IdP federation.

## SCIM

Optional inbound SCIM: `/scim/v2/orgs/{orgId|slug}` with per-org bearer tokens. Preferred corporate path is still IdP → Keycloak groups → product shadow users.
