#!/usr/bin/env bash
# Deploy Codesteward cloud trial to a single GCE VM (same Compose stack as other clouds).
# Intended for Cloud Shell "Deploy to Google Cloud" or local gcloud.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${ZONE:-us-central1-a}"
INSTANCE_NAME="${INSTANCE_NAME:-codesteward-cloud}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
DOMAIN="${DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
IMAGE_TAG="${IMAGE_TAG:-1.2.0}"
GIT_REF="${GIT_REF:-main}"

[[ -n "$PROJECT_ID" ]] || { echo "Set PROJECT_ID or gcloud config set project"; exit 1; }

echo "Project=$PROJECT_ID Zone=$ZONE Instance=$INSTANCE_NAME Domain=${DOMAIN:-<ip>}"

gcloud config set project "$PROJECT_ID"

# Enable APIs (idempotent)
gcloud services enable compute.googleapis.com --quiet

STARTUP="$(mktemp)"
cat >"$STARTUP" <<SCRIPT
#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/codesteward-user-data.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates openssl python3 jq
export DOMAIN='${DOMAIN}'
export ACME_EMAIL='${ACME_EMAIL}'
export IMAGE_TAG='${IMAGE_TAG}'
REF='${GIT_REF}'
INSTALL_DIR=/opt/codesteward
git clone --depth 1 --branch "\$REF" https://github.com/Codesteward/codesteward.git "\$INSTALL_DIR" \\
  || git clone --depth 1 https://github.com/Codesteward/codesteward.git "\$INSTALL_DIR"
cd "\$INSTALL_DIR" && git checkout "\$REF" 2>/dev/null || true
bash "\$INSTALL_DIR/deploy/cloud/first-boot.sh"
SCRIPT

gcloud compute firewall-rules describe codesteward-http --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create codesteward-http \
    --project "$PROJECT_ID" \
    --allow=tcp:80,tcp:443 \
    --target-tags=codesteward-cloud \
    --description="Codesteward UI/Traefik"

gcloud compute instances describe "$INSTANCE_NAME" --zone "$ZONE" --project "$PROJECT_ID" >/dev/null 2>&1 && {
  echo "Instance already exists: $INSTANCE_NAME"
  exit 1
}

gcloud compute instances create "$INSTANCE_NAME" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=40GB \
  --tags=codesteward-cloud \
  --metadata-from-file=startup-script="$STARTUP"

rm -f "$STARTUP"

IP="$(gcloud compute instances describe "$INSTANCE_NAME" --zone "$ZONE" --project "$PROJECT_ID" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

echo ""
echo "Created $INSTANCE_NAME at $IP"
echo "Wait ~5–10 minutes for first-boot, then:"
echo "  gcloud compute ssh $INSTANCE_NAME --zone $ZONE --command 'sudo cat /var/lib/codesteward/credentials.txt'"
echo "UI: http://$IP/"
[[ -n "$DOMAIN" ]] && echo "Point $DOMAIN A record to $IP for HTTPS"
