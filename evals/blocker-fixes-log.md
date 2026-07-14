# GA Blocker Fixes Log

**Date:** 2026-07-12  
**Scope:** Critical blockers from `evals/architect-ga-review.md` for honest self-hosted GA claim.  
**Validation:** `pnpm -r run build` green · `pnpm test` green · `node scripts/validate-ga.mjs` → 46/46 PASS.

---

## BLOCK-2 — API Auth

| Change | Path |
|--------|------|
| Bearer API key middleware when `STEW_API_KEY` set; warn+allow when unset (dev) | `packages/api/src/middleware/auth.ts` |
| Exempt `/healthz`, `/v1/healthz`, `/v1/readyz`, `/v1/webhooks/*` | same |
| CORS via `CORS_ORIGIN` (default `*` in dev) | same + `app.ts` |
| `X-Org-Id` on context → sessions / gate / stewardship | `packages/api/src/app.ts` |
| `GET /v1/auth/status` (mode, hint, optional OIDC stub) | `packages/api/src/app.ts` |
| CLI + UI send Bearer / `X-Org-Id` | `packages/cli/src/api-client.ts`, `packages/ui/src/lib/api.ts` |

## BLOCK-3 — Helm + deploy

| Change | Path |
|--------|------|
| `sandbox.provider` default **`null`** (not k8s) | `deploy/helm/codesteward/values.yaml` |
| `DATABASE_URL` from secret on API + worker | `templates/api-deployment.yaml`, `worker-deployment.yaml` |
| Optional Postgres StatefulSet | `templates/postgres.yaml` (`database.enabled`) |
| Secret template (apiKey, databaseUrl, SCM tokens) | `templates/secret.yaml` |
| Production notes: DATABASE_URL required, graph backend, sandbox | `deploy/helm/codesteward/README.md` |
| Neo4j compose stack (PG + Neo4j + MCP + api/worker/ui) | `deploy/compose/docker-compose.neo4j.yml` |
| JanusGraph compose stack | `deploy/compose/docker-compose.janusgraph.yml` |

## BLOCK-4 — Sandbox

| Change | Path |
|--------|------|
| LocalSandbox docker path confirmed fully working (upload/download/exec) | `packages/sandbox/src/local.ts` |
| K8sSandbox: real Job via `kubectl` when available | `packages/sandbox/src/k8s.ts` |
| Factory auto-fallback to LocalSandbox if k8s requested but kubectl missing | `packages/sandbox/src/factory.ts` (`createSandbox`, `createSandboxAsync`) |
| Prove continues to use LocalSandbox when no explicit sandbox | orchestrator (existing) |

## BLOCK-5 — Checkpoint FK

| Change | Path |
|--------|------|
| Migration `session_checkpoints` (no unit FK) + `repo_review_state` | `packages/db/migrations/003_session_checkpoints.sql` |
| `CheckpointsRepository.saveSession` / `getSessionStage`; unit path upserts `review_units` first | `packages/db/src/repositories/checkpoints.ts` |
| `CheckpointStore` prefers `saveSession` / `getSessionStage` | `packages/agents/src/self-heal.ts` |

## Learning Postgres

| Change | Path |
|--------|------|
| Dual-mode `createLearningStore()`: Pg when `DATABASE_URL`, else file | `packages/learning/src/store.ts` |
| Repo state CRUD on `LearningRepository` | `packages/db/src/repositories/learning.ts` |
| Workspace dep `@codesteward/db` | `packages/learning/package.json` |

## NATS

| Change | Path |
|--------|------|
| Real JetStream consumer via dynamic `import("nats")` | `services/worker/src/queue-nats.ts` |
| Optional dep `nats@^2.29.3`; graceful fallback if missing | `services/worker/package.json` |
| Document install: `pnpm add nats --filter @codesteward/worker` | code comments / this log |

## SCM / Webhooks

| Change | Path |
|--------|------|
| GitLab webhook handler + token/HMAC verify | `packages/webhooks/src/gitlab-handler.ts` |
| Route `POST /v1/webhooks/gitlab` | `packages/api/src/app.ts` |
| GitHub PR files pagination (`per_page=100`, Link headers) | `packages/scm/src/github.ts` |
| `issue_comment` mention trigger `@codesteward review` | `packages/webhooks/src/github-handler.ts` (`STEW_MENTION_TOKEN`) |

## Attestation

| Change | Path |
|--------|------|
| `stew guard install` / `uninstall` pre-commit hook (lite review) | `packages/cli/src/index.ts` |
| SCM publish summary trailers `STW-REVIEWED*` | `packages/agents/src/orchestrator.ts` |

## SAST

| Change | Path |
|--------|------|
| `runSastAdapters` — semgrep / gitleaks when on PATH | `packages/agents/src/sast.ts` |
| Wired early in orchestrator (`STEW_SAST=0` to disable) | `packages/agents/src/orchestrator.ts` |

## OTel

| Change | Path |
|--------|------|
| Optional console exporter when `OTEL_ENABLED=1` | `packages/api/src/otel.ts`, `services/worker/src/index.ts` |
| Optional `@opentelemetry/api` | api + worker package.json |

## Tests

| Change | Path |
|--------|------|
| Self-heal unit tests | `packages/agents/src/__tests__/self-heal.test.ts` |
| Webhook signature tests (GitHub + GitLab) | `packages/webhooks/src/__tests__/signature.test.ts` |
| Fingerprint tests (existing) | `packages/core/src/__tests__/fingerprint.test.ts` |
| Root `pnpm test` already recursive | root `package.json` |

## Skills

| Change | Path |
|--------|------|
| Cross-repo / graph map skill | `skills/steward-map/SKILL.md` |
| Security / SAST skill | `skills/steward-security/SKILL.md` |

## UI

| Change | Path |
|--------|------|
| GitLab labeled full adapter (not stub) | `packages/ui/src/pages/Connectors.tsx` |
| Auth status + local API key field | `packages/ui/src/pages/Settings.tsx` |

## Architecture honesty

| Change | Path |
|--------|------|
| §1.3 note: self-host GA milestone; enterprise SSO optional enhancement | `research/design/05-full-product-architecture.md` |
| Basic OIDC status stub via `OIDC_ISSUER` on `/v1/auth/status` | `packages/api/src/app.ts` |

---

## Remaining (non-blocking for self-host GA)

- Full OIDC/SAML SSO + RBAC (optional enterprise)
- Embedding cosine noise filter
- Outbox publisher worker
- Conversation PR Q&A agent
- Load-tested 50+ concurrent proof
- E2E compose golden-path CI

## Commands to verify

```bash
pnpm install && pnpm -r run build
pnpm test
node scripts/validate-ga.mjs
```
