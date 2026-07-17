#!/usr/bin/env bash
# Codesteward cloud first-boot — install Docker (if needed), write secrets/env,
# render Keycloak realm for public URL, pull GHCR images, start Compose stack.
#
# Env (optional):
#   DOMAIN          Public DNS name (HTTPS CN; self-signed unless you replace certs/)
#   ACME_EMAIL      Reserved for future Let's Encrypt automation
#   IMAGE_TAG       App/UI image tag (default from VERSION file or 1.2.0)
#   PUBLIC_IP       Override auto-detected public IP
#   SKIP_DOCKER_INSTALL=1
#   COMPOSE_PROJECT_DIR  Default: directory of this script
#
# Always serves HTTPS via nginx edge (self-signed on public IP) so browser
# OIDC PKCE has crypto.subtle. Accept the cert warning, or put a real cert in compose/certs/.
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
    # Azure IMDS (public IP on NIC; Standard SKU)
    ip="$(curl -fsS --max-time 3 -H Metadata:true --noproxy '*' \
      'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-12-13&format=text' 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    # Azure compute loadBalancer public IP (some images)
    ip="$(curl -fsS --max-time 3 -H Metadata:true --noproxy '*' \
      'http://169.254.169.254/metadata/loadbalancer?api-version=2021-12-13' 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('loadbalancer',{}).get('publicIpAddresses',[{}])[0].get('frontendIpAddress',''))" 2>/dev/null || true)"
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
# sslRequired: none only if public_url is http (legacy); cloud trial uses https + external
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


ensure_tls_certs() {
  local cn="$1"
  local certdir="$COMPOSE_DIR/certs"
  mkdir -p "$certdir"
  if [[ -f "$certdir/tls.crt" && -f "$certdir/tls.key" ]]; then
    log "TLS certs already present in $certdir"
    return
  fi
  log "Generating self-signed TLS cert for CN=$cn (accept browser warning; use DOMAIN for real LE later)"
  if openssl req -x509 -nodes -newkey rsa:2048 -days 825       -keyout "$certdir/tls.key" -out "$certdir/tls.crt"       -subj "/CN=${cn}"       -addext "subjectAltName=DNS:${cn},IP:${cn}" 2>/dev/null; then
    :
  else
    openssl req -x509 -nodes -newkey rsa:2048 -days 825       -keyout "$certdir/tls.key" -out "$certdir/tls.crt"       -subj "/CN=${cn}"
  fi
  chmod 600 "$certdir/tls.key"
}

write_env() {
  local public_ip="$1"
  local domain="${DOMAIN:-}"
  local scheme host public_url tls

  # Always HTTPS for browser OIDC PKCE (crypto.subtle requires a secure context).
  # With DOMAIN: expect real DNS + optional ACME later; without: self-signed on public IP.
  if [[ -n "$domain" ]]; then
    scheme="https"
    host="$domain"
    public_url="https://${domain}"
    tls=1
    ACME_EMAIL="${ACME_EMAIL:-admin@${domain}}"
  else
    scheme="https"
    host="$public_ip"
    public_url="https://${public_ip}"
    tls=1
    ACME_EMAIL="${ACME_EMAIL:-}"
  fi
  ensure_tls_certs "$host"

  # Reuse secrets if re-run
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; set +u; source "$ENV_FILE"; set -u; set +a
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

  q() { printf '%q' "$1"; }
  {
    echo "# Generated by first-boot.sh — do not commit"
    echo "IMAGE_TAG=$(q "$IMAGE_TAG")"
    echo "APP_IMAGE=$(q "$APP_IMAGE")"
    echo "UI_IMAGE=$(q "$UI_IMAGE")"
    echo "KEYCLOAK_IMAGE=$(q "$KEYCLOAK_IMAGE")"
    echo "POSTGRES_USER=$(q "$POSTGRES_USER")"
    echo "POSTGRES_PASSWORD=$(q "$POSTGRES_PASSWORD")"
    echo "POSTGRES_DB=$(q "$POSTGRES_DB")"
    echo "STEW_SECRETS_KEY=$(q "$STEW_SECRETS_KEY")"
    echo "STEW_API_KEY=$(q "$STEW_API_KEY")"
    echo "KEYCLOAK_ADMIN=$(q "$KEYCLOAK_ADMIN")"
    echo "KEYCLOAK_ADMIN_PASSWORD=$(q "$KEYCLOAK_ADMIN_PASSWORD")"
    echo "KEYCLOAK_ADMIN_CLIENT_SECRET=$(q "$KEYCLOAK_ADMIN_CLIENT_SECRET")"
    echo "TRAEFIK_HOST=$(q "$host")"
    echo "STEW_PUBLIC_URL=$(q "$public_url")"
    echo "STEW_API_PUBLIC_URL=$(q "$public_url")"
    echo "OIDC_PUBLIC_ISSUER=$(q "${public_url}/auth/realms/codesteward")"
    echo "OIDC_REDIRECT_URI=$(q "${public_url}/v1/auth/oidc/callback")"
    echo "KC_HOSTNAME_URL=$(q "${public_url}/auth")"
    echo "KC_HOSTNAME_ADMIN_URL=$(q "${public_url}/auth")"
    echo "DOMAIN=$(q "${domain}")"
    echo "ACME_EMAIL=$(q "${ACME_EMAIL}")"
    echo "TLS_ENABLED=$(q "$tls")"
  } >"$ENV_FILE"

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
TLS: HTTPS on ${public_url} (self-signed cert in compose/certs/ — accept browser warning; replace with a real cert or set DOMAIN + install LE later)
Images: ${APP_IMAGE}
Note: Wait until Keycloak finishes first start (~30–60s) before signing in.
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
  # shellcheck disable=SC1090
  set -a; set +u; source "$ENV_FILE"; set -u; set +a
  cd "$COMPOSE_DIR"
  # Ensure TLS material exists (nginx edge always listens on 443)
  if [[ ! -f "$COMPOSE_DIR/certs/tls.crt" || ! -f "$COMPOSE_DIR/certs/tls.key" ]]; then
    ensure_tls_certs "${TRAEFIK_HOST:-localhost}"
  fi
  log "Starting stack (nginx edge HTTPS + Keycloak path /auth)…"
  log "Pulling images…"
  docker compose --env-file "$ENV_FILE" -f docker-compose.yml pull || log "Pull failed for some images — will try local/cached"
  log "Starting stack…"
  docker compose --env-file "$ENV_FILE" -f docker-compose.yml up -d
  log "Stack started. Credentials: $CRED_FILE"
  log "Open ${STEW_PUBLIC_URL:-https://<public-ip>/} (accept self-signed cert). Wait ~1 min for Keycloak before login."
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
  # Strip uninterpolated IaC placeholders (e.g. Azure left ${imageTag} in customData)
  case "${IMAGE_TAG:-}" in
    *'${'*|*imageTag*) IMAGE_TAG="$(tr -d '[:space:]' <"$VERSION_FILE" 2>/dev/null || echo 1.2.0)"; log "Using IMAGE_TAG=$IMAGE_TAG" ;;
  esac
  case "${DOMAIN:-}" in
    *'${'*|domain) DOMAIN="" ;;
  esac
  case "${ACME_EMAIL:-}" in
    *'${'*) ACME_EMAIL="" ;;
  esac
  export IMAGE_TAG DOMAIN ACME_EMAIL

  local ip
  ip="$(detect_public_ip)"
  log "Public IP: $ip  DOMAIN=${DOMAIN:-<none>} IMAGE_TAG=${IMAGE_TAG}"
  write_env "$ip"
  start_stack
  date -u +%Y-%m-%dT%H:%MZ >"$MARKER"
  log "Done."
  cat "$CRED_FILE"
}

main "$@"
