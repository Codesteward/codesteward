# Codesteward Review

Agentic dual-mode code review platform (PR **gate** + branch **stewardship**) on Codesteward Graph.

## Branding / product name (mandatory)

| Correct | Wrong (never use) |
|---------|-------------------|
| **Codesteward** | CodeSteward, Code Steward, code-steward (display) |
| **Codesteward Graph** | CodeSteward Graph |
| **Codesteward Review** | CodeSteward Review |

- Product/UI/docs/strings/comments: always **Codesteward** (capital **C**, rest lowercase).
- Package/npm scope stays `@codesteward/*` (already lowercase).
- Env/prefixes like `STEW_`, CLI `stew` are fine; do not invent `CodeSteward` in new code.

## Identity (Keycloak SoT)

- **`STEW_IDENTITY_MODE=keycloak`** (default when `OIDC_ISSUER` set): Keycloak owns users/groups/roles/orgs.
- **Login UX:** unauthenticated users are **redirected immediately** to the platform IdP login page
  (Keycloak + Codesteward theme). The React `/login` page is **not** the normal password UI.
- **MFA / federated SSO** (Entra, Google, Okta, …) = configure only in Keycloak; no Codesteward code changes.
- Break-glass local form: `/login?local=1` only.
- Local DB holds a **shadow** user + membership for product FKs only.
- Org multi-tenancy claim: Keycloak groups `/orgs/{slug}` → token `groups` claim.
- Product roles: realm roles `steward-admin` | `steward-reviewer` | `steward-viewer`.
- Members UI provisions via Keycloak Admin API (`KEYCLOAK_ADMIN_CLIENT_ID` / `SECRET`).
- Login theme: `deploy/compose/keycloak/themes/codesteward` (`loginTheme: codesteward`).
- SCIM into Codesteward is optional/legacy; preferred corporate path is IdP → Keycloak.

## Stack

- TypeScript ESM monorepo (pnpm, Node ≥22, `NodeNext`)
- Packages under `packages/*`; worker at `services/worker` (`@codesteward/worker`)
- Hono API, Vite+React UI, Commander CLI (`stew`)
- Graph via MCP HTTP client; `GRAPH_MOCK=1` for offline

## Commands

```bash
pnpm install && pnpm -r run build
GRAPH_MOCK=1 pnpm dev:api      # :8081
GRAPH_MOCK=1 pnpm dev:worker
pnpm dev:ui                    # :8080
pnpm stew -- review -p . -r codesteward
pnpm stew -- review --tier thorough --depth thorough
pnpm stew -- config doctor
pnpm stew -- doctor full
pnpm stew -- resume <sessionId>
pnpm stew -- findings export --sarif -s <sessionId>
```

## Layout

| Package | Role |
|---------|------|
| `core` | Zod schemas, IDs, events |
| `model-router` | OpenAI/Anthropic/xAI/compat/LiteLLM |
| `graph-client` | Graph MCP + mock |
| `policy` | STEWARD.md + `.codesteward/rules` (base branch) |
| `findings` | Store + fingerprint + SARIF 2.1.0 |
| `learning` | Reactions 👍/👎, org memories, last_reviewed_sha |
| `db` | Postgres SoT (sessions, findings, jobs, learning) |
| `sandbox` | Local/Docker/K8s stub/Null + Prove (LLM test gen) |
| `scm` | GitHub, GitLab, Bitbucket, Azure DevOps, Gitea |
| `agents` | Orchestrator, specialists, judge, discourse, noise, diff packing |
| `api` / `cli` / `mcp-server` / `ui` | Surfaces |
| `actions/review-action` | GitHub Action for PR gate |
| `services/worker` | Job consumer |

## Conventions

- ESM only; use `.js` extensions in relative imports
- Workspace deps: `"@codesteward/*": "workspace:*"`
- Never commit; policy loads from base branch only
- Optional peer: `deepagents` via `createDeepAgentRunner`
- Shared demo state: `.steward-data/` (sessions, jobs, findings, learning, `users.json`, `connectors.json`)
- Thorough mode (`riskTier` or `depth` = `thorough`) runs discourse (dual correctness + AGREE/CHALLENGE/CONNECT/SURFACE)
- Incremental gate uses `last_reviewed_sha` in learning store; pass `fullReview` to force full
- Env SCM tokens: `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`+`BITBUCKET_USERNAME`, `AZURE_DEVOPS_TOKEN`, `GITEA_TOKEN`
- PR mention trigger (webhook `issue_comment`): default **`@codesteward`** via `STEW_MENTION_TOKEN` (override if needed). Example: `@codesteward review`
- Job queue: **Postgres by default** (`DATABASE_URL`). Optional dispatch broker: `STEW_QUEUE_BROKER=nats|rabbitmq|pulsar` (+ URL) — hybrid SoT+broker for KEDA; see `deploy/compose/docker-compose.queue.yml`

## Self-host auth + connectors

- Modes: `open` (no users, no `STEW_API_KEY`) → `api_key` → `users` after bootstrap
- First visit: `POST /v1/auth/bootstrap {email, password, displayName}` creates admin
- Login: `POST /v1/auth/login` → Bearer session token; passwords scrypt (`node:crypto`); session tokens hashed at rest
- RBAC: `viewer` read-only; `reviewer` start reviews/react; `admin` connectors/models/policy
- Connectors: `GET/PUT/DELETE /v1/org/connectors/:type` (+ `/test`); secrets stored as-is for self-host, masked last4 on GET; applied into env for SCM
- SCM: `GET /v1/scm/repos?provider=github`, `GET /v1/scm/prs/:owner/:repo?provider=…`, `…/:number`, `…/:number/diff`
- Postgres: migration `packages/db/migrations/004_users_auth.sql` when `DATABASE_URL` set; else file stores

## Architecture

See monorepo layout in root `README.md`, `docs/ENTERPRISE_GAPS.md`, and `deploy/helm/codesteward/README.md`.
Local design notes may also live under `research/` when present (not always published).
