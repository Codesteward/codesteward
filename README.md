<p align="center">
  <img src="packages/ui/public/brand/codesteward-wordmark.png" alt="Codesteward" height="56" />
</p>

<h1 align="center">Codesteward Review</h1>

<p align="center">
  <strong>Agentic code review that knows your graph.</strong><br />
  Gate every merge. Steward every branch. Self-hosted.
</p>

<p align="center">
  <a href="https://codesteward.ai">codesteward.ai</a> ·
  <a href="deploy/compose/docker-compose.category.yml">Category stack</a> ·
  <a href="deploy/helm/codesteward">Helm</a> ·
  <a href="docs/ENTERPRISE_GAPS.md">Enterprise notes</a>
</p>

<p align="center">
  <code>Node ≥ 22</code> · <code>pnpm 9</code> · <code>TypeScript ESM</code> ·
  <a href="LICENSE"><code>Apache-2.0</code></a>
</p>

---

## Why Codesteward

Most AI review tools skim a diff and guess. **Codesteward** runs multi-agent reviews against a **structural code graph** — call chains, dependencies, auth paths — so findings are grounded in how the codebase actually works.

| | **Gate** | **Stewardship** |
|--|----------|-----------------|
| **When** | PR / MR open, push, or `@codesteward review` | Long-lived branches & paths |
| **Scope** | Diff-focused units | Package / path / tree batches |
| **Output** | Inline review, check run, verdict | Durable findings lifecycle |
| **Policy** | `STEWARD.md` + path rules from **base** branch | Same model |

One finding schema. One policy model. Multi-provider LLMs. Product UI, CLI, GitHub Action, and workers you can scale.

---

## Highlights

- **Graph-aware agents** — specialists use Codesteward Graph (MCP) for structure, not only the patch  
- **Dual mode** — PR gate + continuous branch stewardship on one platform  
- **Identity** — Keycloak OIDC (SPA PKCE); API validates JWTs (no sticky sessions)  
- **Orgs & policy** — members, connectors, STEWARD.md / path rules, learning, optional SCIM  
- **Learning loop** — 👍/👎, dismissals, org memories → quieter next reviews  
- **Multi-SCM** — GitHub App/webhooks, GitLab, Bitbucket, Azure DevOps, Gitea  
- **Horizontal scale** — API/UI stateless; workers × concurrent specialists; optional queue broker + KEDA  
- **Self-hosted** — your cloud, your models, your keys

---

## Architecture

```text
┌──────────────┐  SPA OIDC (PKCE)  ┌─────────────────┐
│  UI :8080    │ ───────────────►  │  Keycloak IdP   │
│  React       │ ◄── access_token ─│  MFA / federated│
└──────┬───────┘                   └─────────────────┘
       │ Bearer JWT
       ▼
┌──────────────┐   enqueue    ┌──────────────────────────────┐
│  API :8081   │ ───────────► │  Postgres jobs (default SoT) │
│  Hono        │              │  + optional NATS/Rabbit/Pulsar│
└──────┬───────┘              └──────────────┬───────────────┘
       │ sessions / findings                 │ claim
       ▼                                     ▼
┌──────────────┐                    ┌─────────────────┐
│  Postgres    │                    │  Workers (HPA / │
│  product SoT │                    │  KEDA optional) │
└──────────────┘                    └────────┬────────┘
                                             │
              ┌──────────────────────────────┼────────────────────────┐
              ▼                              ▼                        ▼
     Codesteward Graph MCP           Model router              Sandbox / Prove
     GraphQLite · Neo4j · Janus      OpenAI · Anthropic · xAI   local · docker · k8s
```

| Layer | Role |
|-------|------|
| **UI** | Product surface; browser holds OIDC tokens |
| **API** | Validates JWT / API key; enqueues reviews; webhooks |
| **Worker** | Orchestrator, specialists, judge, SCM publish |
| **Graph** | Structural intelligence via MCP |
| **Queue** | Postgres by default; optional broker for KEDA depth scaling |

---

## Quick start

### Category stack (recommended demo)

Full stack: Postgres, Graph MCP, API, worker, UI, Keycloak.

```bash
export OPENAI_API_KEY=sk-...   # or compatible provider
pnpm install && pnpm -r run build

pnpm compose:category
# UI  → http://localhost:8080
# API → http://localhost:8081
# IdP → http://localhost:8083  (admin / admin for Keycloak console)
```

Sign in via the platform IdP (Codesteward-themed Keycloak).  
Demo app user (realm seed): `admin@demo.com` / `DemoAdmin.123`.

```bash
pnpm compose:category:down
```

### Local packages (dev)

```bash
pnpm install && pnpm -r run build

# Optional durable state
export DATABASE_URL=postgres://steward:steward@localhost:5432/codesteward
pnpm migrate

export MODEL_PROVIDER=openai-compatible OPENAI_API_KEY=sk-...
pnpm dev:api      # :8081
pnpm dev:worker
pnpm dev:ui       # :8080
```

### CLI

```bash
pnpm stew -- doctor full
pnpm stew -- review -p . -r codesteward --tier thorough --depth thorough
pnpm stew -- steward -p . -r codesteward
pnpm stew -- findings export --sarif -s <sessionId>
pnpm stew -- ask "What does a review unit cover?"
```

### GitHub Action

```yaml
permissions:
  contents: read
  pull-requests: write
  checks: write
  security-events: write   # Code Scanning / Security tab SARIF upload

- uses: ./actions/review-action
  with:
    risk-tier: full
    publish: "true"
    fail-on: high
    sarif-output: codesteward.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    # Worker/API path also uploads SARIF when publishing to GitHub (set 0 to disable)
    STEW_PUBLISH_SARIF: "1"

# Optional: upload the Action-written file via CodeQL action (needs security-events)
- uses: github/codeql-action/upload-sarif@v4
  if: always()
  with:
    sarif_file: codesteward.sarif
    category: codesteward/gate
```

**Security tab:** Codesteward can push SARIF into **Security → Code scanning** when code scanning is enabled on the repo and the token/app has `security_events: write`. That is separate from PR review comments and the **Checks** tab (`codesteward/gate` check run).

---

## Product capabilities

### Review pipeline

Specialists (correctness, security, performance, testing, rules, …) → optional discourse (thorough) → verifier → judge → noise filter → gate verdict → SCM publish (inline comments + check run + optional **SARIF → Code Scanning / Security tab**).

### Policy

- **`STEWARD.md`** — severity floor, nits, skip globs, verification bar  
- **`.codesteward/rules/**/*.md`** — path-scoped guidance  
- Always loaded from the **base / default branch**, not PR head alone  

### Webhooks & mentions

```bash
# GitHub App webhook
# https://<public-api-host>/v1/webhooks/github

# On a PR comment (default mention token):
@codesteward review
```

Override with `STEW_MENTION_TOKEN`. Events: `pull_request` (opened / synchronize / reopened / ready_for_review) and `issue_comment` for mentions.

### Identity & orgs

- **Keycloak** as identity SoT (groups `/orgs/{slug}`, roles `steward-admin|reviewer|viewer`)  
- SPA OIDC login; API validates access tokens via JWKS  
- Org slug auto-generated from name (409 on collision)  
- Optional SCIM: `/scim/v2/orgs/{orgId|slug}` with per-org bearer

### Learning

React 👍/👎 on findings, set false-positive / won’t-fix — org memories feed the next review prompt. SARIF export for GHAS / other tools.

### Scaling

| Concern | Approach |
|---------|----------|
| More concurrent reviews | Scale **workers** (`STEW_MAX_CONCURRENT` specialists per job) |
| More HTTP / webhooks | Scale **API** (JWT auth is stateless) |
| More UI traffic | Scale **UI** (static nginx) |
| Queue-depth autoscaling | Optional `STEW_QUEUE_BROKER=nats\|rabbitmq\|pulsar` + KEDA |

```bash
# Minimal: Postgres only for jobs
DATABASE_URL=postgres://...

# Optional hybrid (PG SoT + broker for KEDA)
STEW_QUEUE_BROKER=rabbitmq
RABBITMQ_URL=amqp://...

# Helm workers
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set worker.hpa.maxReplicas=20 \
  --set worker.maxConcurrent=8
```

Compose brokers: `deploy/compose/docker-compose.queue.yml` (profiles `rabbitmq` / `nats`).

---

## Monorepo

```text
packages/
  core · model-router · graph-client · policy · findings
  learning · db · sandbox · scm · agents · webhooks
  api · cli · mcp-server · ui
services/worker          # job consumer
actions/review-action    # GitHub Action
deploy/compose           # demo + category + keycloak + queue
deploy/helm/codesteward  # production chart + HPA / KEDA
docs/                    # enterprise notes & session audit
```

| Script | Purpose |
|--------|---------|
| `pnpm build` | Build all packages |
| `pnpm compose:category` | Full product demo stack |
| `pnpm dev:api` / `dev:worker` / `dev:ui` | Local surfaces |
| `pnpm stew -- …` | CLI |
| `pnpm migrate` | Postgres migrations |

---

## Configuration sketch

```bash
# Graph
GRAPH_MOCK=0
GRAPH_MCP_URL=http://localhost:3000/sse   # or /mcp depending on transport

# Models
MODEL_PROVIDER=openai-compatible
MODEL_NAME=gpt-4.1-mini
OPENAI_API_KEY=
# STEW_MODEL_JUDGE=…  STEW_MODEL_CHEAP=…

# Auth (category stack sets these for Keycloak)
STEW_IDENTITY_MODE=keycloak
OIDC_ISSUER=http://keycloak:8083/realms/codesteward
OIDC_PUBLIC_ISSUER=http://localhost:8083/realms/codesteward
OIDC_CLIENT_ID=codesteward-ui

# Webhooks (public URL required for live GitHub)
STEW_WEBHOOK_PUBLIC_URL=https://your-tunnel.example
GITHUB_WEBHOOK_SECRET=...
STEW_MENTION_TOKEN=@codesteward
```

See [`.env.example`](.env.example) for the full template.

---

## Graph backends

| Backend | Use | Notes |
|---------|-----|--------|
| **GraphQLite** | Laptop / demo | Embedded SQLite graph |
| **Neo4j** | Production default | `deploy/compose/docker-compose.neo4j.yml` |
| **JanusGraph** | Large scale | Apache-2.0 path |
| **Mock** | CI | `GRAPH_MOCK=1` |

---

## Changelog & release

- **[CHANGELOG.md](./CHANGELOG.md)** — Keep a Changelog (current: **1.0.0**)
- **CI** — `.github/workflows/ci.yml` (build, typecheck, unit tests, Semgrep, zizmor, dependency-review)
- **Release** — tag `vX.Y.Z` → `.github/workflows/release.yml` publishes GHCR images + GitHub Release notes from the matching changelog section:

```bash
# First production release
git tag v1.0.0
git push origin v1.0.0
```

Images (lowercased repo path on GHCR):

| Image | Dockerfile |
|-------|------------|
| `ghcr.io/<owner>/<repo>` | `deploy/compose/Dockerfile.node` (API default; `SERVICE=worker` for workers) |
| `ghcr.io/<owner>/<repo>/ui` | `deploy/compose/Dockerfile.ui` |

**Codesteward Graph** (MCP) image used by compose stacks:

| Image | Source |
|-------|--------|
| `ghcr.io/codesteward/codesteward-graph` | [Codesteward/codesteward-graph](https://github.com/Codesteward/codesteward-graph/pkgs/container/codesteward-graph) |

Also: weekly security scans, OpenSSF Scorecard, Renovate (`renovate.json`).

---

## Status

Self-hosted dual-mode review platform with product UI, Keycloak identity, orgs, webhooks, and horizontal workers.

**This release** is free to run under Apache-2.0 — use your own models, keys, and infra.

Further reading in-repo:

- [`docs/ENTERPRISE_GAPS.md`](docs/ENTERPRISE_GAPS.md) — enterprise gaps and hard edges  
- [`docs/ENTERPRISE_SESSION_AUDIT.md`](docs/ENTERPRISE_SESSION_AUDIT.md) — session / audit notes  
- [`deploy/helm/codesteward/README.md`](deploy/helm/codesteward/README.md) — production chart  

---

## License

**Codesteward Review** is licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

You may use, modify, and self-host this software under the terms of that license.

**Codesteward Graph** (when used as a dependency or service) is separately distributed under Apache-2.0.

---

<p align="center">
  <strong>Govern · Verify · Evolve</strong>
</p>
