# CodeSteward Review — Principal Architect GA Readiness Double-Check

**Reviewer role:** Principal software architect (ruthless, evidence-based)  
**Workspace:** `/Users/mrschneider/Projects/xai/codesteward`  
**Date:** 2026-07-12  
**Bar applied:** `research/design/05-full-product-architecture.md` §1.3 + §16 (“all features committed”; marketing must not claim GA until checklist green)  
**Structural validator:** `node scripts/validate-ga.mjs` → **46/46 PASS (100%)** — treated as **non-authoritative** (path/symbol existence only; see §2)

---

## 1. Executive verdict

# **NOT_READY**

CodeSteward Review is a **credible Phase A–B foundation** with several genuinely differentiated pieces (dual-mode orchestrator, graph client, self-heal + checkpoints, discourse, multi-SCM *adapters*, Postgres schema, branded UI shell, CLI/Action/MCP surfaces). It is **not** a General Availability product against its own committed architecture.

The structural GA checklist passes because it mostly checks that files exist and contain keywords. It does **not** prove production behavior, multi-tenant security, deploy completeness, eval quality, or competitor-class feature depth.

**Marketing / release implication:** Do **not** ship as “GA full product.” Ship as **public preview / beta / foundation milestone** with an honest capability matrix, or cut/waive §16 items via written ADRs before any GA claim.

---

## 2. Evidence of what is truly implemented vs stub

### 2.1 Structural validator vs reality

| Signal | Result | Interpretation |
|--------|--------|----------------|
| `evals/ga-checklist.json` + `scripts/validate-ga.mjs` | 46/46 PASS | **Path existence + a few string symbols** (`heal`/`retry`, `completed_with_errors`, CSS `--accent`) |
| Product unit/e2e tests under `packages/*` | **None found** | No automated proof of orchestration, SCM, DB, UI |
| Architecture §16 all ✅ | Doc-level assertion | **Not matched by implementation depth** |

Validator design is honest about itself (“structural validator”) but is **dangerously easy to misread as GA proof**.

### 2.2 Truly implemented (production-usable with caveats)

| Area | Evidence | Caveats |
|------|----------|---------|
| **Core schemas** | `packages/core` Zod models (sessions, findings, jobs, events, cross-repo, heal statuses) | Solid foundation |
| **Orchestrator pipeline** | `packages/agents/src/orchestrator.ts` (~900 LOC): policy → graph rebuild → plan units → concurrent specialists → discourse (thorough) → verify → judge → noise → prove → publish; incremental gate via learning | Real control flow; quality depends on LLM + graph |
| **Self-heal** | `packages/agents/src/self-heal.ts` (~780 LOC) + README: retry_fresh_context → fallback_simple_runner → split_unit → skip_with_gap_note; checkpoints; `completed_with_errors`; partial SCM summary; worker resume; API resume/failures | Strong design; DB checkpoint path has FK issue (below) |
| **Discourse** | `packages/agents/src/discourse.ts`: dual correctness + AGREE/CHALLENGE/CONNECT/SURFACE | Real when thorough tier/depth; LLM-dependent |
| **DeepAgents runner** | `deep-agent-runner.ts`: dynamic import + graph/sandbox tools + fallback SimpleAgentRunner | Optional peer; degrades gracefully |
| **Specialists** | Prompt roles + graph grounding for security/correctness/evidence | Prompt-only specialists, not tool-rich loops unless DeepAgents path |
| **Noise stack (partial)** | Severity floor, dedupe, nit patterns, prior fingerprint convergence, comment caps, learning suppress fingerprints | **No embedding cosine cluster filter** (Greptile/Kodus-class) |
| **Policy** | STEWARD.md parse + path rules + defaults | Base-branch safety needs runtime verification per deploy |
| **Graph client** | HTTP MCP client + `GRAPH_MOCK` mock | stdio transport explicitly not implemented |
| **Multi-model router** | OpenAI-compatible + Anthropic + LiteLLM base URL / xAI via compat | Role routing + budget; not full multi-model “teams” UX |
| **SCM adapters** | Real REST `fetch` adapters: GitHub, GitLab, Bitbucket, Azure DevOps, Gitea | Unified interface; **webhooks only for GitHub** |
| **GitHub gate path** | Webhook PR opened/sync/reopen/ready_for_review; draft skip; signature verify; Action | Mention trigger not implemented; GH file list capped at 100 |
| **CLI** | `review`, `steward`, `scan`, `resume`, findings export SARIF, graph, rules, config doctor | Local + remote enqueue paths present |
| **API surface** | Hono REST: sessions, gate/stewardship, findings, react, memories, repo-links, SSE, webhooks/github, SARIF, model test | **No auth**; open CORS `*` |
| **Postgres package** | Migrations `001_init.sql` + `002_session_self_heal.sql`; repos for sessions, findings, jobs (SKIP LOCKED), links, configs, learning, checkpoints | Compose wires `DATABASE_URL`; **Helm does not** |
| **Jobs when DB on** | `PgJobQueue` claim via FOR UPDATE SKIP LOCKED | File queue otherwise; **NATS is stub** |
| **Findings / SARIF** | Lifecycle + SARIF 2.1.0 export | Findings prefer DB when `DATABASE_URL` |
| **Learning (file)** | Reactions, memories, last_reviewed_sha incremental | **Default factory is file JSON, not Postgres**, despite DB tables |
| **Sandbox local** | Host tmpdir + optional docker exec | Usable demo Prove path |
| **Prove (partial)** | LLM test gen + sandbox run when llm+finding provided | Without LLM: placeholder echo; **K8s path broken** |
| **UI shell** | 10 pages: Dashboard, Sessions, Findings, Diff, CrossRepo, Connectors, Models, Policy, Settings, Analytics; dark cyan brand tokens | Kodus-class IA present; depth uneven; Diff has mock findings |
| **GitHub Action** | End-to-end local orchestrator on PR event + SARIF | Graph mock default `1` in Action inputs risk |
| **MCP review tools** | Start gate/stewardship, list findings, etc. via API | Thin proxy |
| **Compose demo** | Postgres + graph-mcp + api + worker + ui | Production-shaped demo, not HA |
| **Cross-repo fan-out** | BFS over links + budgets in `agents/src/cross-repo/fanout.ts` | `packages/cross-repo/src` empty; real checkout of linked repos not fully platformized |
| **Concurrency knob** | Limiter + env max concurrent; Helm HPA on worker CPU | “50+ subagents” is **config math**, not load-tested |

### 2.3 Explicit stubs / incomplete vs architecture

| Item | Evidence | Architecture claim |
|------|----------|-------------------|
| **K8sSandbox** | `packages/sandbox/src/k8s.ts` — createSession sets `metadata.todo`, exec returns exit 1 “not implemented”, upload/download throw | §1.3 #4–5, §7, §16 EV-* |
| **NATS JetStream** | `services/worker/src/queue-nats.ts` — warns client not bundled, dequeue always `undefined` | §3 data plane, §6.5 |
| **Helm production stack** | No Postgres/Neo4j/Redis/NATS Deployments; API Deployment **omits `DATABASE_URL`**; sandbox.provider default **`k8s`** (stub) | §13.2 |
| **Neo4j / JanusGraph compose** | Only `docker-compose.demo.yml` (GraphQLite); architecture lists neo4j/janusgraph compose files that are **absent** | §1.3 #2, §13, §17 |
| **API auth / SSO / OIDC / RBAC** | No JWT/SSO middleware; `cors({ origin: "*" })` | §10.4, §15, DP SSO |
| **Multi-SCM webhooks** | Only `packages/webhooks` GitHub handler | SC multi-SCM platform parity |
| **Learning Postgres binding** | `createLearningStore` is file-backed only; embeddings table exists, **no noise cosine filter** | LM-*, NC embeddings |
| **Session checkpoint in DB** | Saves `unit_id = __session__:{id}` into `unit_checkpoints` which **FK-references `review_units(id)`** → insert fails unless unit row exists → falls back to file | Self-heal “prefer DB” claim |
| **Services shells** | `services/api`, `mcp`, `webhooks`, `sandbox-controller` **empty `src/`** | §17 monorepo proposal |
| **Skills** | `steward-map`, `steward-security` empty dirs; only `steward-review/SKILL.md` | §1.3 #10, AA-13 |
| **SAST adapters** | Category/evidence types only; no Semgrep/gitleaks runners | Phase C / AT tools |
| **Git attestation / pre-push guardrails** | Not found in product packages | RT-10, §16.6 |
| **Mention trigger** | Webhook ignores non-`pull_request` events (no `issue_comment`) | RT-02 |
| **Conversation agent** | No conversational PR Q&A agent surface | AA-19 |
| **Ticket/Jira MCP context** | Connector status from `JIRA_URL` env only | CX-08 |
| **OTel / audit / outbox publisher** | Outbox table in SQL; **no publisher worker**; no OTel SDK usage in packages | AN / DP |
| **pgvector / Redis** | Architecture data plane; not deployed or used | §3.1 |
| **IDE extension** | Phase D; not present | §18 Phase D |
| **Evals quality gate** | Structural only; no precision/noise eval harness CI | §18 Phase D |
| **UI Connectors copy** | Labels GitLab as “stub” / “SCM stub” | Product honesty in UI |

---

## 3. Critical gaps that BLOCK GA (must fix)

These block **any honest claim of GA against §1.3 / §16**. Even a reduced “GA-lite” would still need most of (1)–(6).

### BLOCK-1 — Architecture claims exceed product reality
- §1.3 and §16 mark dual-mode platform, K8s sandboxes, 50+ concurrency at scale, full UI, multi-SCM platform, SSO, Prove, cross-repo, DeepAgents, etc. as **IN / ✅**.
- Implementation is a **working demo monorepo**, not the committed platform.
- **Required:** Either (a) finish blockers below, or (b) rewrite §1.3/§16 to **Preview scope** with explicit ADRs for deferred items. Do not GA with checkbox fiction.

### BLOCK-2 — Zero API authentication / multi-tenancy enforcement
- Public endpoints can create sessions, enqueue reviews, read findings, mutate memories/links, rebuild graphs.
- `cors({ origin: "*" })` amplifies risk.
- No SSO/OIDC/SAML, no org RBAC, no audit log writer.
- **Required for GA (self-host enterprise):** at minimum API keys + org isolation + webhook secret hygiene; for enterprise marketing: OIDC/SSO.

### BLOCK-3 — Production deploy is incomplete / misconfigured
- Helm API does not inject `DATABASE_URL` → production chart defaults to **file-backed** sessions/jobs on a PVC (and multi-replica API/workers will race/corrupt file queues).
- No Postgres / Neo4j / Redis / NATS charts or documented external dependencies wiring.
- `sandbox.provider: k8s` default points at **non-functional** K8sSandbox.
- Missing compose profiles for Neo4j/JanusGraph claimed in architecture.
- **Required:** Complete Helm values + templates for SoT Postgres, graph backend, secrets, sandbox provider that works (`local`/`docker` until k8s real), multi-replica-safe queue.

### BLOCK-4 — K8s sandbox + Prove production path is a stub
- Prove/TREX-class claims require sandboxed execution.
- K8s provider is documented TODO; exec always fails.
- Compose defaults `STEW_SANDBOX_PROVIDER=null`.
- **Required for “Prove at GA”:** working Docker **or** K8s Job provider with network policy, resource limits, artifact collection; integration tests.

### BLOCK-5 — Durable control plane not fully correct under Postgres
- Learning store ignores DB despite `learning_*` tables.
- Session-level checkpoints use synthetic `unit_id` violating `unit_checkpoints.unit_id → review_units(id)` FK → **DB checkpoint path fails**, file mirror only.
- `PgSessionStore` mutates fire-and-forget (`void ensureDb()...`) — crash windows lose writes; multi-replica SSE listeners are process-local.
- Outbox table has **no consumer**.
- **Required:** Fix schema (session_checkpoints table or upsert unit rows before checkpoint); wire learning to DB; make session writes transactional; multi-instance event bus or sticky SSE + DB poll.

### BLOCK-6 — No automated quality proof for the review product
- No package-level unit/integration/e2e tests in product tree.
- GA script does not run orchestrator, SCM, DB migrations against live Postgres, or UI.
- Address-rate / noise metrics are UI placeholders (`Analytics.tsx` illustrative buckets).
- **Required for GA:** migration smoke tests, self-heal unit tests, SCM adapter contract tests (recorded fixtures), one golden-path e2e (compose), eval fixtures with pass thresholds.

### BLOCK-7 — Platform SCM parity incomplete
- Adapters exist for five SCMs; **only GitHub webhooks** implemented.
- UI still calls non-GitHub connectors “stubs.”
- GitHub `getDiff` uses `per_page=100` with **no pagination** — large PRs silently under-review.
- **Required for multi-SCM GA claim:** at least GitLab webhook path + pagination + delivery idempotency (`scm_delivery_log` unused).

### BLOCK-8 — Feature checklist items marked GA that are missing
Must not remain ✅ without code:

| ID / area | Status in code |
|-----------|----------------|
| RT-02 mention `@steward` | Missing |
| RT-10 git attestation / pre-push guardrails | Missing |
| AA-19 conversation agent | Missing |
| CX-07 embeddings RAG (optional on) | Schema only; not in review path |
| CX-08 ticket MCP | Env flag only |
| NC embedding noise | Missing |
| SAST Semgrep/gitleaks | Missing |
| DP SSO, OTel, air-gap bundle polish | Missing / incomplete |
| NATS fan-out channels | Stub |
| Skills map/security | Empty |

---

## 4. Non-blocking residual risks

(Important, but secondary once blockers are addressed.)

1. **DeepAgents optional peer** — silent fallback to single-shot `SimpleAgentRunner` reduces investigation quality without obvious UI badge.
2. **Graph degradation** — orchestrator continues on graph failure (good resilience); findings may become diff-vibes without user-visible “graph degraded” severity in published review.
3. **File queue race** when `DATABASE_URL` unset — demo-only; must never be multi-replica.
4. **Webhook session id rewrite** — webhook creates new session id rather than using pre-generated id (idempotency weaker).
5. **Requirements specialist** — prompt-only; no real ticket fetch.
6. **Cross-repo** — plans units with metadata; linked repo filesystem access depends on env/path conventions, not a robust clone service.
7. **UI Diff mock findings** — demo data can confuse operators if API empty.
8. **Action default `graph-mock=1`** — CI may ship reviews without structural graph.
9. **Token budget** — simple counter; no hard abort/publish cost dashboards.
10. **License/compliance packaging** — no SOC2 evidence export, no pentest pack (Phase D).
11. **Image supply chain** — compose pulls `ghcr.io/bitkaio/codesteward:latest` and Helm `ghcr.io/codesteward/review:0.1.0` without pinned digests/provenance story.
12. **Specialist roster** — roles exist as prompts; hybrid deterministic finders (regex secrets, etc.) thin.

---

## 5. Self-healing assessment (vs Kodus failure mode)

### What Kodus-class systems do
From `research/deep-dives/kodus-analysis.md`:
- Job retries with exponential backoff + DLQ (max attempts).
- Pipeline quality **degrades** when sandbox/tools unavailable (empty tool set).
- Critical/partial pipeline errors can **block auto-approve**.
- Failure modes are often “job failed / lower quality,” not always “partial publish with coverage accounting.”

### What CodeSteward implements (strong relative differentiator)
Evidence in `packages/agents/src/self-heal.ts`, orchestrator integration, worker resume, API resume:

| Capability | CodeSteward | Assessment |
|------------|-------------|------------|
| Per-unit ordered heal strategies | Yes (4 strategies) | **Above typical OSS bots** |
| Exponential backoff + jitter | Yes | Real |
| Fallback runner (DeepAgents → Simple) | Yes | Addresses Kodus-like tool/runtime variance |
| Split large unit | Yes | Good monorepo tactic |
| Coverage gap finding (info) | Yes | Transparent partial coverage |
| `completed_with_errors` | Yes | Correct product semantics |
| Partial SCM summary with coverage table | Yes | Avoids bare “Review failed” when partial work exists |
| Checkpoint resume (file always; DB intended) | File solid; DB flawed | **Design good, persistence incomplete** |
| Worker startup re-enqueue incomplete | Yes | Crash recovery story |
| Failure log API + SSE healing events | Yes | Operable |

### Verdict on self-heal
**Self-healing logic is one of the most complete subsystems in the repo** and is a credible answer to Kodus-style “agent crashed → whole review dies / silent degrade” failure modes — **provided checkpoints and multi-worker durability work**.

**Remaining self-heal GA risks:**
1. DB checkpoint FK bug → multi-node resume may only work via shared filesystem.
2. No chaos/integration tests proving resume after kill -9 mid-unit.
3. Global retry caps exist but DLQ/outbox for SCM publish failures is unfinished.
4. Skip-with-gap can mark “success-ish” while large path sets never reviewed — needs policy: fail check run if coverage < threshold.

**Relative to Kodus:** better **unit-level recovery narrative**; weaker **platform maturity** (queues, auth, sandbox, webhooks).

---

## 6. Data/config persistence assessment (Postgres)

### What exists
- Solid **logical schema**: sessions, events, units, checkpoints, findings, cross-repo links, org_settings, learning_*, embeddings (JSONB), jobs, outbox, scm_delivery_log, agent_failure_log.
- Repositories with real SQL (sessions replaceUnits, jobs claim SKIP LOCKED, findings CRUD).
- Compose sets `DATABASE_URL` for api + worker.
- Dual path: file demo vs Postgres when URL set (sessions/jobs/findings).

### What is wrong / incomplete for GA

| Issue | Severity |
|-------|----------|
| Helm omits `DATABASE_URL` → “prod” chart not on Postgres | **Critical** |
| Learning store not bound to DB | **High** — config/memories not multi-replica safe |
| `unit_checkpoints.unit_id` FK vs `__session__:*` synthetic ids | **High** — checkpoint durability fails open to files |
| Fire-and-forget DB writes in `PgSessionStore` | **High** — durability races |
| Org model profiles / STEWARD overrides in `org_settings` | Tables + `ConfigsRepository` exist; **API model-profiles is env-derived**, not full CRUD persistence |
| Outbox / scm_delivery_log / agent_failure_log tables | **Schema ahead of code** |
| Embeddings stored as JSONB “pgvector later” | No similarity search in noise |
| No backup/migration runbook tests in CI | Ops risk |
| Multi-replica SSE events process-local | Scale risk |

### Persistence verdict
**Postgres design is GA-oriented; wiring and correctness are beta.** Demo compose can show durable sessions/jobs/findings. Production Helm as checked in is **not** a Postgres SoT deployment. Learning + checkpoints need fixes before calling data plane GA.

---

## 7. UI/brand assessment

### Strengths
- Coherent dark design system (`packages/ui/src/styles/global.css`): cyan/teal accent `#22d3ee`, density, severity tokens, light theme tokens.
- Sitemap matches architecture §10.1 roughly: Dashboard, Sessions, Findings, Diff, Cross-repo, Connectors, Models, Policy, Settings, Analytics.
- Logo/components (`Layout`, `Logo`, PageHero patterns) — product-feeling, not default Vite scaffold.
- Sessions page substantial (~365 LOC); resume/failures concepts align with self-heal.

### Weaknesses (not all blocking alone; together block “Kodus-class full UI” claim)
- **No auth screens / org switcher / RBAC** (architecture §10.4).
- Connectors page still labels GitLab as stub; incomplete connector management.
- Diff page includes **hardcoded mock findings** — demo contamination.
- Analytics address-rate trends are **illustrative placeholders** when empty.
- Models page local-only key entry (OK for BYOK demo) without org_settings persistence.
- Live process streaming depends on API SSE; multi-worker progress completeness unverified.
- No Playwright/e2e; no accessibility audit evidence.

### Brand verdict
**UI brand and IA are GA-preview ready.** **Product UI depth is not** “full Kodus-class production dashboard.” Good shell; incomplete operations and enterprise surfaces.

---

## 8. Competitor feature coverage matrix

Legend: **Y** = implemented meaningfully · **P** = partial/foundation · **N** = missing/stub · **—** = N/A

| Capability | CodeSteward | Kodus | PR-Agent | Alibaba OCR | LiveReview | Greptile-class (commercial) |
|------------|:-----------:|:-----:|:--------:|:-----------:|:----------:|:---------------------------:|
| PR/MR automated review | **Y** | Y | Y | Y (CLI/Action) | Y | Y |
| Full branch / stewardship scan | **Y** | P (PR-native) | N | **Y** (`scan`) | P | P (graph-backed PR) |
| Structural code graph | **Y** (Codesteward Graph) | P (AST jobs) | N | N | N | **Y** |
| Multi-specialist agents | **Y** | Y | N (tools) | P (per-file) | P | Y (swarm) |
| Judge / verifier / noise | **P** | Y | P | Y (precision bias) | P | **Y** (embed cluster) |
| Discourse multi-agent debate | **Y** (thorough) | N | N | Multiagent sibling | N | N |
| Self-heal + partial publish | **Y** | P (retries/DLQ) | P | Session resume | P | P |
| Learning 👍/👎 + memories | **P** (file default) | **Y** | N | N | P | **Y** |
| Prove / execution sandbox | **P** (local/docker; k8s stub) | Y (E2B) | N | N | N | **Y** TREX |
| Multi-SCM adapters | **Y** | Y | Y | P | **Y** | GH/GL focus |
| Multi-SCM webhooks platform | **P** (GH only) | **Y** | Y | P | **Y** | Y |
| Product UI dashboard | **P** | **Y** | N | Viewer | **Y** | Y |
| CLI | **Y** | Y | Y | **Y** | Y | P |
| MCP | **P** | Y | P | client | Y | Y |
| GitHub Action | **Y** | Y | Y | Y | P | Y |
| Custom rules (English) | **P** (STEWARD.md) | **Y** (Kody Rules) | Y (TOML) | Y | Y | Y |
| SSO / enterprise auth | **N** | EE | N | N | Y | Y |
| Git guardrails / attestation | **N** | N | N | N | **Y** | N |
| Autofix / fix-with-agent loop | **N** | P | improve tool | N | N | **Y** |
| Cross-repo org map | **P** | P | N | N | N | P/Y (Qodo) |
| SAST integration | **N** | P | N | N | N | Bundle (CodeAnt) |
| Deploy Compose + Helm | **P** | Y | Y | Action-centric | Y | Y |
| Eval harness / quality gates | **P** (paths only) | Y | health suites | benches claimed | P | internal |
| Observability (OTel) | **N** | Y | P | Y | P | Y |

### Strategic read
- **Differentiation that is real today:** dual-mode (gate + stewardship) + Codesteward Graph + discourse thorough mode + self-heal partial coverage semantics.
- **Gaps that lose bake-offs:** enterprise auth, mature learning noise, execution Prove, multi-SCM webhooks, autofix loops, eval-proven precision, production deploy.
- **Do not claim Greptile TREX parity** until K8s/docker Prove is hardened with artifacts.
- **Do not claim Kodus UI/platform parity** until auth, webhooks, learning DB, and connector polish land.

---

## 9. Explicit list of files that are still stubs / TODOs / empty

### Hard stubs / TODO implementations
| Path | Issue |
|------|--------|
| `/Users/mrschneider/Projects/xai/codesteward/packages/sandbox/src/k8s.ts` | Full provider stub; exec/upload/download not implemented |
| `/Users/mrschneider/Projects/xai/codesteward/services/worker/src/queue-nats.ts` | NATS consumer stub (always empty dequeue) |
| `/Users/mrschneider/Projects/xai/codesteward/packages/graph-client/src/client.ts` | stdio transport “not implemented in foundation” |
| `/Users/mrschneider/Projects/xai/codesteward/packages/sandbox/src/prove.ts` | Placeholder generate-tests path without LLM |
| `/Users/mrschneider/Projects/xai/codesteward/packages/ui/src/pages/Connectors.tsx` | UI text treats GitLab as stub; incomplete connector set |
| `/Users/mrschneider/Projects/xai/codesteward/packages/ui/src/pages/Analytics.tsx` | Placeholder address-rate trend buckets |
| `/Users/mrschneider/Projects/xai/codesteward/packages/ui/src/pages/Diff.tsx` | Mock findings for demo |

### Empty / scaffold-only directories
| Path | Issue |
|------|--------|
| `/Users/mrschneider/Projects/xai/codesteward/packages/cross-repo/src/` | Empty (logic lives under agents) |
| `/Users/mrschneider/Projects/xai/codesteward/services/api/src/` | Empty |
| `/Users/mrschneider/Projects/xai/codesteward/services/mcp/src/` | Empty |
| `/Users/mrschneider/Projects/xai/codesteward/services/webhooks/src/` | Empty |
| `/Users/mrschneider/Projects/xai/codesteward/services/sandbox-controller/src/` | Empty |
| `/Users/mrschneider/Projects/xai/codesteward/skills/steward-map/` | Empty |
| `/Users/mrschneider/Projects/xai/codesteward/skills/steward-security/` | Empty |

### Schema-ahead / unwired platform pieces
| Path | Issue |
|------|--------|
| `packages/db/migrations/001_init.sql` → `outbox`, `scm_delivery_log`, `agent_failure_log`, `learning_embeddings` | Tables without full producers/consumers |
| `packages/learning/src/store.ts` | File SoT; does not use `LearningRepository` |
| `packages/agents/src/self-heal.ts` + `unit_checkpoints` FK | Session checkpoint DB path broken by design mismatch |
| `deploy/helm/codesteward/templates/api-deployment.yaml` | No `DATABASE_URL`; incomplete prod env |
| `deploy/helm/codesteward/values.yaml` | `sandbox.provider: k8s` points at stub |
| Architecture-referenced missing files | `deploy/compose/docker-compose.neo4j.yml`, `docker-compose.janusgraph.yml` (not present) |

### Validator false confidence
| Path | Issue |
|------|--------|
| `evals/ga-checklist.json` + `scripts/validate-ga.mjs` | Structural only; 100% PASS ≠ GA |

---

## 10. Final double-check confirmation

**I refuse confirmation because:** against `05-full-product-architecture.md` §1.3 and §16, the product is a **strong preview foundation**, not a finished GA platform. Critical blockers remain: **unauthenticated API**, **incomplete/miswired production deploy (Helm without Postgres SoT; K8s sandbox stub; NATS stub)**, **durable learning/checkpoint gaps**, **GitHub-only webhooks**, **missing committed features** (mentions, attestation guardrails, embedding noise, SAST, SSO, OTel), and **no product test/eval evidence** beyond a path-existence checklist that misleadingly scores 100%.

Self-heal, dual-mode orchestration, graph integration, discourse, multi-SCM *adapters*, and UI brand are real and valuable — ship them as **Beta / Preview**, not GA, until blockers are closed or scope is formally waived by ADR.

---

## Appendix A — Commands / artifacts inspected

```text
node scripts/validate-ga.mjs  → 46/46 PASS
read research/design/05-full-product-architecture.md (§1.3, §16–18)
packages/agents (orchestrator, self-heal, discourse, deep-agent-runner, noise, specialists, cross-repo/fanout)
packages/db (migrations, repositories)
packages/api (app, store, queue)
packages/ui (pages, global.css)
packages/scm, learning, findings, sandbox, webhooks, model-router, cli, mcp-server
services/worker (index, queue-nats)
deploy/compose/docker-compose.demo.yml
deploy/helm/codesteward/*
research/deep-dives/{kodus,pr-agent,alibaba-ocr,livereview,commercial-tools}.md
```

## Appendix B — Recommended minimum path to honest GA (sequenced)

1. **Scope honesty ADR** — Preview vs GA-lite matrix; uncheck §16 lies.
2. **Auth + Postgres correctness** — API auth; fix checkpoints schema; learning on DB; Helm `DATABASE_URL`.
3. **Working sandbox default** — docker/local Prove green; demote k8s until real.
4. **GitHub hardening** — pagination, delivery log, mention optional; check-run coverage threshold.
5. **Tests** — self-heal unit + compose e2e + migration smoke.
6. **Then** multi-SCM webhooks, embedding noise, SSO, K8s sandbox, NATS — Phase C/D.

Until steps 1–5 land, any “GA fully shipped” statement is false.
