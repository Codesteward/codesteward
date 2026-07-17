#!/usr/bin/env bash
# /var/lib/cloud/scripts/per-instance/99-codesteward.sh (Marketplace image)
# Runs once per droplet create.
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/codesteward}"
# Optional: DigitalOcean metadata for user-data keys
if command -v curl >/dev/null; then
  # Vendor may pass domain via user-data file written by fabricator
  true
fi
export DOMAIN="${DOMAIN:-}"
export ACME_EMAIL="${ACME_EMAIL:-}"
export IMAGE_TAG="${IMAGE_TAG:-1.3.0}"
if [[ -x "$INSTALL_DIR/deploy/cloud/first-boot.sh" ]]; then
  bash "$INSTALL_DIR/deploy/cloud/first-boot.sh"
else
  echo "codesteward: first-boot missing under $INSTALL_DIR" >&2
  exit 1
fi
