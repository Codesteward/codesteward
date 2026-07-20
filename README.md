<p align="center">
  <img src="docs/static/img/readme/logo-chip.png" alt="Codesteward — Govern · Verify · Evolve" width="300" />
</p>

<h1 align="center">Codesteward Review</h1>

<p align="center">
  <strong>Agentic code review that knows your graph.</strong><br />
  Gate every merge. Steward every branch. Self-hosted.
</p>

<p align="center">
  <a href="https://github.com/Codesteward/codesteward/releases"><img src="https://img.shields.io/github/v/release/Codesteward/codesteward?include_prereleases&sort=semver&label=release" alt="Release" /></a>
  <a href="https://github.com/Codesteward/codesteward/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Codesteward/codesteward/ci.yml?branch=main&label=ci" alt="CI" /></a>
  <a href="https://github.com/Codesteward/codesteward/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Codesteward/codesteward" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=nodedotjs&logoColor=white" alt="Node ≥ 22" />
  <img src="https://img.shields.io/badge/pnpm-9-f69220?logo=pnpm&logoColor=white" alt="pnpm 9" />
  <img src="https://img.shields.io/badge/TypeScript-ESM-3178c6?logo=typescript&logoColor=white" alt="TypeScript ESM" />
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache-2.0" /></a>
</p>

<p align="center">
  <a href="https://codesteward.ai">Website</a> ·
  <a href="https://docs.codesteward.ai">Docs</a> ·
  <a href="deploy/compose/docker-compose.category.yml">Category stack</a> ·
  <a href="deploy/helm/codesteward">Helm</a> ·
  <a href="deploy/cloud">Cloud one-click</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/static/img/readme/dashboard-home.png" alt="Codesteward dashboard — sessions, findings, live activity" width="900" />
</p>

<p align="center">
  <em>Product UI: dual-mode control plane — gate merges, steward long-lived branches, track findings and live agent activity.</em>
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

<p align="center">
  <img src="docs/static/img/readme/session-blade.png" alt="Session stage pipeline and review report" width="900" />
</p>

<p align="center">
  <em>Session detail: stage pipeline, specialist timing, narrative report, and resume controls.</em>
</p>

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

```mermaid
flowchart TB
  subgraph Client
    UI["UI :8080<br/>React SPA"]
  end

  subgraph Identity
    KC["Keycloak IdP<br/>OIDC · MFA · federated"]
  end

  subgraph ControlPlane
    API["API :8081<br/>Hono"]
    PG[("Postgres<br/>sessions · findings · jobs SoT")]
  end

  subgraph Compute
    W["Workers<br/>HPA / KEDA optional"]
    Q["Job queue<br/>Postgres default<br/>+ NATS / Rabbit / Pulsar"]
  end

  subgraph Intelligence
    G["Codesteward Graph MCP<br/>GraphQLite · Neo4j · Janus"]
    M["Model router<br/>OpenAI · Anthropic · SpaceXAI · …"]
    S["Sandbox / Prove<br/>local · docker · k8s"]
  end

  UI -->|"SPA OIDC PKCE"| KC
  UI -->|"Bearer JWT"| API
  API --> PG
  API -->|"enqueue"| Q
  Q -->|"claim"| W
  W --> PG
  W --> G
  W --> M
  W --> S
```

| Layer | Role |
|-------|------|
| **UI** | Product surface; browser holds OIDC tokens |
| **API** | Validates JWT / API key; enqueues reviews; webhooks |
| **Worker** | Orchestrator, specialists, judge, SCM publish |
| **Graph** | Structural intelligence via MCP |
| **Queue** | Postgres by default; optional broker for KEDA depth scaling |

---


## Deploy to your cloud

<p align="center">
  <strong>Try Codesteward in your own cloud account.</strong><br />
  Single VM · nginx edge (HTTPS) · <strong>Keycloak</strong> · API · worker · UI · Postgres<br />
  <em>No LLM key at install — add providers in Settings → Models after login.</em>
</p>

<br />

<p align="center">
  <a href="https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=https://raw.githubusercontent.com/Codesteward/codesteward/main/deploy/cloud/aws/cloudformation.yaml&stackName=codesteward">
    <img src="docs/static/img/readme/deploy/aws.png" alt="Launch on AWS" width="200" height="35" />
  </a>
  &nbsp;&nbsp;
  <a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FCodesteward%2Fcodesteward%2Fmain%2Fdeploy%2Fcloud%2Fazure%2Fazuredeploy.json">
    <img src="docs/static/img/readme/deploy/azure.png" alt="Deploy to Azure" width="200" height="35" />
  </a>
</p>
<p align="center">
  <a href="https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/Codesteward/codesteward&cloudshell_git_branch=main&cloudshell_working_dir=deploy/cloud/gcp&cloudshell_tutorial=tutorial.md">
    <img src="docs/static/img/readme/deploy/gcp.png" alt="Open in Google Cloud Shell" width="200" height="35" />
  </a>
  &nbsp;&nbsp;
  <!-- DO: no Marketplace product listing yet — doctl/user-data installs Codesteward (not the Docker marketplace app) -->
  <a href="https://github.com/Codesteward/codesteward/blob/main/deploy/cloud/do/README.md">
    <img src="docs/static/img/readme/deploy/digitalocean.png" alt="Deploy on DigitalOcean" width="200" height="35" />
  </a>
</p>

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

Override with `STEW_MENTION_TOKEN`.

**GitHub App webhook events:** `pull_request` (opened / synchronize / reopened / ready_for_review for **gate**; **closed + merged** for **outcome**); `issue_comment` (mentions); `pull_request_review_thread` (resolved/unresolved → soft accept); `security_advisory` (coverage / FN candidates). See [SCM connectors](docs/docs/configure/connectors.md).

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
| Broker disaster recovery | Workers still claim from Postgres; platform ops can **republish** pending jobs to rehydrate broker depth |

```bash
# Minimal: Postgres only for jobs
DATABASE_URL=postgres://...

# Optional hybrid (PG SoT + broker for KEDA)
STEW_QUEUE_BROKER=rabbitmq
RABBITMQ_URL=amqp://...

# After broker message loss (platform operator):
#   GET  /v1/platform/queue
#   POST /v1/platform/queue/republish   # body: { "limit": 500 } optional
# Or UI: Settings → Platform ops → Job queue recovery

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
docs/                 # Docusaurus product & operator docs (Cloudflare-ready)
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
GRAPH_MCP_MODE=stdio                 # embedded codesteward-mcp in the worker
GRAPH_BACKEND=neo4j                  # or graphqlite / janusgraph
# NEO4J_URI=bolt://localhost:7687

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

## Pull-only deploy (Compose / Swarm)

No monorepo clone — **one compose file** (optional second for Swarm). Published GHCR images only.

```bash
# Docker Compose (single host) — only this file:
curl -fsSL -o docker-compose.stack.yml \
  https://raw.githubusercontent.com/Codesteward/codesteward/main/deploy/compose/docker-compose.stack.yml
export STEW_SECRETS_KEY=$(openssl rand -hex 32)
docker compose -f docker-compose.stack.yml pull && docker compose -f docker-compose.stack.yml up -d
```

Swarm: also download `docker-compose.stack.swarm.yml`, then  
`docker compose -f docker-compose.stack.yml -f docker-compose.stack.swarm.yml config | docker stack deploy -c - codesteward --with-registry-auth`.

## Changelog & release

- **[CHANGELOG.md](./CHANGELOG.md)** — Keep a Changelog (current: **1.4.0**)
- **CI** — `.github/workflows/ci.yml` (build, typecheck, unit tests, Semgrep, zizmor, dependency-review)
- **Release** — tag `vX.Y.Z` → `.github/workflows/release.yml` publishes GHCR images + GitHub Release notes from the matching changelog section:

```bash
# After CHANGELOG has ## [1.4.0] and versions are bumped
git tag v1.4.0
git push origin v1.4.0
```

Images ([Codesteward/codesteward](https://github.com/Codesteward/codesteward) → GHCR, lowercased):

| Image | Dockerfile | Tags |
|-------|------------|------|
| `ghcr.io/codesteward/codesteward` | `deploy/compose/Dockerfile.node` (API; `SERVICE=worker` for workers) | product semver (`1.4.0`) |
| `ghcr.io/codesteward/codesteward/ui` | `deploy/compose/Dockerfile.ui` | product semver |
| `ghcr.io/codesteward/codesteward/keycloak` | `deploy/compose/keycloak/Dockerfile` | **upstream Keycloak** (`26.7.0`, not product) |
| Helm chart `oci://ghcr.io/codesteward/codesteward/charts/codesteward` | `deploy/helm/codesteward` | product semver |

**Codesteward Graph** (MCP) image used by compose stacks:

| Image | Source |
|-------|--------|
| Embedded `codesteward-mcp` (PyPI) in worker image | Graph MCP stdio — no separate graph container |

Also: weekly security scans, OpenSSF Scorecard, Renovate (`renovate.json`).

---

## Status

Self-hosted dual-mode review platform with product UI, Keycloak identity, orgs, webhooks, and horizontal workers.

**This release** is free to run under Apache-2.0 — use your own models, keys, and infra.

Further reading:

- **[Documentation site](./docs)** (`docs/`) — Docusaurus product & operator handbook (UI guide, pipeline, multi-tenant workers, session audit). Local: `pnpm dev:docs`. Publish `docs/build` to Cloudflare Workers (`docs/wrangler.toml`).  
- Public docs URL: set `url` in `docs/docusaurus.config.ts` (default `https://docs.codesteward.ai`).  
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
