# CodeSteward Review — Principal Architect Final GA Gate

**Reviewer role:** Principal software architect (strict, evidence-based)  
**Workspace:** `/Users/mrschneider/Projects/xai/codesteward`  
**Date:** 2026-07-12  
**Gate applied:** Functional GA acceptance (`scripts/ga-acceptance.mjs`) + design §1.3 non-negotiables  
**Prior structural reviews:** `evals/architect-ga-review.md` (NOT_READY) → `evals/architect-ga-review-r2.md` (READY_FOR_GA structural)  
**This document:** Final dual-mode product GA claim against functional matrix + runtime smoke

---

## 1. Executive verdict

# **PASS**

| Gate | Result |
|------|--------|
| `node scripts/ga-acceptance.mjs` | **OVERALL: PASS_GA_FUNCTIONAL** |
| Static functional matrix | **47/47 (100.0%)** |
| Runtime smoke | **6/6 (100.0%)** incl. session `completed/completed` |
| Design §1.3 non-negotiables (self-hosted scope) | **Met** |
| Enterprise SSO/OIDC/SAML | **Optional** (design-allowed; not a hard blocker) |

The dual-mode self-hosted CodeSteward Review product is **operable as GA for the designed scope**: PR/MR gate + branch stewardship, auth (bootstrap/login/RBAC + API key), connector configure API, inline worker completing sessions, multi-SCM webhooks, self-heal, discourse, mermaid diagram output, CLI ref-range (`--from`/`--to`), Postgres migrations, Helm, agent skills, and GitHub Action.

This is **not** a claim of Greptile-depth polish on every §16 aspirational row, nor multi-tenant SaaS isolation, nor full IdP SSO. It **is** an honest claim that the functional matrix + live API smoke are green and the self-hosted dual-mode product ships against the research design matrix with enterprise SSO remaining optional.

---

## 2. Acceptance run (authoritative)

**Command:**

```bash
node /Users/mrschneider/Projects/xai/codesteward/scripts/ga-acceptance.mjs
```

**Outcome (2026-07-12):**

```text
=== GA Functional Matrix (static) ===
✓ RT-01 … ARTIFACTS   (all items)
Static: 47/47 (100.0%)

=== GA Runtime Smoke ===
✓ RT-auth-status
✓ RT-bootstrap
✓ RT-start-steward
✓ RT-session-complete — completed/completed
✓ RT-connector-put
✓ RT-auth-required
Runtime: 6/6 (100.0%)

OVERALL: PASS_GA_FUNCTIONAL
```

**Artifact:** `evals/acceptance/latest-report.json`  
**Matrix source:** `evals/acceptance/ga-functional-matrix.json`  
(`research/design/05-full-product-architecture.md` §16 + SPA surface)

### Runtime smoke what it proves

| Check | Proof |
|-------|--------|
| `RT-auth-status` | Open/bootstrap status advertised |
| `RT-bootstrap` | First admin via `POST /v1/auth/bootstrap` returns session token |
| `RT-start-steward` | `POST /v1/reviews/stewardship` creates session + job |
| `RT-session-complete` | **Inline worker** drives session to `completed` (not stuck pending) |
| `RT-connector-put` | `PUT /v1/org/connectors/github` persists config under auth |
| `RT-auth-required` | Unauthenticated `GET /v1/sessions` → **401** after users exist |

Smoke env: `GRAPH_MOCK=1`, `STEW_INLINE_WORKER=1`, `STEW_USE_DEEPAGENTS=0`, isolated `STEW_DATA_DIR`.

---

## 3. Functional matrix coverage (47 items)

Matrix requires `require_all: true`. Static scanner walks packages/services/actions/skills/deploy (excludes research) for code symbols, API routes, UI pages, CLI commands, and deploy files.

### Review triggers & modes

| ID | Capability | Evidence (representative) |
|----|------------|---------------------------|
| RT-01 | PR automated review | `POST /v1/reviews/gate`, `POST /v1/webhooks/github` |
| RT-02 | Mention `@codesteward` | webhook issue_comment path |
| RT-03 | Incremental re-review | `lastReviewedSha` / `fullReview` |
| RT-04 | Draft PR skip | draft handling |
| RT-05 | Local staged review | CLI `review` |
| RT-07 | Branch ref-range | CLI `--from` / `--to` |
| RT-08 | Full scan | CLI `scan` |
| RT-09 | Stewardship mode | `POST /v1/reviews/stewardship` (runtime-proven) |
| RT-10 | Git guardrails | CLI `guard` |
| RT-11 | Plain-diff | stdin / plainDiff |
| RT-12 | Cross-repo links | `PUT /v1/org/repo-links`, SCM repos list |
| RT-14 | Large PR map | prMap / sectionMap / file_batch |

### Context, agents, outputs

| ID | Capability | Spot-check |
|----|------------|------------|
| CX-diff / CX-graph / CX-policy / CX-ticket | Diff pack, graph tools, STEWARD.md, tickets | present in packages |
| AA-specialists / AA-judge / AA-verifier / AA-deep | Specialist pipeline + DeepAgents runner | `packages/agents` |
| AA-discourse | AGREE/CHALLENGE/CONNECT/SURFACE | `packages/agents/src/discourse.ts` |
| AA-selfheal | `runUnitWithHeal`, ladder + tests | `packages/agents/src/self-heal.ts` |
| AA-conversation | Conversation agent route | `extra-routes.ts` |
| OUT-sarif / OUT-labels / OUT-diagram | SARIF, labels, **mermaid** | `packages/agents/src/diagram.ts` |
| NC-noise / LM-learning | Noise stack + reactions/memories | findings/learning packages |
| EV-prove / EV-sast / EV-typecheck | Prove sandbox, SAST, typecheck tools | sandbox + agents |
| ANALYTICS / OUTBOX / ARTIFACTS | Address rate, scm_delivery outbox, S3/MinIO | code present |

### SCM, auth, data, UI, deploy

| ID | Capability | Spot-check |
|----|------------|------------|
| SC-multi | GitHub, GitLab, Bitbucket, Azure DevOps, Gitea adapters | `packages/scm/src/*` |
| SC-webhooks | GitHub + GitLab handlers | `app.ts` dedicated routes |
| SC-bb-webhook | Bitbucket (+ gitea, azure-devops) | `extra-routes.ts` multi-provider loop |
| AUTH-login | Bootstrap + login + roles | `auth-store` / middleware `viewer|reviewer|admin` |
| AUTH-connectors | Connector CRUD + test | `PUT /v1/org/connectors/:type` (runtime-proven) |
| DB-postgres | `DATABASE_URL`, migrate, `review_sessions` | migrations `001`–`004` |
| UI-all | Login, Sessions, Connectors, Diff, CrossRepo, Models, Policy, Analytics, Settings, Findings, Dashboard | `packages/ui/src/pages/*.tsx` |
| WORKER-inline | `startInlineWorkerLoop` + `runReviewJob` | `server.ts` + `worker-loop.ts` (runtime-proven) |
| DEPLOY-compose | demo + neo4j + janusgraph compose | `deploy/compose/` |
| DEPLOY-helm | Chart + worker HPA | `deploy/helm/codesteward/` |
| ACTION | GH Action | `actions/review-action/action.yml` |
| SKILLS | steward-review / map / security | `skills/*/SKILL.md` |
| CLI-full | review, steward, scan, resume, export, guard, ask, config | `packages/cli/src/index.ts` |

---

## 4. Spot-checks (product operability)

Beyond substring presence, independent code inspection:

| Surface | Status | Path / note |
|---------|--------|-------------|
| Login / RBAC | **OK** | Modes `open` → `api_key` → `users`; roles `admin` / `reviewer` / `viewer`; write guards in `packages/api/src/middleware/auth.ts` |
| Connector configure API | **OK** | GET/PUT/DELETE/test under `/v1/org/connectors`; UI + runtime PUT smoke |
| Inline worker completes sessions | **OK** | Runtime: stewardship session → `completed/completed` with `STEW_INLINE_WORKER=1` |
| Multi-SCM webhooks | **OK** | GitHub + GitLab full handlers; Bitbucket/Gitea/Azure DevOps accept+enqueue in `extra-routes.ts` |
| Self-heal | **OK** | `runUnitWithHeal`, strategy ladder, unit tests `self-heal.test.ts` |
| Discourse | **OK** | Dual-panel synthesis moves AGREE/CHALLENGE/CONNECT/SURFACE |
| Mermaid diagram | **OK** | `buildReviewMermaid` emits fenced mermaid flowchart |
| CLI `--from` / `--to` | **OK** | Registered on review/steward commands (`packages/cli/src/index.ts` L67–90) |
| Postgres migrations | **OK** | `001_init`, `002_session_self_heal`, `003_session_checkpoints`, `004_users_auth` |
| Helm | **OK** | Chart.yaml, api/worker, postgres optional, secret/`DATABASE_URL`, worker-hpa |
| Skills | **OK** | three skill packages with SKILL.md |
| Action | **OK** | `actions/review-action/action.yml` dual-mode inputs |
| Dual-mode APIs | **OK** | `POST /v1/reviews/gate` + `POST /v1/reviews/stewardship` |

---

## 5. Design §1.3 non-negotiables

From `research/design/05-full-product-architecture.md` §1.3 (incl. 2026-07 honesty note):

| # | Commitment | Assessment |
|---|------------|------------|
| 1 | Dual mode: Gate + Stewardship | **IN** — API, CLI, worker, runtime stewardship completion |
| 2 | Graph backends: GraphQLite demo; Neo4j **or** JanusGraph prod | **IN** — mock + compose stacks for both engines |
| 3 | DeepAgents TS preferred + escape hatch | **IN** — optional peer; SimpleAgentRunner default; smoke used non-deep path |
| 4 | Compose + Kubernetes (workers, API, UI, graph, sandboxes) | **IN** — compose + Helm (worker HPA, sandbox docs) |
| 5 | Sandbox Prove (local/docker; k8s path) | **IN** — local/docker production path; k8s with fallback (prior R2 evidence) |
| 6 | Scale-out via horizontal workers | **IN** — worker service + HPA + concurrency env |
| 7 | Multi-model (OpenAI/Anthropic/xAI/compat/LiteLLM) | **IN** — model-router package |
| 8 | Cross-repo org links + fan-out | **IN** — API + UI CrossRepo page |
| 9 | Full product UI | **IN** — 11 required pages present |
| 10 | CLI + MCP + Action + skills | **IN** — all four surfaces |
| 11 | Noise, STEWARD.md, learning, discourse, guardrails, multi-SCM | **IN** |
| 12 | Self-host / BYOK / air-gap capable | **IN** — file or Postgres stores; GRAPH_MOCK; BYOK model keys |
| — | API key auth, Postgres SoT, multi-SCM webhooks (GH+GL), learning dual-store, checkpoints, Helm `DATABASE_URL` | **IN** (honesty note items) |
| — | **Enterprise SSO/OIDC/SAML** | **Optional enhancement** — design explicitly allows GA without full IdP RBAC |

**Non-goals still out of scope (correct):** full AppSec platform, stacked-PR product, Slack marketplace primary surface, hosted-only fleets, replacing customer SCM/CI.

---

## 6. Residual risks (non-blocking for this gate)

These do **not** reverse PASS under the defined self-hosted GA bar:

1. **SSO/OIDC/SAML** — status advertising / optional env only; full IdP integration is post-GA enterprise enhancement (design-allowed).
2. **Webhook depth variance** — GitHub/GitLab are signature-validated full handlers; Bitbucket/Gitea/Azure DevOps are thinner accept+enqueue surfaces. Multi-SCM **adapters** exist for all five; webhook parity is GA-surface, not equal maturity.
3. **Static matrix is presence-based** — symbols/files/routes; runtime smoke covers the critical control loop (auth → start → complete → connectors → 401). Deep integration E2E against live GitHub/GitLab or real Neo4j is operator dogfood, not this gate.
4. **Org isolation** — single-tenant self-host model; not multi-tenant SaaS hard isolation.
5. **Success metrics (§1.5)** — address rate, noise %, latency SLOs require production dogfood telemetry; product **implements** analytics hooks (address rate) but customer metrics are not part of ship-gate PASS.

None of the above are **hard blockers** for self-hosted dual-mode GA as defined.

---

## 7. Hard blockers

**None.**

---

## 8. Verdict summary

| Criterion | Met? |
|-----------|------|
| Functional matrix 100% (or ≥98% with require_all) | **Yes — 47/47** |
| Runtime smoke green including session completion | **Yes — 6/6** |
| `OVERALL: PASS_GA_FUNCTIONAL` | **Yes** |
| Dual-mode operable self-hosted product | **Yes** |
| §1.3 non-negotiables for self-host scope | **Yes** |
| Enterprise SSO optional (not required) | **Yes** |

# **PASS**

I confirm functional GA is shipped for the self-hosted CodeSteward Review product against the research design matrix (enterprise SSO remains optional).
