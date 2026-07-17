# Codesteward cloud trial deploys

One shared stack — **Docker Compose + Traefik + Keycloak (OIDC) + API + worker + UI + Postgres** — launched on a single VM.

| | |
|--|--|
| **Kubernetes** | Not required |
| **LLM API key at install** | **No** — configure in UI → Settings → Models |
| **Identity** | Keycloak (mandatory) |
| **TLS** | Optional domain → Traefik + Let's Encrypt; otherwise HTTP on public IP |

```text
deploy/cloud/
  first-boot.sh          # root: install Docker, secrets, realm, compose up
  VERSION                # default image tag (1.2.0)
  compose/               # stack definition + TLS overlay
  aws/                   # CloudFormation Launch Stack
  azure/                 # Bicep + ARM Deploy to Azure
  gcp/                   # Deploy to Google Cloud (Cloud Shell + gcloud)
  do/                    # DigitalOcean Marketplace 1-Click (vendor)
```

## Deploy (pick a cloud)

Requires a **paid cloud account** on the provider you choose. Resources bill to that account.

<p align="center">
  <a href="https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=https://raw.githubusercontent.com/Codesteward/codesteward/main/deploy/cloud/aws/cloudformation.yaml&stackName=codesteward">
    <img src="../../docs/static/img/readme/deploy/aws.png" alt="Launch on AWS" width="200" height="35" />
  </a>
  &nbsp;&nbsp;
  <a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FCodesteward%2Fcodesteward%2Fmain%2Fdeploy%2Fcloud%2Fazure%2Fazuredeploy.json">
    <img src="../../docs/static/img/readme/deploy/azure.png" alt="Deploy to Azure" width="200" height="35" />
  </a>
</p>
<p align="center">
  <a href="https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/Codesteward/codesteward&cloudshell_git_branch=main&cloudshell_working_dir=deploy/cloud/gcp&cloudshell_tutorial=tutorial.md">
    <img src="../../docs/static/img/readme/deploy/gcp.png" alt="Open in Google Cloud Shell" width="200" height="35" />
  </a>
  &nbsp;&nbsp;
  <a href="https://marketplace.digitalocean.com/apps/docker">
    <img src="../../docs/static/img/readme/deploy/digitalocean.png" alt="1-Click on DigitalOcean" width="200" height="35" />
  </a>
</p>

| Docs | |
|------|--|
| [AWS](aws/README.md) | CloudFormation Launch Stack |
| [Azure](azure/README.md) | Bicep / ARM portal deploy |
| [GCP](gcp/README.md) | Cloud Shell tutorial + `deploy.sh` |
| [DigitalOcean](do/README.md) | Button → [Docker 1-Click](https://marketplace.digitalocean.com/apps/docker), then `first-boot.sh` (native Codesteward listing later) |

> Button targets use `raw.githubusercontent.com/.../main/...`. Until merged to `main`, clone this branch and run the provider template / `first-boot.sh` manually.

## Recommended VM size

| | Minimum | Comfortable |
|--|---------|-------------|
| RAM | 4 GB | **8 GB** |
| Disk | 20 GB | **40 GB** |
| vCPU | 2 | 2–4 |

## Optional domain (TLS)

1. Create the stack **without** a domain first (HTTP on public IP), **or** pass `Domain` / `DOMAIN` at create time.
2. Point **A/AAAA** at the instance public IP.
3. Set `DOMAIN` + `ACME_EMAIL` and re-run first-boot with `FORCE_BOOT=1`, or pass domain on first create so Traefik requests Let's Encrypt immediately.

Without a domain, Traefik listens on **:80** only. You do **not** need a domain to try the product.

## After boot

1. Wait 5–10 minutes (image pull + Keycloak import).
2. Read credentials:

   ```bash
   sudo cat /var/lib/codesteward/credentials.txt
   ```

3. Open the UI URL → Keycloak login (seeded demo user is listed in credentials).
4. **Settings → Models** — add OpenAI / SpaceXAI / etc.
5. Run a review.

## Manual smoke (any Ubuntu VM)

```bash
sudo bash -c '
  export IMAGE_TAG=1.2.0
  # export DOMAIN=steward.example.com ACME_EMAIL=you@example.com
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
| Traefik | `traefik:v3.3` |
| Postgres | `postgres:16-alpine` |

GHCR packages must be **public** (or the VM authenticated) for pull-on-boot.

## Security notes (trial)

- Secrets are **generated per instance** (DB, Keycloak admin, `STEW_SECRETS_KEY`).
- Restrict `AllowedCIDR` / firewall to your IP when possible.
- Change demo Keycloak users before exposing to a team.
- This is a **single-node** trial, not HA production (use Helm for that).
