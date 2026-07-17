# Codesteward cloud trial deploys

One shared stack on a **single VM**:

**nginx edge (HTTPS) · Keycloak (OIDC under `/auth`) · API · worker · UI · Postgres**

| | |
|--|--|
| **Kubernetes** | Not required |
| **LLM API key at install** | **No** — configure in UI → **Settings → Models** |
| **Identity** | Keycloak (mandatory); org groups via Admin API (`codesteward-api` service account) |
| **TLS** | **Always HTTPS** (self-signed on public IP for PKCE / `crypto.subtle`). Accept the browser warning, or put real certs in `compose/certs/`. Optional `DOMAIN` sets the CN. |

```text
deploy/cloud/
  first-boot.sh          # Docker, secrets, self-signed TLS, realm, compose up
  VERSION                # default image tag
  compose/
    docker-compose.yml   # edge(nginx) + keycloak + api + worker + ui + postgres
    nginx-edge.conf      # :80→:443, /auth/* → Keycloak, /auth/callback → UI SPA
  aws/ · azure/ · gcp/ · do/
```

## Deploy (pick a cloud)

Requires a **paid cloud account**. Resources bill to that account.

| Cloud | Entry |
|-------|--------|
| [AWS](aws/README.md) | CloudFormation Launch Stack |
| [Azure](azure/README.md) | Bicep / ARM portal deploy |
| [GCP](gcp/README.md) | Cloud Shell + `deploy.sh` |
| [DigitalOcean](do/README.md) | Docker Marketplace 1-Click, then `first-boot.sh` |

## After boot

1. Wait **5–15 minutes** (Docker + GHCR pulls + Keycloak first start).
2. `sudo cat /var/lib/codesteward/credentials.txt`
3. Open the **https://** UI URL (accept self-signed cert).
4. Sign in (demo user in credentials) → create org → **Settings → Models**.

### Gotchas (fixed in tree)

| Symptom | Cause | Fix in tree |
|---------|--------|-------------|
| Nothing on :80 | first-boot failed / still running | `first-boot.sh` logs + `FORCE_BOOT=1` |
| `imageTag: unbound variable` | IaC left `${imageTag}` in env | Placeholder sanitization + quoted `.env` |
| Traefik 404 / Docker API 1.24 | Traefik + Docker Engine 29 | **nginx edge** (no Docker socket) |
| `Crypto.subtle` / secure context | HTTP on public IP | Default **HTTPS** + self-signed cert |
| Keycloak “Page not found” on callback | `/auth/callback` went to Keycloak | nginx `location = /auth/callback` → UI |
| Identity directory not configured | Admin issuer parse missed `/auth/realms` | `keycloak-admin.ts` path-based issuer |
| Sign-in Failed to fetch (localhost) | UI image baked `localhost` OIDC | SPA ignores loopback bake-time issuer off-localhost; empty Dockerfile.ui defaults |

## Manual smoke (any Ubuntu VM)

```bash
sudo bash -c '
  export IMAGE_TAG=1.2.0
  # optional: DOMAIN=steward.example.com
  git clone --depth 1 https://github.com/Codesteward/codesteward.git /opt/codesteward
  bash /opt/codesteward/deploy/cloud/first-boot.sh
'
```

## Images

| Service | Image |
|---------|--------|
| API / worker | `ghcr.io/codesteward/codesteward:<tag>` |
| UI | `ghcr.io/codesteward/codesteward/ui:<tag>` |
| Keycloak | `ghcr.io/codesteward/codesteward/keycloak:26.7.0` |
| Edge | `nginx:1.27-alpine` |
| Postgres | `postgres:16-alpine` |

UI image should **not** bake localhost OIDC issuer (see `deploy/compose/Dockerfile.ui`); runtime uses `/v1/auth/oidc/status`.
