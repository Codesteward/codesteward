# DigitalOcean — Marketplace 1-Click (A)

Codesteward is designed as a **native Marketplace Droplet 1-Click App**. Until that listing is approved, the README button opens DigitalOcean’s **Docker** 1-Click (same shape: droplet + Docker Compose), then you run our first-boot.

| Path | Role |
|------|------|
| [`marketplace/`](marketplace/) | Vendor image build notes + per-instance hook |
| [`cloud-init.yaml`](cloud-init.yaml) | cloud-init for custom images / testing |
| Shared stack | [`../first-boot.sh`](../first-boot.sh) + [`../compose/`](../compose/) |

## Try today (README button target)

1. Open **[Docker on DigitalOcean Marketplace](https://marketplace.digitalocean.com/apps/docker)** → **Create Docker Droplet**.  
   Prefer **4 GB+ RAM** (8 GB comfortable). Open ports **80** / **443**.
2. SSH in as root, then:

```bash
export IMAGE_TAG=1.3.0
# optional TLS: export DOMAIN=steward.example.com ACME_EMAIL=you@example.com
git clone --depth 1 https://github.com/Codesteward/codesteward.git /opt/codesteward
bash /opt/codesteward/deploy/cloud/first-boot.sh
cat /var/lib/codesteward/credentials.txt
```

3. Open the printed UI URL → Keycloak login → **Settings → Models**.

## After native Marketplace go-live

Listing URL will be:

```text
https://marketplace.digitalocean.com/apps/codesteward
```

Point the root README button at that URL and drop the Docker intermediate step.
