# Deploy Codesteward to Google Cloud

This Cloud Shell tutorial creates a single GCE VM running the Codesteward
**cloud Compose stack** (Traefik, Keycloak, API, worker, UI, Postgres).

**Requirements:** a GCP project with billing, ~8 GB RAM VM quota.

## Steps

1. Set your project (Cloud Shell may already have one selected):

```bash
gcloud config set project YOUR_PROJECT_ID
```

2. Optional TLS — export a domain you control (A record later):

```bash
export DOMAIN=           # e.g. steward.example.com
export ACME_EMAIL=       # e.g. you@example.com
export IMAGE_TAG=1.2.0
```

3. Deploy:

```bash
bash deploy/cloud/gcp/deploy.sh
```

4. After ~5–10 minutes, fetch credentials:

```bash
gcloud compute ssh codesteward-cloud --zone "${ZONE:-us-central1-a}" \
  --command 'sudo cat /var/lib/codesteward/credentials.txt'
```

5. Open the UI URL → Keycloak login → **Settings → Models** to add an LLM key.

## Cleanup

```bash
gcloud compute instances delete codesteward-cloud --zone "${ZONE:-us-central1-a}" --quiet
gcloud compute firewall-rules delete codesteward-http --quiet || true
```
