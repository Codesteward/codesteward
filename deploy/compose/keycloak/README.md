# Codesteward Keycloak

Identity for Codesteward Review: **OIDC login**, realm clients, Admin API for Members provisioning.

## Versioning = upstream Keycloak

Our image is **not** tagged with the product release (`1.2.0`). Tags match
[`quay.io/keycloak/keycloak`](https://quay.io/repository/keycloak/keycloak):

| Tag | Meaning |
|-----|---------|
| `26.7.0` | Built on Keycloak **26.7.0** + Codesteward theme/realm |
| `26.7` | Same build, minor alias (when published) |
| `latest` | Newest base we published (weekly update or release) |

Compare upstream vs ours:

```bash
# Upstream
docker pull quay.io/keycloak/keycloak:26.7.0

# Ours (theme + realm baked in — same version string)
docker pull ghcr.io/codesteward/codesteward/keycloak:26.7.0
```

If `26.7.1` exists on Quay but not on GHCR, you are behind — wait for the
**Keycloak base update** workflow (weekly) or trigger it manually.

Pin in-repo: [`KEYCLOAK_VERSION`](./KEYCLOAK_VERSION) (source of truth for CI).

## Why a dedicated image?

Compose can bind-mount `./themes` from a git checkout. **Kubernetes operators do not.**
Release + scheduled CI publish a ready image; Helm only sets `image.tag` to the Keycloak version.

## Pull and run (no repo)

```bash
KC=26.7.0   # or: curl -sL … | cat KEYCLOAK_VERSION after clone
docker pull ghcr.io/codesteward/codesteward/keycloak:$KC

docker run -d --name codesteward-keycloak -p 8083:8083 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD='change-me' \
  -e KC_HTTP_PORT=8083 \
  -e KC_HOSTNAME_STRICT=false \
  ghcr.io/codesteward/codesteward/keycloak:$KC \
  start-dev --import-realm --http-port=8083
```

Production (TLS at ingress):

```bash
…/keycloak:$KC start --import-realm --http-enabled=true --hostname=auth.example.com
```

## CI

| Workflow | When | Tags pushed |
|----------|------|-------------|
| **Release** (`v*.*.*`) | Product release | `$KEYCLOAK_VERSION`, minor alias, `latest` (theme/realm as of that commit) |
| **Keycloak base update** (weekly + manual) | New Keycloak on GitHub/Quay | same; opens PR to bump `KEYCLOAK_VERSION` |

## Kubernetes (Helm)

```bash
helm upgrade --install codesteward ./deploy/helm/codesteward \
  --set keycloak.enabled=true \
  --set keycloak.image.repository=ghcr.io/codesteward/codesteward/keycloak \
  --set keycloak.image.tag=26.7.0 \
  --set secrets.keycloakAdminPassword=$KC_ADMIN_PASSWORD
```

No git volume for themes. External IdP: leave `keycloak.enabled=false`.

## Local build

```bash
cd deploy/compose/keycloak
KC=$(cat KEYCLOAK_VERSION)
docker build --build-arg KEYCLOAK_VERSION=$KC -t codesteward-keycloak:$KC .
```

SaaS realm:

```bash
docker build --build-arg KEYCLOAK_VERSION=$KC \
  --build-arg REALM_FILE=realm-codesteward-saas.json \
  -t codesteward-keycloak:$KC-saas .
```

## Compose

```bash
export KEYCLOAK_IMAGE=ghcr.io/codesteward/codesteward/keycloak:$(cat deploy/compose/keycloak/KEYCLOAK_VERSION)
docker compose -f deploy/compose/docker-compose.keycloak.yml up -d
```

Without `KEYCLOAK_IMAGE`, compose builds this Dockerfile from the checkout.
