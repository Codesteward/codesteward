#!/usr/bin/env bash
# Codesteward cloud first-boot — install Docker (if needed), write secrets/env,
# render Keycloak realm for public URL, pull GHCR images, start Compose stack.
#
# Env (optional):
#   DOMAIN          Public DNS name (enables Traefik TLS + Let's Encrypt)
#   ACME_EMAIL      Email for Let's Encrypt (default admin@DOMAIN)
#   IMAGE_TAG       App/UI image tag (default from VERSION file or 1.2.0)
#   PUBLIC_IP       Override auto-detected public IP
#   SKIP_DOCKER_INSTALL=1
#   COMPOSE_PROJECT_DIR  Default: directory of this script
set -euo pipefail

CLOUD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_PROJECT_DIR:-$CLOUD_ROOT/compose}"
VERSION_FILE="$CLOUD_ROOT/VERSION"
IMAGE_TAG="${IMAGE_TAG:-$(tr -d '[:space:]' <"$VERSION_FILE" 2>/dev/null || echo 1.2.0)}"
STATE_DIR="${STATE_DIR:-/var/lib/codesteward}"
CRED_FILE="${CRED_FILE:-$STATE_DIR/credentials.txt}"
ENV_FILE="$COMPOSE_DIR/.env"
REALM_DIR="$COMPOSE_DIR/realm-import"
MARKER="$STATE_DIR/first-boot.done"

log() { echo "[codesteward-cloud] $*"; }
die() { echo "[codesteward-cloud] ERROR: $*" >&2; exit 1; }

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "Run as root (cloud-init / sudo)."
  fi
}

install_docker() {
  if [[ "${SKIP_DOCKER_INSTALL:-0}" == "1" ]]; then
    command -v docker >/dev/null || die "docker not installed and SKIP_DOCKER_INSTALL=1"
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker Compose already available"
    return
  fi
  log "Installing Docker Engine + Compose plugin…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
    fi
    # Works on Ubuntu/Debian; fallback to get.docker.com if repo fails
    . /etc/os-release
    if [[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]]; then
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin || true
    fi
  fi
  if ! command -v docker >/dev/null 2>&1; then
    log "Falling back to get.docker.com convenience script…"
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  docker compose version >/dev/null || die "docker compose plugin missing after install"
}

detect_public_ip() {
  if [[ -n "${PUBLIC_IP:-}" ]]; then
    echo "$PUBLIC_IP"
    return
  fi
  local ip=""
  ip="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(curl -fsS --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    # GCP
    ip="$(curl -fsS --max-time 3 -H 'Metadata-Flavor: Google' \
      http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    # Azure
    ip="$(curl -fsS --max-time 3 -H Metadata:true \
      'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  [[ -n "$ip" ]] || die "Could not detect public IP; set PUBLIC_IP=..."
  echo "$ip"
}

rand_hex() { openssl rand -hex "${1:-32}"; }
rand_b64() { openssl rand -base64 "${1:-24}" | tr -d '\n=/' | head -c "${2:-32}"; }

render_realm() {
  local public_url="$1"
  local api_secret="$2"
  local base="$COMPOSE_DIR/realm-codesteward.base.json"
  [[ -f "$base" ]] || base="$CLOUD_ROOT/compose/realm-codesteward.base.json"
  [[ -f "$base" ]] || die "Missing realm base JSON at $base"
  mkdir -p "$REALM_DIR"
  python3 - "$base" "$REALM_DIR/codesteward-realm.json" "$public_url" "$api_secret" <<'PY'
import json, sys
src, dst, public_url, api_secret = sys.argv[1:5]
with open(src, encoding="utf-8") as f:
    realm = json.load(f)
# Public SPA + API callback (UI nginx proxies /v1 → API)
redirects = [
    f"{public_url}/*",
    f"{public_url}/auth/callback",
    f"{public_url}/v1/auth/oidc/callback",
]
origins = [public_url, "+"]
for c in realm.get("clients", []):
    if c.get("clientId") == "codesteward-ui":
        c["redirectUris"] = redirects
        c["webOrigins"] = origins
        attrs = c.setdefault("attributes", {})
        attrs["post.logout.redirect.uris"] = f"{public_url}/*##+"
        attrs["pkce.code.challenge.method"] = "S256"
    if c.get("clientId") == "codesteward-api":
        c["secret"] = api_secret
# External TLS terminated at Traefik; allow non-SSL from Keycloak's view when HTTP trial
if public_url.startswith("http://"):
    realm["sslRequired"] = "none"
else:
    realm["sslRequired"] = "external"
with open(dst, "w", encoding="utf-8") as f:
    json.dump(realm, f, indent=2)
    f.write("\n")
print(f"wrote {dst}")
PY
}

write_env() {
  local public_ip="$1"
  local domain="${DOMAIN:-}"
  local scheme host public_url tls

  if [[ -n "$domain" ]]; then
    scheme="https"
    host="$domain"
    public_url="https://${domain}"
    tls=1
    ACME_EMAIL="${ACME_EMAIL:-admin@${domain}}"
  else
    scheme="http"
    host="$public_ip"
    public_url="http://${public_ip}"
    tls=0
    ACME_EMAIL="${ACME_EMAIL:-}"
  fi

  # Reuse secrets if re-run
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
  fi

  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(rand_hex 16)}"
  STEW_SECRETS_KEY="${STEW_SECRETS_KEY:-$(rand_hex 32)}"
  STEW_API_KEY="${STEW_API_KEY:-$(rand_hex 16)}"
  KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-$(rand_b64 18 24)}"
  KEYCLOAK_ADMIN_CLIENT_SECRET="${KEYCLOAK_ADMIN_CLIENT_SECRET:-$(rand_hex 24)}"
  KEYCLOAK_ADMIN="${KEYCLOAK_ADMIN:-admin}"
  POSTGRES_USER="${POSTGRES_USER:-steward}"
  POSTGRES_DB="${POSTGRES_DB:-codesteward}"

  APP_IMAGE="${APP_IMAGE:-ghcr.io/codesteward/codesteward:${IMAGE_TAG}}"
  UI_IMAGE="${UI_IMAGE:-ghcr.io/codesteward/codesteward/ui:${IMAGE_TAG}}"
  KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-ghcr.io/codesteward/codesteward/keycloak:26.7.0}"

  cat >"$ENV_FILE" <<ENV
# Generated by first-boot.sh — do not commit
IMAGE_TAG=${IMAGE_TAG}
APP_IMAGE=${APP_IMAGE}
UI_IMAGE=${UI_IMAGE}
KEYCLOAK_IMAGE=${KEYCLOAK_IMAGE}

POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}

STEW_SECRETS_KEY=${STEW_SECRETS_KEY}
STEW_API_KEY=${STEW_API_KEY}

KEYCLOAK_ADMIN=${KEYCLOAK_ADMIN}
KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
KEYCLOAK_ADMIN_CLIENT_SECRET=${KEYCLOAK_ADMIN_CLIENT_SECRET}

TRAEFIK_HOST=${host}
STEW_PUBLIC_URL=${public_url}
STEW_API_PUBLIC_URL=${public_url}
OIDC_PUBLIC_ISSUER=${public_url}/auth/realms/codesteward
OIDC_REDIRECT_URI=${public_url}/v1/auth/oidc/callback
KC_HOSTNAME_URL=${public_url}/auth
KC_HOSTNAME_ADMIN_URL=${public_url}/auth

DOMAIN=${domain}
ACME_EMAIL=${ACME_EMAIL}
TLS_ENABLED=${tls}
ENV

  chmod 600 "$ENV_FILE"
  render_realm "$public_url" "$KEYCLOAK_ADMIN_CLIENT_SECRET"

  mkdir -p "$STATE_DIR"
  cat >"$CRED_FILE" <<CRED
Codesteward cloud credentials (generated $(date -u +%Y-%m-%dT%H:%MZ))
================================================================
UI:                 ${public_url}
Keycloak admin:     ${public_url}/auth/admin/
Keycloak admin user: ${KEYCLOAK_ADMIN}
Keycloak admin pass: ${KEYCLOAK_ADMIN_PASSWORD}
Demo app user:      admin@demo.com / DemoAdmin.123
API key (M2M):      ${STEW_API_KEY}

Models: configure in UI → Settings → Models (no key required at install).
TLS: $([[ "$tls" == "1" ]] && echo "Let's Encrypt for ${domain}" || echo "HTTP on IP (set DOMAIN for HTTPS)")
Images: ${APP_IMAGE}
================================================================
CRED
  chmod 600 "$CRED_FILE"

  # MOTD
  cat >/etc/motd <<MOTD

  Codesteward Review (cloud trial)
  --------------------------------
  UI:  ${public_url}
  IdP: ${public_url}/auth/
  Credentials: ${CRED_FILE}
  Compose:     ${COMPOSE_DIR}

  Configure LLM providers in the product UI (Settings → Models).

MOTD
}

start_stack() {
  local files=(-f docker-compose.yml)
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  if [[ "${TLS_ENABLED:-0}" == "1" && -n "${DOMAIN:-}" ]]; then
    files+=(-f docker-compose.tls.yml)
    log "Starting with TLS (domain=${DOMAIN})"
  else
    log "Starting HTTP-only (set DOMAIN for HTTPS)"
  fi
  cd "$COMPOSE_DIR"
  log "Pulling images…"
  docker compose --env-file "$ENV_FILE" "${files[@]}" pull || log "Pull failed for some images — will try local/cached"
  log "Starting stack…"
  docker compose --env-file "$ENV_FILE" "${files[@]}" up -d
  log "Stack started. Credentials: $CRED_FILE"
}

main() {
  require_root
  if [[ -f "$MARKER" && "${FORCE_BOOT:-0}" != "1" ]]; then
    log "first-boot already done ($MARKER). Set FORCE_BOOT=1 to re-run."
    exit 0
  fi
  install_docker
  mkdir -p "$COMPOSE_DIR" "$STATE_DIR"
  # Ensure realm base is present (image/git layout)
  if [[ ! -f "$COMPOSE_DIR/realm-codesteward.base.json" ]]; then
    if [[ -f "$CLOUD_ROOT/../compose/keycloak/realm-codesteward.json" ]]; then
      cp "$CLOUD_ROOT/../compose/keycloak/realm-codesteward.json" "$COMPOSE_DIR/realm-codesteward.base.json"
    fi
  fi
  local ip
  ip="$(detect_public_ip)"
  log "Public IP: $ip  DOMAIN=${DOMAIN:-<none>}"
  write_env "$ip"
  start_stack
  date -u +%Y-%m-%dT%H:%MZ >"$MARKER"
  log "Done."
  cat "$CRED_FILE"
}

main "$@"
