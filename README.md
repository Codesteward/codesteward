# CodeSteward Review

> **Functional GA (self-hosted)** — design matrix + runtime smoke green (`node scripts/ga-acceptance.mjs`).  
> Confirmations: `evals/architect-ga-final.md`, `evals/validator-ga-final.md`, `evals/GA-SHIPPED.md`.  
> Enterprise SSO remains optional. Not a hosted multi-tenant SaaS GA.

**Review every change. Steward every branch.**

Open-source **agentic code review + codebase stewardship** platform built on
[Codesteward Graph](https://github.com/Codesteward/codesteward) — dual-mode
parity for **PR/MR gates** and **branch/path/full-tree stewardship**, one
finding schema, one policy model, multi-specialist agents, multi-provider LLMs,
and a full product UI.

> Architecture (target GA design): [`research/design/05-full-product-architecture.md`](research/design/05-full-product-architecture.md)  
> Framework ADR: [`research/design/04-framework-decision.md`](research/design/04-framework-decision.md)

## Features (beta foundation)

| Capability | Package / surface |
|------------|-------------------|
| Shared types & Zod schemas | `@codesteward/core` |
| Multi-provider model router | `@codesteward/model-router` |
| Graph MCP client (HTTP + mock) | `@codesteward/graph-client` |
| STEWARD.md + path rules | `@codesteward/policy` |
| Findings store + fingerprint + SARIF 2.1.0 | `@codesteward/findings` |
| Learning (👍/👎 reactions, org memories) | `@codesteward/learning` |
| Postgres data layer | `@codesteward/db` |
| Sandbox (local/docker/k8s stub/null) + Prove | `@codesteward/sandbox` |
| Multi-SCM (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea) | `@codesteward/scm` |
| Orchestrator + specialists + judge + discourse + noise + diff packing | `@codesteward/agents` |
| HTTP API (Hono) + SSE progress | `@codesteward/api` |
| CLI `stew` | `@codesteward/cli` |
| GitHub Action | `actions/review-action` |
| Worker | `@codesteward/worker` |
| Review MCP tools | `@codesteward/mcp-server` |
| Product UI | `@codesteward/ui` |

## Quick start (local demo)

Requirements: **Node ≥ 22**, **pnpm 9**.

```bash
pnpm install
pnpm -r run build

# Offline graph (no MCP required)
export GRAPH_MOCK=0
# GRAPH_MOCK=1  # unit tests / offline only — demos must use live graph

# Optional: durable Postgres (omit for .steward-data JSON files)
# export DATABASE_URL=postgres://steward:steward@localhost:5432/codesteward
# pnpm --filter @codesteward/db run migrate

# Optional LLM keys (without keys, router returns mock JSON)
export MODEL_PROVIDER=openai
export OPENAI_API_KEY=sk-...
# or ANTHROPIC_API_KEY / XAI_API_KEY / LITELLM_BASE_URL

# Terminal A — API
pnpm dev:api

# Terminal B — Worker
pnpm dev:worker

# Terminal C — UI
pnpm dev:ui
# open http://localhost:8080
```

### CLI (no API required)

```bash
pnpm stew -- config doctor
pnpm stew -- doctor full                 # deep checks (graph, docker, SCM tokens)
pnpm stew -- rules list -p .
pnpm stew -- graph status
pnpm stew -- review -p . -r codesteward --tier lite
pnpm stew -- review -p . -r codesteward --tier thorough --depth thorough
pnpm stew -- steward -p . -r codesteward
pnpm stew -- resume <sessionId>          # re-enqueue failed session via API
pnpm stew -- findings export --sarif -s <sessionId> -o out.sarif
pnpm stew -- export sarif -s <sessionId>
pnpm stew -- ask "Summarize what a review unit is"
```

### GitHub Action

```yaml
# .github/workflows/codesteward.yml
- uses: ./actions/review-action
  with:
    risk-tier: full
    publish: "true"
    fail-on: high
    sarif-output: codesteward.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    GRAPH_MOCK: "1"
```

### Learning & reactions

```bash
# Thumbs-down a finding (suppresses similar fingerprints on next judge)
curl -X POST http://localhost:8081/v1/findings/<id>/react \
  -H 'content-type: application/json' \
  -d '{"reaction":"👎","note":"false positive"}'

# List org memories
curl http://localhost:8081/v1/org/memories?orgId=local

# SARIF for a session
curl http://localhost:8081/v1/sessions/<id>/findings.sarif
```

### Docker Compose demo

```bash
cp deploy/compose/.env.example deploy/compose/.env
# edit keys as needed
docker compose -f deploy/compose/docker-compose.demo.yml up --build
# UI :8080  API :8081
# Real graph MCP:
# docker compose -f deploy/compose/docker-compose.demo.yml --profile graph up --build
```

## Architecture

```text
┌─────────────┐   ┌──────────────┐   ┌──────────────────┐
│  stew-ui    │──▶│  stew-api    │──▶│ file/NATS queue  │
│  :8080      │   │  :8081       │   └────────┬─────────┘
└─────────────┘   └──────────────┘            │
                      │                       ▼
                      │              ┌──────────────────┐
 CLI / MCP / Action ──┘              │  stew-worker     │
                                     │  orchestrator    │
                                     └─────┬────────────┘
                       ┌───────────────────┼───────────────────┐
                       ▼                   ▼                   ▼
              Codesteward Graph      Model router         Sandbox
              MCP :3000              (multi-provider)     (prove tier)
              GraphQLite|Neo4j|
              JanusGraph
```

### Dual mode

- **Gate** — PR/MR precision review: diff-scoped units, specialists, verifier, judge, optional SCM publish.
- **Stewardship** — branch/path/full tree: package-batched units, durable findings lifecycle.

### Graph backends

| Backend | Use | Env |
|---------|-----|-----|
| **GraphQLite** | Demo / laptop | `GRAPH_BACKEND=graphqlite` |
| **Neo4j** | Production | `NEO4J_URI=bolt://…` |
| **JanusGraph** | Large scale | `JANUSGRAPH_URL=ws://…` |
| **Mock** | CI / offline | `GRAPH_MOCK=1` |

Client: `GRAPH_MCP_URL=http://localhost:3000/mcp` (or SSE). Every call is
scoped with `tenantId` + `repoId`. Cross-repo: configure links in UI/API, then
`graph.queryAcross(links)`.

### Multi-provider models

```bash
MODEL_PROVIDER=openai|anthropic|xai|openai-compatible|litellm
MODEL_NAME=gpt-4.1
STEW_MODEL_JUDGE=…      # strong — judge/security/verifier
STEW_MODEL_CHEAP=…      # cheap — summary/generalist
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
XAI_API_KEY=            # OpenAI-compatible at https://api.x.ai/v1
OPENAI_BASE_URL=
LITELLM_BASE_URL=
```

Role routing: **judge/security → strong model**; **summary/generalist → cheap**.

### Agent runtime

- Default: `SimpleAgentRunner` (fetch-based chat completions, no LangChain required).
- Plug-in: `createDeepAgentRunner` + optional peerDep `deepagents` ≥1.10.7
  (see `packages/agents/src/runner.ts` and TDR-004).

Specialists: coordinator, generalist, correctness, security, performance,
testing, rules, requirements, discourse, evidence/prove, judge, verifier.

### Scaling to 50+ agents

```text
workers (K8s replicas) × STEW_WORKER_CONCURRENCY (jobs/pod)
                       × STEW_MAX_CONCURRENT (specialists/job, default 8)

Example: 8 worker pods × 4 jobs × 8 subagents ≈ 256 concurrent loops
Mega stewardship jobs split into ReviewUnits (package/path batches).
Prefer NATS JetStream subjects reviews.gate / reviews.steward / reviews.unit.
```

Do **not** pack 50 specialists into one Node process without a queue —
horizontal workers are the scale unit.

### Policy

- `STEWARD.md` — severity floor, nit caps, skip globs, verification bar
- `.codesteward/rules/**/*.md` — path-scoped guidance
- **Always load from base/default branch**, never PR head alone

### Sandbox / Prove

- `NullSandbox` — demo default
- `LocalSandbox` — host or `docker run`
- `K8sSandbox` — stub with production TODOs
- Prove jobs: generateTests + runTests + collectArtifacts

## Monorepo layout

```text
packages/
  core, model-router, graph-client, policy, findings,
  sandbox, scm, agents, api, cli, mcp-server, ui
services/
  worker          # @codesteward/worker
deploy/compose/   # demo stack
skills/           # agent skills (steward-review)
research/design/  # product architecture
```

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm build` | Build all packages |
| `pnpm dev:api` | API on :8081 |
| `pnpm dev:worker` | Job worker |
| `pnpm dev:ui` | Vite UI on :8080 |
| `pnpm stew -- …` | CLI |
| `pnpm compose:demo` | Docker demo |

## License

Foundation packages: intended for open-source release (align with project root
license when published). Graph substrate is Apache-2.0 upstream.


## Implemented foundation slices (complete)

| Slice | Status | How |
|-------|--------|-----|
| **DeepAgents TS** | Done | `@codesteward/agents` — `DeepAgentRunner` + graph/sandbox tools; `STEW_USE_DEEPAGENTS=1` |
| **GitHub webhook Gate** | Done | `POST /v1/webhooks/github` + signature verify + enqueue + worker SCM publish |
| **Compose + GraphQLite MCP** | Done | `deploy/compose/docker-compose.demo.yml` (`GRAPH_MOCK=0`) |
| **Cross-repo fan-out** | Done | Links CRUD + preview API + orchestrator BFS budgets |
| **Helm HPA workers** | Done | `deploy/helm/codesteward` — worker HPA min 2 / max 20 × 8 concurrent |

### GitHub App webhook

```bash
# Point GitHub App webhook to:
# https://<host>/v1/webhooks/github
export GITHUB_WEBHOOK_SECRET=...
export GITHUB_TOKEN=...   # or app installation token
pnpm dev:api
pnpm dev:worker
```

Events: `pull_request` opened / synchronize / reopened / ready_for_review → Gate review → PR review comments.

### Cross-repo

```bash
curl -X PUT localhost:8081/v1/org/repo-links -H 'content-type: application/json' \
  -d '{"fromRepoId":"org/frontend","toRepoId":"org/backend","edgeType":"depends_on_api","enabled":true}'
curl -X POST localhost:8081/v1/org/repo-links/preview -H 'content-type: application/json' \
  -d '{"repoId":"org/frontend","paths":["src/api/client.ts"]}'
```

### Helm scale (50+ units)

```bash
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set worker.hpa.maxReplicas=20 \
  --set worker.maxConcurrent=8
# Peak ≈ 20 pods × 8 = 160 concurrent specialists
```

## Local UI product loop

```bash
export GRAPH_MOCK=1 STEW_USE_DEEPAGENTS=0
pnpm -r run build
pnpm dev:api   # includes inline worker by default
pnpm dev:ui    # http://localhost:8080
# First visit: /login → bootstrap admin
# Sessions → Start stewardship (job runs in API process)
# Connectors → Configure GitHub token for real PR diffs / repo picker
```
