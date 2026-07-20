# DigitalOcean — Codesteward trial VM

Deploys the **same** single-VM stack as AWS/Azure/GCP:

**nginx edge (HTTPS) · Keycloak · API · worker · UI · Postgres**

There is **no Codesteward listing on DigitalOcean Marketplace yet**.  
The generic [Docker Marketplace app](https://marketplace.digitalocean.com/apps/docker) only installs Docker — **it does not install Codesteward**.

| Path | Role |
|------|------|
| [`deploy.sh`](deploy.sh) | **Recommended** — `doctl` creates Ubuntu Droplet + user-data → `first-boot.sh` |
| [`cloud-init.yaml`](cloud-init.yaml) | Manual user-data for the control panel |
| [`marketplace/`](marketplace/) | **Vendor** notes for a future native 1-Click listing (not live) |
| Shared stack | [`../first-boot.sh`](../first-boot.sh) + [`../compose/`](../compose/) |

## Recommended: `doctl` (installs the product)

1. Install and auth [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) (`doctl auth init`).
2. Prefer a Droplet size with **≥ 4 GB RAM** (`s-2vcpu-4gb` or larger).
3. From a clone of this repo (or curl the script):

```bash
cd deploy/cloud/do
export IMAGE_TAG=1.3.0   # product image tag
# optional: export DOMAIN=steward.example.com ACME_EMAIL=you@example.com
# optional: export REGION=nyc3 SIZE=s-2vcpu-4gb DROPLET_NAME=codesteward
bash ./deploy.sh
```

4. Wait **5–15 minutes**, then:

```bash
doctl compute ssh codesteward --ssh-command 'sudo cat /var/lib/codesteward/credentials.txt'
```

5. Open the printed **https://** UI URL → accept the self-signed cert → Keycloak login → **Settings → Models**.

`deploy.sh` generates user-data that clones this repository and runs `deploy/cloud/first-boot.sh` (Docker Engine, secrets, compose stack). It is not the Docker Marketplace image.

### One-liner (from anywhere with doctl)

```bash
git clone --depth 1 https://github.com/Codesteward/codesteward.git /tmp/codesteward \
  && bash /tmp/codesteward/deploy/cloud/do/deploy.sh
```

## Alternative: control panel + user-data

1. [Create a Droplet](https://cloud.digitalocean.com/droplets/new) — Ubuntu 24.04, **≥ 4 GB**, public IPv4.
2. Under **Additional options → Startup scripts / User data**, paste the contents of [`cloud-init.yaml`](cloud-init.yaml)  
   (or use the generated block from `deploy.sh`).
3. Create the Droplet and wait for first-boot, then SSH:

```bash
sudo cat /var/lib/codesteward/credentials.txt
# debug: sudo tail -f /var/log/cloud-init-output.log
```

## Future: native Marketplace 1-Click

When a Codesteward Droplet app is published, the listing URL will be:

```text
https://marketplace.digitalocean.com/apps/codesteward
```

Until then, use **`deploy.sh`** or user-data above. See [`marketplace/README.md`](marketplace/README.md) for vendor packaging notes.
