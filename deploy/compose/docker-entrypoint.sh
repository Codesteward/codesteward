#!/bin/sh
# Fix volume ownership for STEW_DATA_DIR (compose named volumes are root-owned),
# then drop to non-root steward (uid/gid 1001) for the app process.
set -eu

STEWARD_UID="${STEWARD_UID:-1001}"
STEWARD_GID="${STEWARD_GID:-1001}"
DATA_DIR="${STEW_DATA_DIR:-/data}"

WORKSPACE_DIR="${STEW_WORKSPACE_DIR:-/workspace}"
SANDBOX_TMP="${TMPDIR:-/tmp}/codesteward-sandbox"

ensure_data_dirs() {
  mkdir -p \
    "$DATA_DIR" \
    "$DATA_DIR/checkpoints" \
    "$DATA_DIR/workspaces" \
    "${STEW_CHECKPOINT_DIR:-$DATA_DIR/checkpoints}" \
    "$WORKSPACE_DIR" \
    "$SANDBOX_TMP"
}

if [ "$(id -u)" = "0" ]; then
  ensure_data_dirs
  # Best-effort chown so steward can write sessions/checkpoints/clones.
  chown -R "${STEWARD_UID}:${STEWARD_GID}" "$DATA_DIR" 2>/dev/null || true
  chown -R "${STEWARD_UID}:${STEWARD_GID}" "$WORKSPACE_DIR" 2>/dev/null || true
  chown -R "${STEWARD_UID}:${STEWARD_GID}" "$SANDBOX_TMP" 2>/dev/null || true
  if [ -n "${STEW_CHECKPOINT_DIR:-}" ] && [ "${STEW_CHECKPOINT_DIR}" != "$DATA_DIR/checkpoints" ]; then
    mkdir -p "$STEW_CHECKPOINT_DIR"
    chown -R "${STEWARD_UID}:${STEWARD_GID}" "$STEW_CHECKPOINT_DIR" 2>/dev/null || true
  fi
  # Drop privileges (util-linux setpriv is present on bookworm-slim)
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="${STEWARD_UID}" --regid="${STEWARD_GID}" --clear-groups -- "$@"
  fi
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u steward -g steward -- "$@"
  fi
  echo "warning: could not drop privileges; running as root" >&2
  exec "$@"
fi

# Already non-root (e.g. compose user: override) — ensure dirs exist if writable
ensure_data_dirs 2>/dev/null || true
if ! touch "${DATA_DIR}/.write-test" 2>/dev/null; then
  echo "ERROR: ${DATA_DIR} is not writable by uid=$(id -u). Fix volume ownership or start the container as root so the entrypoint can chown." >&2
  exit 1
fi
rm -f "${DATA_DIR}/.write-test"
exec "$@"
