# Changelog

All notable changes to **Codesteward Review** (agentic PR gate + branch stewardship) are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

---

## [1.0.0] — 2026-07-16

**First production release** of **Codesteward Review** — graph-aware agentic code review for self-host and multi-tenant SaaS.

### Added — Product core

- **Dual-mode reviews** — PR **Gate** (diff-focused) and branch **Stewardship** (path/package batches) on one platform
- **Graph-aware agents** — specialists call Codesteward Graph (MCP) for structure, not only the patch
- **Multi-provider model router** — OpenAI, Anthropic, xAI, OpenAI-compatible, LiteLLM; optional Langfuse tracing
- **Policy** — `STEWARD.md` + `.codesteward/rules` loaded from the **base** branch only
- **Findings** — durable store, fingerprinting, SARIF 2.1.0 export, lifecycle reconcile (auto-fix / reopen)
- **Learning** — 👍/👎 reactions, dismissals, org/repo/PR-scoped memories, `last_reviewed_sha` incremental gate
- **Discourse** — thorough dual-pass correctness with AGREE / CHALLENGE / CONNECT / SURFACE
- **Prove** — LLM test generation via sandbox providers (local / Docker / K8s stub)
- **Self-heal** — optional agent loops to propose fixes from findings
- **Cross-repo** — fan-out preparation and graph rebuild hooks for multi-repo context
- **Session audit** — code provenance / specialist run trail for review sessions

### Added — Surfaces

- **Hono API** (`@codesteward/api`) — sessions, jobs, webhooks, connectors, tenancy, SCIM, billing hooks
- **Worker** (`@codesteward/worker`) — job consumer; Postgres SoT queue by default; optional NATS / RabbitMQ / Pulsar
- **Product UI** (`@codesteward/ui`) — Vite + React: sessions, connectors, org settings, learning, reports
- **CLI** (`stew`) — review, resume, findings export (SARIF), config/doctor
- **MCP server** — expose stew tools to MCP clients
- **GitHub Action** (`actions/review-action`) — PR gate in CI

### Added — Identity & multi-tenancy

- **Auth modes** — open → API key → users (bootstrap) → **Keycloak OIDC** (SPA PKCE; API validates JWT)
- **RBAC** — viewer / reviewer / admin
- **Orgs** — members, invites, seat caps, multi-org (plan-gated)
- **SCIM 2.0** — tenant path `/scim/v2/orgs/{orgId|slug}` with per-org bearer tokens (**Enterprise**)
- **Admin audit log** — durable org admin trail (**Pro+** / plan-gated)

### Added — SCM & connectors

- **GitHub App** — manifest create flow, installations, webhooks; optional **platform-enforced** shared App
- **Multi-SCM** — GitHub, GitLab, Bitbucket, Azure DevOps, Gitea (org-scoped connectors)
- **Enterprise connectors** plan gate on Free (PAT break-glass where allowed)

### Added — SaaS control plane

- **Private billing service** (`services/saas-billing`) — org subscriptions, portal with OIDC + portal HMAC token
- **Plans** — Free (fixed seats), Pro (**$25 / seat / mo**), Enterprise (custom / volume)
- **Entitlements** — org-scoped features via `STEW_BILLING_URL` (thorough, prove, SCIM, audit, seats, …)
- **Onboarding** — create org → install GitHub App → first review (no auto-`local` org on empty login)

### Added — Deploy & ops

- **Compose stacks** — category demo, Keycloak, Neo4j / JanusGraph, queue brokers, **SaaS** stack
- **Helm chart** — API + worker HPA / optional KEDA, graph MCP, Postgres option
- **GA acceptance scripts** — static + runtime functional matrix (`scripts/ga-acceptance.mjs`, category smoke)

### Security

- Secrets via env / encrypted connector store; session tokens hashed at rest (file/Postgres stores)
- Org isolation tests; license / plan gates for paid features
- GitHub Actions CI with harden-runner, Semgrep, CodeQL, dependency review, Trivy (release gate)

### Known limitations

- Stripe Checkout is demo-mode (plan apply without card charge) until production billing is wired
- Enterprise SSO beyond Keycloak OIDC (SAML IdP federation) remains operator-configured
- Some package `test` scripts are stubs; CI runs `node:test` suites under `**/__tests__/**` and `*.test.ts`

---

## Links

- Product: [codesteward.ai](https://codesteward.ai)
- Graph intelligence: sibling **codesteward-graph** / MCP images
- License: [Apache-2.0](./LICENSE)
