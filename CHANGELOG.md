# Changelog

All notable changes to **Codesteward Review** (agentic PR gate + branch stewardship) are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

### Fixed

- **Code scanning / supply chain** — harden git clone args against second-order CLI injection
  (`assertSafeGitArg`, end-of-options on `clone`); exact hostname checks for github.com (no
  substring SSRF); crypto `randomBytes` for temp passwords; Confluence CQL escape + safer HTML
  strip; remove unused vulnerable `diff` dep (GHSA-73rr-hh4g-fpgx); root `SECURITY.md`.
  CodeQL quality cleanup (unused locals / useless assigns / mock trivial conditionals).
- **Specialist timeout is durable and visible** — on `STEW_SPECIALIST_TIMEOUT_MS`, audit stores
  `status=truncated`, `timedOut`, `timeoutMs`; SSE uses `status=timeout`; a **high/medium coverage-gap
  finding** (`steward.specialist_timeout`) is emitted (security → high). Session audit adds
  `coverageGaps` so timeouts are never presented as clean empty scans or empty-scan confidence.
  UI ledger shows **TIMEOUT · incomplete**; zero-findings rationale uses `specialist_timeouts`
  when roles aborted. Worker logs `specialist X TIMEOUT … budget=…`.
- **Session stage pipeline progress** — pipeline shows per-stage durations, live elapsed on the
  active step, skipped optional stages (discourse/prove/publish), and a timing bar chart so
  verification/judge are not invisible after a long specialists phase. Worker logs emit
  `stage=X done 25.5s` plus an end-of-job timings summary.
- **Internal gap notes out of public docs** — `docs/ENTERPRISE_GAPS.md` moved to local-only
  **`.todo/`** (gitignored); README/docs links removed so gap registers are not part of the public tree.
- **LLM rate-limit retries** — ModelRouter HTTP path now retries 429/5xx/network with exponential
  backoff + `Retry-After` (`STEW_LLM_MAX_RETRIES`, default 4). DeepAgents ChatOpenAI/Anthropic set
  explicit `maxRetries` + per-request `timeout` (`STEW_LLM_REQUEST_TIMEOUT_MS`, default 120s) so
  parallel specialists no longer rely on silent/unbounded LangChain defaults that looked “stuck”.
- **GitHub connector logo on light theme** — monochrome mark used white fill only; now uses
  theme `currentColor` (`connector-icon--brand-adaptive`) so the octocat is visible on light UI.
- **Specialist hang no longer freezes the unit** — DeepAgents/simple specialist calls are
  bounded by `STEW_SPECIALIST_TIMEOUT_MS` (default 8m). Parallel roles soft-fail on timeout so
  sibling findings still ship; root cause of “stuck on specialists” when one role never returned.
  Local sandbox defaults to **in-place** repo read (`STEW_SANDBOX_COPY=1` to force full tree copy).

### Added

- **Live specialist heartbeats** — SSE `specialist_run` events for started / running (every
  `STEW_SPECIALIST_HEARTBEAT_MS`, default 15s) / completed / failed. Sessions drawer shows a
  **Live specialists** banner with per-role elapsed timers (“security on root · still running · 6m”).
- **Platform ops analytics** — `GET /v1/platform/analytics?days=N` (platform operators only)
  aggregates install-wide session success, p50/p95 latency, stage avgs, specialist role latency,
  worker queue depth, and tokens. UI at **Settings → Platform ops** (`/settings/platform/ops`).
  Distinct from tenant **Analytics** (address rate / findings).
- **Session timing ledger for bottleneck analysis** — each review stores `session.audit.timings`
  (and `metadata.timings`): wall clock per pipeline stage (policy→publish), per unit, plus rollups
  (longest stage/unit/specialist, `byStageMs`, specialist run sum/max, tool time sum). Session report
  includes a **Timing / bottlenecks** section; `audit_summary` events carry total/longest stage.
- **Parallel specialists + structured rationale → senior verifier** — roles on a unit always run
  concurrently (`Promise.all`) with a barrier before the next stage; each finding may carry
  **`reasoning`** (plus `evidence.type=reasoning`) instead of raw chat history. The verifier is a
  principal-SWE batch pass that judges keep/drop/severity using that rationale + packed context.
  Migration `013_finding_reasoning.sql`.
- **`docs/REVIEW_PIPELINE.md`** — end-to-end explanation of the review agent pipeline (units,
  specialists, DeepAgents vs simple turns, discourse, judge, publish, workspace GC).

### Fixed

- **Job queue is Postgres-only** — removed file-backed `FileJobQueue` / `jobs.json` SoT.
  `DATABASE_URL` is required; API/worker no longer pin review jobs to local disk (which made
  “stateless” services stateful and unsafe under multi-replica). Optional NATS/Rabbit/Pulsar
  remain wake-up brokers only.
- **CI / release no longer depend on SaaS billing** — removed Hadolint on
  `services/saas-billing/Dockerfile` and the release build/push/sign/notes for
  `ghcr.io/.../saas-billing`. That control plane is private and not shipped in this repo;
  CI was failing when the path was absent.

### Added

- **GitHub Code Scanning SARIF upload** — on PR gate SCM publish, findings are uploaded via
  `POST /repos/{owner}/{repo}/code-scanning/sarifs` (gzip+base64) so alerts appear under
  **Security → Code scanning**. Controlled by `STEW_PUBLISH_SARIF` with the same resolution as
  Suggested code fixes: process env → Platform runtime → org preference → product default
  (**On**). Platform UI + Organization settings cards; requires code scanning enabled and
  `security_events: write` on the GitHub App/token.
- **Three-level finding confidence** — primary **`confidence`** is product/evidence-derived
  (path, line, body, graph/SAST/discourse/verify signals); **`modelConfidence`** stores the
  specialist’s JSON self-report (diagnostic only); **`tokenConfidence`** is mean completion-token
  probability from provider logprobs when available (OpenAI-compatible; Anthropic omitted).
  Suggested-fix gate, audit summaries, SARIF, and Findings UI use product confidence; model/token
  layers are retained for transparency. Migration `012_finding_confidence_layers.sql`.
- **Suggested code fixes on findings** — specialists may emit a concrete `suggestedFix` snippet
  (plus plain-text `suggestion` / optional `existingCode`). Surfaced in Findings UI, session
  reports, SARIF properties, and PR inline comments as **Proposed fix**. Persisted in file store
  and Postgres (`suggested_fix`, `existing_code`; migration `011_finding_suggested_fix.sql`).
- **Min confidence for code fixes (platform)** — `STEW_SUGGESTED_FIX_MIN_CONFIDENCE` (default
  **0.75**, range 0–1). Concrete `suggestedFix` is dropped when finding confidence is below this
  threshold; plain-text `suggestion` is always kept. Configurable under Platform runtime.
- **Install-wide platform runtime store** — `GET/PUT /v1/platform/runtime-config` +
  `.steward-data/platform-runtime.json`. Clone, DeepAgents, graph, worker, SAST, and related knobs
  are **platform-only** (Platform settings → Platform runtime). Process env still wins when set.
- **Org override for code fixes only** — `STEW_SUGGESTED_CODE_FIXES` may be set per org under
  Organization → **Suggested code fixes** when Platform leaves the policy **Unset**. Resolution:
  `env` → platform policy → org preference → product default (off). Platform Off/On forces all
  orgs; org UI locks and explains the effective source.

### Changed

- **Codesteward Graph image** — compose/Helm default pull
  `ghcr.io/codesteward/codesteward-graph` (package moved from bitkaio org image name).
- **README** — public docs describe self-host only; SaaS/billing release notes and commercial
  roadmap language removed from the top-level README.
- **Empty-scan confidence** — specialist steps with zero findings still record product
  `avgConfidence` (paths/files/graph + optional model `emptyScanConfidence`) so audit/UI show
  how sure the step is that nothing was missed.
- **Runtime config scope** — install knobs are no longer treated as per-org. Organization settings
  expose only tenant preferences (suggested code fixes card); full runtime editor lives on Platform.
- **Runtime UI controls** — Unset / Off / On (custom `Select`) for booleans; clear effective/source
  lines so operators are not misled by a bare checkbox.

### Fixed

- **Login no longer falls back to local password form under Keycloak** — when identity is Keycloak
  (or SPA OIDC is configured), `/login` always stays on the IdP path. API/DB outages show an error
  + retry, not the local form. Break-glass local login is only `/login?local=1`.
- **Workspace GC after session finish** — delete `{STEW_WORKSPACE_DIR}/{sessionId}` (primary +
  cross-repo clones) when a job ends in completed / completed_with_errors / failed. Previously
  only paths containing the substring `workspaces` were removed, so category stacks using
  `/workspace/ses_…` never cleaned up. Set `STEW_WORKSPACE_KEEP=1` to retain clones for debug.
- **Container `/data` + `/workspace` permissions** — non-root `steward` entrypoint chowns
  `STEW_DATA_DIR` / `STEW_WORKSPACE_DIR` (compose named volumes) before dropping privileges,
  fixing `EACCES` on `/data/checkpoints/*.json` and clone workspaces.
- **Worker crash on sandbox spawn** — LocalSandbox handles spawn `error` (ENOENT), always creates
  sandbox cwd, prefers `/bin/bash` or `/bin/sh`; missing binary no longer kills the worker process.
- **Resume UI** — failure banner only when status is terminal (`failed` / `completed_with_errors`);
  resume clears session `error` / failure summary so a re-run is not branded with the previous error.
- **CI Trivy install** — pin Trivy **0.72.0** (0.56.2 release assets 404’d); log download URL on install.
- **CI Semgrep GCM** — `createCipheriv` / `createDecipheriv` AES-GCM pass `{ authTagLength: 16 }`.
- **CI / release security gates (v1.0.0 tag blockers)** — Semgrep, zizmor, and Trivy now pass on the
  hardened pipelines so push + version tags can complete release again:
  - **zizmor** `cache-poisoning`: set `package-manager-cache: false` on every `actions/setup-node`
    (removing `cache: pnpm` alone is not enough — setup-node defaults still flag).
  - **Semgrep**: AES-GCM `authTagLength: 16` on encrypt/decrypt; exclude local `scripts/` / `evals/`
    HTTP smoke noise; drop `curl | sh` installs for Trivy/Syft in favor of pinned release tarballs.
  - **Trivy container gate**: multi-stage `Dockerfile.node` (no pnpm CLI / no global npm tree at
    runtime, `pnpm prune --prod`, strip esbuild/pulsar), `--scanners vuln --ignore-unfixed`, and
    `pnpm.overrides` for vulnerable `undici` / `picomatch` ranges.
  - CodeQL action pins moved to **v4**; SaaS billing image runs as non-root `steward`.
- Friendly plan-gate UI for org audit log and SCIM when plan does not include the feature
  (no raw `402` JSON dump).
- SCIM token mint and SCIM protocol path enforce **org** Enterprise entitlement
  (`requireOrgEntitled` / `isOrgEntitled`), not process open-mode license alone.
- Platform GitHub App enforce: Connectors hides Create Manifest / PEM paste and shows install-only UX.
- Billing portal stuck on “Checking sign-in…” (broken JS string escaping in seat summary HTML).
- Billing portal user-facing copy no longer says “Keycloak”.
- Pro plan list price set to **$25 / seat / mo** (was $49).
- Initial release packaging: `CHANGELOG`, GitHub Actions (CI / release / scheduled / scorecard),
  version **1.0.0**.

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
