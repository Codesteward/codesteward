# Pull-only stack (Compose + Swarm)

Deploy Codesteward Review from **published GHCR images** only — no monorepo clone required for the app build.

| Artifact | Default image |
|----------|----------------|
| API + worker | `ghcr.io/codesteward/codesteward:1.4.0` |
| UI | `ghcr.io/codesteward/codesteward/ui:1.4.0` |
| Keycloak | `ghcr.io/codesteward/codesteward/keycloak:26.7.0` |
| Postgres | `postgres:16-alpine` |

Files:

- `docker-compose.stack.yml` — base stack (images only, `deploy:` for Swarm)
- `docker-compose.stack.compose.yml` — bridge network override for non-Swarm Compose
- `.env.stack.example` — env template

## Docker Compose (single host)

```bash
cp deploy/compose/.env.stack.example .env.stack
# edit STEW_SECRETS_KEY (openssl rand -hex 32) and passwords

docker compose --env-file .env.stack \
  -f deploy/compose/docker-compose.stack.yml \
  -f deploy/compose/docker-compose.stack.compose.yml \
  pull

docker compose --env-file .env.stack \
  -f deploy/compose/docker-compose.stack.yml \
  -f deploy/compose/docker-compose.stack.compose.yml \
  up -d
```

Open UI `http://localhost:8080`, API `http://localhost:8081`, Keycloak `http://localhost:8083`.

## Docker Swarm

```bash
docker swarm init   # once per cluster
cp deploy/compose/.env.stack.example .env.stack
# edit secrets…

# Render env into a swarm-compatible config (Compose interpolates ${VAR})
set -a && source .env.stack && set +a
docker compose --env-file .env.stack -f deploy/compose/docker-compose.stack.yml config > /tmp/codesteward-stack.yml

docker stack deploy -c /tmp/codesteward-stack.yml codesteward --with-registry-auth
docker service ls | grep codesteward
```

Scale workers:

```bash
docker service scale codesteward_worker=3
```

Notes:

- **No `build:`** — only `image:` pulls.
- Swarm uses **overlay** network from the base file; Compose override switches to **bridge**.
- Set public URLs (`STEW_PUBLIC_URL`, OIDC/Keycloak hostnames) when exposing beyond localhost.
- Private GHCR images: `docker login ghcr.io` (and `--with-registry-auth` on stack deploy).
- Product version pin: change `IMAGE_TAG` / `APP_IMAGE` / `UI_IMAGE` when upgrading.

## Sign-in: Keycloak vs “local” password form

The stack sets `STEW_IDENTITY_MODE=keycloak`. Normal sign-in should redirect to Keycloak.

If the UI shows **local / bootstrap email+password** instead:

1. **UI → API proxy failed (502)** — browser calls `http://localhost:8080/v1/auth/…`; nginx in the UI image proxies to `api:8081`. If that 502s (often stale Docker DNS after API recreated), the SPA cannot load OIDC status and falls back to the local form.
   - Quick fix: recreate UI after API is healthy  
     `docker compose … up -d --force-recreate ui`
   - Confirm: `curl -sS http://localhost:8080/v1/auth/status` should return JSON with `"identityMode":"keycloak"` and `"oidc":{"status":"ready",…}` (not HTML 502).
2. **`auth.mode: "open"`** on a fresh DB is normal until the first Keycloak login or bootstrap — it does **not** mean Keycloak is off. Org id **`local`** is also normal (single-tenant product org name).
3. Break-glass only: `/login?local=1` forces the local form on purpose.

Keycloak UI: `http://localhost:8083` (admin from env). Realm client `codesteward-ui` must allow redirect `http://localhost:8080/auth/callback` (and API callback if used).
