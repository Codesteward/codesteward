# Changelog

All notable changes to **Codesteward Review** (agentic PR gate + branch stewardship) are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

### Added

- **Pull-only stack** — `deploy/compose/docker-compose.stack.yml` (+ compose override + `STACK.md`): run from
  published GHCR images with **Docker Compose** or **Docker Swarm** (no monorepo build).
- **Re-review GitHub thread resolve** — when lifecycle marks prior findings `fixed` (fingerprint gone after a new
  push/session), resolve matching PR review threads via GraphQL when `scmCommentId` / fingerprint / finding markers match.
  Disable with `STEW_RESOLVE_FIXED_THREADS=0`.

### Changed

- **PR finding code blocks** use GFM language tags from the file path (e.g. `go`, `typescript`, `yaml`) so GitHub
  highlights **Context** and **Proposed fix** snippets.
- **UI nginx proxy** — re-resolve Docker DNS for `api` (`resolver 127.0.0.11`) so restarted API containers do not leave
  the UI stuck on a stale upstream IP (502 → SPA falls back to local password login instead of Keycloak).

### Fixed

---

## [1.4.0] — 2026-07-20

Indirect eval / outcome loop, reliable GitHub App multi-install gate reviews, PR status + republish, and per-finding SCM comments.

### Added

- **Automatic / indirect eval (outcome loop)** — learn from what users and merges actually do:
  - Merge webhooks (GitHub `closed`+merged, GitLab `merge`) enqueue `jobKind=pr_outcome` (no agent pipeline)
  - Classifies findings: accepted / fixed / thumbs_up / false_positive / dismissed / unaddressed_at_merge
  - Mines **agent-miss candidates** on sensitive paths changed with no finding
  - Gate regret: approve+critical open, or request_changes+only noise
  - Durable `pr_outcomes` + `finding_outcomes` (migration `015_review_outcomes.sql` or file store)
  - 👍 creates **positive** preference memories (mirrors 👎 suppress)
  - Preference **bag-of-words embeddings** filter in noise stack (near 👎 → drop)
  - Analytics: split **fixAcceptRate / noiseRate / openRate** + confidence calibration
    (`GET /v1/analytics/address-rate`, `/v1/analytics/outcomes`, `/eval-export`)
  - Offline eval harness consumes production outcome fixtures (`packages/evals`)
  - **Outcome consolidator** — promote frequent merge outcomes to memories with correct scope:
    repo-only common → **repo** memory; multi-repo or important (critical/high / gate regret) → **org** memory.
    `POST /v1/analytics/outcomes/consolidate`; also runs after each merge outcome job.
    Source `outcome_aggregate` (auditable on Learnings). No longer writes a repo memory on every single accept.
  - **Docs** — GitHub App / GitLab webhook events for gate + merge outcomes (`docs/docs/configure/connectors.md`, README).
  - **GitHub `pull_request_review_thread`** — resolved/unresolved maps comment ids → findings (`scmCommentId`), writes
    `thread_resolved` / `thread_unresolved` outcomes, soft status tags, consolidator feed.
  - **GitHub `security_advisory`** (+ repository_advisory) — external GHSA → `security_advisory` outcome + soft pattern
    memory for coverage / FN; optional org promotion when severity is high.
  - Manifest defaults include `pull_request_review_thread` and `security_advisory`.
- **PR status comments** — webhook-triggered reviews post a progress comment on the PR (“Reviewing / Re-reviewing now…”),
  then update it on prepare failure, crash (exhausted retries), or successful completion so GitHub-only readers are not stuck.
- **Republish to PR** — post findings for a finished gate session without re-running agents:
  - `POST /v1/sessions/:id/publish` (reviewer+)
  - Sessions UI drawer action **Republish to PR**
  - Diff-aware inline comments + conversation fallbacks with full finding body (suggestion / proposed fix)

### Changed

- **SCM publish** posts per-finding PR comments with UI-style bodies (severity, path, explanation, suggestion, proposed fix),
  not only a summary review. Default cap raised to **40** findings (`STEW_COMMENT_CAP`).
- **Display brand** in PR summary / gate check titles: **Codesteward** (not “CodeSteward”).
- Gate review jobs carry `headBranch` for clone/checkout of the PR tip (not base).

### Fixed

- **GitHub webhook redeliver** — same `X-GitHub-Delivery` id is reprocessed after `processed`/`failed` (or stale
  `received`), instead of always returning `{ duplicate: true }` with no new session. Concurrent in-flight claims
  still dedupe (~2 min, `STEW_WEBHOOK_CLAIM_STALE_MS`).
- **Multi-install GitHub App token pick** — mint installation tokens for the **repo owner** (e.g. `scigility`) instead of a
  stale connector `accountLogin: local` install. Applied to webhook SCM, clone auth, check runs, publish, and republish.
  Fixes clone “Repository not found”, `getPullRequest` 404 on mentions, and `postReview` 404 after a successful review.
- **Workspace clone checkout** — `git checkout --force -- <sha>` treated the SHA as a *pathspec* and failed with
  `pathspec '…' did not match any file(s) known to git`. Checkout now uses `switch --detach` / `checkout -f <ref>`;
  fetch fallbacks include `pull/<n>/head`, head branch, then object id.
- **PR review comments 422 “Line could not be resolved”** — only attach inline comments to lines present in PR diff hunks;
  other findings become conversation comments so they are not dropped when a batch fails.
- **Stuck “Re-reviewing now” comment** — completion path now updates the status comment (and notes when SCM publish failed).
- **Webhook delivery logging** — outcomes (ignored reason, session/job ids, publish errors) written to logs / delivery row
  so redeliver forensics is not silent.

---

## [1.3.0] — 2026-07-18

Cloud one-click trial deploys, first-review product tour, and Scorecard publish fix.

### Added

- **First-review product tour** — guided spotlight walkthrough (driver.js) after first login:
  Models → Connectors → Gate → Findings. Completion/skip dual-written to `users.preferences`
  (`productTour.firstReviewStatus`) and browser localStorage (hard-refresh safe); replay from
  **Account → Replay product tour**. Closing mid-tour (X) toasts how to restart.
  Migration `014_user_preferences.sql`; `PATCH /v1/auth/me/preferences` (all signed-in roles).
  Popover follows light/dark theme tokens.
- **Cloud one-click trial deploys** — shared single-VM stack under `deploy/cloud/`
  (nginx edge HTTPS + Keycloak OIDC + API/worker/UI + Postgres). No LLM key at install (Models UI).
  Self-signed TLS by default (PKCE / `crypto.subtle`); optional `DOMAIN` for cert CN.
  - AWS CloudFormation Launch Stack (`deploy/cloud/aws/`)
  - Azure Bicep/ARM Deploy (`deploy/cloud/azure/`)
  - GCP Cloud Shell + `gcloud` (`deploy/cloud/gcp/`)
  - DigitalOcean trial path (`deploy/cloud/do/`): `doctl` `deploy.sh` + `cloud-init.yaml`
    (full product install via `first-boot.sh`). Native Marketplace 1-Click is **not** published yet;
    do not use the generic Docker Marketplace app as a Codesteward installer.

### Fixed

- **Cloud trial deploys** (`deploy/cloud/`): production-shaped single-VM path hardened after Azure pilot:
  - nginx edge (HTTPS self-signed) instead of Traefik (Docker Engine 29 API incompatibility)
  - SPA OIDC: ignore bake-time localhost issuer off-loopback; empty UI Dockerfile OIDC defaults
  - nginx routes `/auth/callback` to UI (Keycloak is under `/auth/*`)
  - Keycloak Admin issuer parse supports path-based `/auth/realms/...` (org create)
  - first-boot: quoted `.env`, IaC placeholder sanitization, Azure IMDS, always-HTTPS for PKCE
  - Azure cloud-init via Bicep `format()` + NSG on NIC
- **Product tour UX** — sidebar nav scroll for Models/Connectors; step counter no longer resets on
  SPA navigation; “Configure a provider” targets provider API keys (not the stage matrix);
  dark-mode button hover contrast on popover controls.
- **CI** — OpenSSF Scorecard job uses only `uses:` steps when `publish_results: true` (OpenSSF
  workflow verification; shell retry steps caused 400 “scorecard job must only have steps with uses”).
- **Code scanning** — pin Docker base images and Keycloak workflow actions by digest/SHA;
  Confluence HTML strip handles `</script…>` end tags; git clone SHA fetch restricted to object ids +
  `checkout --`; remove empty Keycloak password field from Helm values; drop unused locals flagged by CodeQL.

---

## [1.2.0] — 2026-07-17

Self-host hardening, operator docs site, multi-tenant workers, and release packaging (Helm OCI + SpaceXAI branding).

### Added

- **Documentation site** — Docusaurus handbook at top-level `docs/` (replaces flat markdown-only docs folder).
  Product handbook: why Codesteward, Compose + **Kubernetes quick start**, install (Compose/Helm),
  configure, product UI, pipeline, integrations, ops, security, FAQ. Theme aligned with product UI
  (official brand assets); Cloudflare Workers via `docs/wrangler.toml`.
- **Helm chart OCI publish on release** — `helm package` + `helm push` to
  `oci://ghcr.io/codesteward/codesteward/charts/codesteward` (version = product semver); `.tgz`
  also attached to the GitHub Release. Docs: Kubernetes quick start + Helm install from GHCR.
- **Multi-tenant worker isolation** — harden shared workers against cross-org clone reads
  (path layout + tool jail + optional hard sandbox + claim affinity). See
  `docs/docs/ops/multi-tenant-workers.md`.
  - Workspace layout: `{STEW_WORKSPACE_DIR}/{orgId}/{sessionId}`
    (`STEW_TENANT_ISOLATION=path` default; `off` for legacy flat paths).
  - Path jail on agent tools / packing (`packages/agents/src/path-jail.ts`).
  - `STEW_TENANT_ISOLATION=strict` prefers Docker/k8s sandbox (no host shell for agent tools).
  - Org-affine workers: `STEW_WORKER_ORG_IDS` filters Postgres job claim.
  - Graph scope: graph `tenant_id` = product `orgId`; rebuild `repo_path` jailed to session workspace.
- **Platform queue republish** — after optional broker (NATS/Rabbit/Pulsar) message loss,
  platform operators rehydrate wake-up depth from Postgres via
  `GET/POST /v1/platform/queue` (+ `/republish`) or **Settings → Platform ops → Job queue recovery**.
- **Embedded Graph MCP in workers** — removed standalone graph-mcp service; workers spawn
  `codesteward-mcp --transport stdio`. Shared Neo4j/Janus via `GRAPH_BACKEND` + `NEO4J_URI`
  (tenant_id = product orgId). No shared clone PVC between graph and workers.

### Changed

- **SpaceXAI rebrand** — user-facing "xAI" renamed to **SpaceXAI** (docs, UI Models, CLI doctor).
  Env: prefer `SPACEXAI_API_KEY` (legacy `XAI_API_KEY` still accepted). Provider id `xai` kept for
  stored configs; alias `spacexai` accepted in the model router. API host remains `api.x.ai` until
  upstream changes.
- **Default container images** — Helm defaults use `ghcr.io/codesteward/codesteward` (+ `/ui`, `/keycloak`).
- **Models** — removed unrealistic per-stage env `apiKeyRef` UI/API surface; org provider keys remain BYOK.

### Fixed

- **CI** — `require-tools` test imports `after` from `node:test`; zizmor template-injection in
  Keycloak base-update workflow (inputs via env); `serialize-javascript` override for docs/Docusaurus
  HIGH advisory; Hadolint on `Dockerfile.node` (DL3008 ignore placement + merge consecutive RUNs).

### Upgrade notes

1. Pull images / chart for **1.2.0**:
   ```bash
   helm upgrade --install codesteward oci://ghcr.io/codesteward/codesteward/charts/codesteward \
     --version 1.2.0 \
     --set image.tag=1.2.0 \
     --set ui.image.tag=1.2.0
   ```
   Or from git: `./deploy/helm/codesteward` with image tags `1.2.0`.
2. Set `SPACEXAI_API_KEY` if you used Grok/`XAI_API_KEY` (legacy env still works).
3. Multi-tenant production: review `STEW_TENANT_ISOLATION` and optional `STEW_WORKER_ORG_IDS`
   (`docs/docs/ops/multi-tenant-workers.md`).
4. Graph: no standalone graph-mcp Deployment — workers embed MCP; point `GRAPH_BACKEND` + Neo4j/Janus as needed.
5. Optional broker: after broker data loss, use Platform ops **Republish pending** or
   `POST /v1/platform/queue/republish`.

---

## [1.1.0] — 2026-07-16

Post–**1.0.0** release: parallel review pipeline hardening, install-wide ops visibility, findings quality, security triage, and product docs with UI screenshots.

### Added

- **Parallel specialists + structured rationale → senior verifier** — roles on a unit always run
  concurrently (`Promise.all`) with a barrier before the next stage; findings may carry
  **`reasoning`** (plus `evidence.type=reasoning`). Verifier is a principal-SWE batch pass
  (keep/drop/severity) using rationale + packed context. Migration `013_finding_reasoning.sql`.
- **Session timing ledger** — `session.audit.timings` / `metadata.timings`: wall clock per pipeline
  stage, per unit, rollups (longest stage/unit/specialist, `byStageMs`, tool time). Session report
  **Timing / bottlenecks** section; worker logs `stage=X done …` + end-of-job summary.
- **Live specialist heartbeats** — SSE `specialist_run` started / running (interval
  `STEW_SPECIALIST_HEARTBEAT_MS`, default 15s) / completed / failed. Session blade **Live specialists**
  banner with per-role elapsed timers.
- **Platform ops analytics** — `GET /v1/platform/analytics?days=N` (platform operators) for
  install-wide success rate, p50/p95 latency, stage averages, specialist role stats, worker queue,
  tokens. UI: **Settings → Platform ops** (`/settings/platform/ops`). Distinct from tenant Analytics.
- **GitHub Code Scanning SARIF upload** — PR gate publishes via `code-scanning/sarifs` (gzip+base64).
  `STEW_PUBLISH_SARIF` (env → platform runtime → org → default **On**). Requires code scanning enabled
  and `security_events: write`.
- **Three-level finding confidence** — product **`confidence`**, specialist **`modelConfidence`**,
  optional **`tokenConfidence`** (logprobs). UI/SARIF/suggested-fix gate use product confidence.
  Migration `012_finding_confidence_layers.sql`.
- **Suggested code fixes** — `suggestedFix` / `suggestion` / `existingCode` on findings; Findings UI,
  reports, SARIF, PR comments. Min confidence gate `STEW_SUGGESTED_FIX_MIN_CONFIDENCE` (default 0.75).
  Migrations `011_finding_suggested_fix.sql`.
- **Install-wide platform runtime store** — `GET/PUT /v1/platform/runtime-config`; org may only
  override suggested code fixes when platform policy is Unset.
- **Product docs** — `docs/UI_GUIDE.md` (screenshot tour), `docs/README.md`,
  `docs/REVIEW_PIPELINE.md`, session audit notes; screenshots under `docs/screenshots/` (kebab-case).

### Changed

- **Job queue is Postgres-only** — removed file-backed `FileJobQueue` / `jobs.json`.
  `DATABASE_URL` required for multi-replica safety; NATS/Rabbit/Pulsar remain optional wake-up brokers.
- **Specialist timeouts** — `STEW_SPECIALIST_TIMEOUT_MS` (default 8m); truncated runs emit coverage-gap
  findings (`steward.specialist_timeout`), audit `coverageGaps`, UI TIMEOUT ledger — never a silent
  clean empty scan. LLM retries: `STEW_LLM_MAX_RETRIES` + `STEW_LLM_REQUEST_TIMEOUT_MS`.
- **Session stage pipeline UI** — per-stage durations, live active step, skipped optional stages,
  timing bars; audit JSON download only under **Review audit** (not duplicated on Review report).
- **Members UI** — role capability help; Keycloak vs local create-user copy clarified.
- **Runtime UI** — Unset / Off / On for booleans; platform vs org scope clearly labeled.
- **Codesteward Graph image** — default `ghcr.io/codesteward/codesteward-graph`.
- **README** — self-host focused; docs links to UI guide + pipeline.
- Local sandbox defaults to **in-place** repo read (`STEW_SANDBOX_COPY=1` for full tree copy).

### Fixed

- **GitHub clone host** — map `api.github.com` / `GITHUB_API_URL` to git host `https://github.com`
  (`resolveGithubGitHost`); exact hostnames only (no substring SSRF). Hardened clone args
  (`assertSafeGitArg`, `--` on clone).
- **Keycloak first install user** — first OIDC JIT user on empty store gets `platformAdmin` + product
  `admin` (parity with local bootstrap).
- **Code scanning triage** — crypto temp passwords; Confluence CQL/HTML strip; remove unused
  vulnerable `diff` package (GHSA-73rr-hh4g-fpgx); root `SECURITY.md`; CodeQL quality cleanups.
- **Keycloak login path** — no fallback to local password form when IdP is configured (break-glass
  only `/login?local=1`).
- **Workspace GC** — delete `{STEW_WORKSPACE_DIR}/{sessionId}` clones after terminal status
  (`STEW_WORKSPACE_KEEP=1` to retain).
- **Container permissions** — entrypoint chowns data/workspace volumes for non-root `steward`.
- **LocalSandbox spawn** — handle ENOENT; prefer `/bin/bash` or `/bin/sh`; no worker process crash.
- **Resume UI** — failure branding only on terminal status; resume clears prior error.
- **CI / release** — Trivy 0.72.0; Semgrep GCM `authTagLength`; zizmor cache-poisoning fixes;
  multi-stage Docker; drop SaaS-billing image from public CI/release; CodeQL action v4.
- GitHub connector icon visible on light theme (`currentColor`).
- Plan-gate UI for audit log / SCIM; SCIM org entitlement; platform GitHub App enforce UX.

### Migrations

Operators with Postgres should run migrations through **011–013** (suggested fix, confidence layers,
finding reasoning) if upgrading from **1.0.0**:

```bash
pnpm migrate
# or: pnpm --filter @codesteward/db run migrate
```

### Upgrade notes

1. Ensure **`DATABASE_URL`** is set (file job queue removed).
2. Run DB migrations **011–013**.
3. Rebuild/redeploy API, worker, and UI images (or `pnpm -r run build`).
4. Optional: set `STEW_PLATFORM_ADMIN_EMAILS` for additional platform operators under Keycloak.
5. Helm: set image tag **`1.1.0`** (chart `appVersion` updated).

---

## [1.0.0] — 2026-07-16

**First production release** of **Codesteward Review** — graph-aware agentic code review for self-host and multi-tenant SaaS.

### Added — Product core

- **Dual-mode reviews** — PR **Gate** (diff-focused) and branch **Stewardship** (path/package batches) on one platform
- **Graph-aware agents** — specialists call Codesteward Graph (MCP) for structure, not only the patch
- **Multi-provider model router** — OpenAI, Anthropic, SpaceXAI, OpenAI-compatible, LiteLLM; optional Langfuse tracing
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
