# CodeSteward Review — Independent Final GA Functional Validation

**Validator role:** Principal QA / release engineer (independent final functional GA gate)  
**Workspace:** `/Users/mrschneider/Projects/xai/codesteward`  
**Date:** 2026-07-12  
**Prior artifacts:** `evals/architect-ga-review.md`, `evals/architect-ga-review-r2.md`, `evals/validator-ga-review.md`, `evals/validator-ga-review-r2.md`, `evals/blocker-fixes-log.md`, `evals/GA-SHIPPED.md`  
**Scope:** Full monorepo build + tests + functional design-matrix acceptance (`scripts/ga-acceptance.mjs` against `evals/acceptance/ga-functional-matrix.json`) + targeted verification of bootstrap login, connectors PUT, inline worker, Diff empty state  
**Fixes applied this run:** none (no breakage found)

---

## Executive summary

Final functional GA acceptance is **green end-to-end**. No hotfixes required.

| Gate | Result |
|------|--------|
| `pnpm -r run build` | **PASS** (exit 0) |
| `pnpm test` | **PASS** (exit 0; 13 tests across core/webhooks/agents) |
| `node scripts/ga-acceptance.mjs` static matrix | **47/47 (100%)** |
| `node scripts/ga-acceptance.mjs` runtime smoke | **6/6 (100%)** including session `completed/completed` |
| OVERALL (script) | **PASS_GA_FUNCTIONAL** |
| Login bootstrap path (UI + API) | **PASS** |
| Connectors PUT (API + UI client + runtime) | **PASS** |
| Inline worker (code + runtime job completion) | **PASS** |
| Diff page empty state (no MOCK default) | **PASS** |

**Report artifact:** `evals/acceptance/latest-report.json`  
**Timestamp:** `2026-07-12T16:52:08.650Z`

---

## 1. Build

```bash
pnpm -r run build
```

| Result | Detail |
|--------|--------|
| **PASS** | Exit 0 |
| Scope | 17 of 18 workspace projects ran build |
| UI | `tsc --noEmit` + Vite production build OK (`dist/index.html`, CSS ~26.3 kB, JS ~312 kB gzip ~96 kB) |
| Packages | `core`, `db`, `model-router`, `graph-client`, `policy`, `sandbox`, `scm`, `webhooks`, `mcp-server`, `learning`, `findings`, `agents`, `cli`, `api`, `actions/review-action`, `services/worker` all compiled |

No TypeScript errors. No re-run needed.

---

## 2. Tests

```bash
pnpm test
```

| Package | Result |
|---------|--------|
| `@codesteward/core` | 2/2 pass (fingerprint stability) |
| `@codesteward/webhooks` | 5/5 pass (GitHub HMAC, GitLab token + HMAC) |
| `@codesteward/agents` | 6/6 pass (heal ladder, backoff, split, resume, coverage gap) |
| `@codesteward/learning` | empty suite (exit 0) |
| Other packages | `no tests` stubs — exit 0 |

**Overall:** exit 0, **0 failures**, **13** substantive tests passed.

---

## 3. Functional GA acceptance

```bash
node scripts/ga-acceptance.mjs
```

### 3.1 Static matrix (design §16 + SPA)

Source matrix: `evals/acceptance/ga-functional-matrix.json`  
Corpus: `packages/`, `services/`, `actions/`, `skills/`, `deploy/` (excludes `node_modules`, `dist`, `research`).

| Metric | Value |
|--------|-------|
| Passed | **47 / 47** |
| Rate | **100.0%** (threshold ≥ 98%) |
| RESULT | **PASS** |

All items green, including:

| ID | Name |
|----|------|
| RT-01…RT-14 | PR gate, mention, incremental, draft skip, staged, ref-range, scan, stewardship, guard, plain-diff, cross-repo, large PR map |
| CX-* | Diff packing, graph tools, STEWARD.md, ticket context |
| AA-* | Specialists, judge, verifier, DeepAgents, discourse, self-heal, conversation |
| OUT-* | SARIF, labels, diagram |
| NC-noise / LM-learning / EV-* | Noise, learning, prove, SAST, typecheck |
| SC-* | Multi-SCM adapters + webhooks (GitHub/GitLab/Bitbucket) |
| AUTH-login / AUTH-connectors | Login RBAC + connector PUT |
| DB-postgres / UI-all / WORKER-inline | Postgres, full UI page set, inline worker |
| DEPLOY-compose / DEPLOY-helm / ACTION / SKILLS / CLI-full | Deploy, GH Action, skills, CLI |
| ANALYTICS / OUTBOX / ARTIFACTS | Address rate, outbox, artifact store |

### 3.2 Runtime smoke

API process: `packages/api/dist/server.js`  
Env: `GRAPH_MOCK=1`, `STEW_INLINE_WORKER=1`, `STEW_USE_DEEPAGENTS=0`, isolated `STEW_DATA_DIR`, port `18081`.

| Check | Result | Detail |
|-------|--------|--------|
| RT-auth-status | ✓ | Bootstrap / mode present |
| RT-bootstrap | ✓ | `POST /v1/auth/bootstrap` returns token |
| RT-start-steward | ✓ | `POST /v1/reviews/stewardship` → session + job |
| RT-session-complete | ✓ | `completed/completed` (inline worker) |
| RT-connector-put | ✓ | `PUT /v1/org/connectors/github` |
| RT-auth-required | ✓ | Unauthenticated `GET /v1/sessions` → 401 |

| Metric | Value |
|--------|-------|
| Runtime | **6 / 6 (100%)** |
| Threshold | ≥ 90% **and** session complete must pass |
| RESULT | **PASS** |

### 3.3 Overall script verdict

```text
OVERALL: PASS_GA_FUNCTIONAL
```

Written to `evals/acceptance/latest-report.json` with `"overall": "PASS_GA_FUNCTIONAL"`.

---

## 4. Targeted feature verification

### 4.1 Login bootstrap path (UI)

| Evidence | Location |
|----------|----------|
| Page | `packages/ui/src/pages/Login.tsx` |
| Status probe | `api.authStatus()` → `bootstrapRequired` |
| Bootstrap call | `api.authBootstrap({ email, password, name })` → `POST /v1/auth/bootstrap` |
| UX | When `bootstrapRequired`: title **"Create admin"**, display-name field, CTA **"Create admin & continue"** |
| Gate | `App.tsx` `RequireAuth`: if `status.bootstrapRequired` → navigate `/login` |
| Client API | `packages/ui/src/lib/api.ts` `authBootstrap` / `authLogin` / `authStatus` |
| Runtime | RT-bootstrap ✓ |

**Verdict: PASS** — first-run bootstrap path is fully wired UI → API.

### 4.2 Connectors PUT

| Evidence | Location |
|----------|----------|
| API | `packages/api/src/app.ts` — `app.put("/v1/org/connectors/:type", …)` upserts via `globalConnectorsStore` |
| UI client | `packages/ui/src/lib/api.ts` — `putConnector(type, body)` method PUT |
| UI page | `packages/ui/src/pages/Connectors.tsx` — connector list/edit flow |
| Matrix | AUTH-connectors checks `PUT /v1/org/connectors` |
| Runtime | RT-connector-put ✓ (`PUT …/github` with token body) |

**Verdict: PASS**

### 4.3 Inline worker

| Evidence | Location |
|----------|----------|
| Implementation | `packages/api/src/worker-loop.ts` — `startInlineWorkerLoop`, default ON unless `STEW_INLINE_WORKER=0` |
| Job runner | `packages/api/src/run-job.ts` — shared `processJob` / `runReviewJob` |
| Server hook | `packages/api/src/server.ts` documents inline worker vs external worker |
| Matrix | WORKER-inline (`startInlineWorkerLoop`, `runReviewJob`) |
| Runtime | Acceptance sets `STEW_INLINE_WORKER=1`; RT-session-complete reached `completed/completed` without external worker process |

**Verdict: PASS** — inline worker processes stewardship jobs to completion in acceptance runtime.

### 4.4 Diff page — no MOCK default; empty state

| Evidence | Location |
|----------|----------|
| Page | `packages/ui/src/pages/Diff.tsx` |
| MOCK references | **None** in Diff.tsx (grep: 0 matches) |
| Defaults | `owner`/`repo`/`prNumber` start as `""`; provider default `"github"` only |
| Empty state | `EmptyState` title **"Load a PR"**, description prompts provider/owner/repo/PR or session with `prNumber` |
| Load path | `api.getPrDiff(...)` against real SCM connectors; errors banner to Connectors page |
| Subtitle | "Load a real pull request diff from your configured SCM connector." |

**Verdict: PASS** — Diff is connector-driven with a clean empty state; not MOCK-first.

---

## 5. Cross-check vs design matrix intent

Functional coverage maps to `research/design/05-full-product-architecture.md` §16 and SPA surface via `ga-functional-matrix.json`:

- Gate + stewardship entrypoints (API + CLI + webhooks)
- Agent pipeline (specialists, judge, verifier, discourse, self-heal, DeepAgents optional)
- Evidence tools (prove, SAST, typecheck) + outputs (SARIF, labels, diagram)
- Multi-SCM + multi-webhook + connectors config
- Auth bootstrap/login RBAC, Postgres path, deploy (compose/helm), GH Action, skills
- Product UI page set including Login, Connectors, Diff
- Inline worker for self-host completion without a separate process

Runtime smoke proves the critical self-host loop: **bootstrap → auth → start stewardship → inline worker completes session → connector PUT → unauth blocked**.

---

## 6. Residual notes (non-blocking)

These do **not** fail functional GA; recorded for awareness:

1. **Unit test surface** is thin outside `core` / `webhooks` / `agents`; many packages intentionally stub `no tests`. Functional acceptance compensates with matrix + runtime smoke.
2. **Runtime smoke uses `GRAPH_MOCK=1`** for offline graph; product still supports real graph MCP (connectors test path for `graph_mcp`).
3. **DeepAgents disabled** in acceptance (`STEW_USE_DEEPAGENTS=0`); matrix still verifies DeepAgent code presence.
4. Graph MCP status at validation time: GraphQLite backend connected; full rebuild not required for this functional gate.

---

## 7. Verdict

| Criterion | Met? |
|-----------|------|
| Build exit 0 | Yes |
| Tests exit 0 | Yes |
| Static matrix ≥ 98% | Yes (100%) |
| Runtime ≥ 90% + session complete | Yes (100%, completed) |
| OVERALL PASS_GA_FUNCTIONAL from script | Yes |
| Login bootstrap path | Yes |
| Connectors PUT | Yes |
| Inline worker runs | Yes |
| Diff empty state (no MOCK default) | Yes |

### VERDICT: PASS_GA_FUNCTIONAL

Double-check confirmation: functional GA acceptance PASS against research design matrix.
