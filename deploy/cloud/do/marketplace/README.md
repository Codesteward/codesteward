# DigitalOcean Marketplace — 1-Click App (vendor, not live)

**Status:** packaging notes only. There is **no public Codesteward Marketplace listing** yet.  
End users should use [`../deploy.sh`](../deploy.sh) or [`../cloud-init.yaml`](../cloud-init.yaml).

This directory describes how to publish **Codesteward** as a Droplet 1-Click App later.
End users would create a Droplet from Marketplace; first boot runs the shared cloud stack
(Keycloak + nginx edge + Compose). **No LLM key at install.**

## Architecture

```text
Marketplace image (Ubuntu LTS)
  ├── Docker Engine + Compose plugin
  ├── /opt/codesteward/          # release snapshot of this repo (or sparse deploy/cloud)
  ├── /var/lib/cloud/scripts/per-instance/99-codesteward.sh  → first-boot.sh
  └── cloud-init / fabricator hooks
```

## Image build (vendor)

1. Start from Ubuntu 24.04 snapshot or Packer.
2. Install Docker (official convenience script or apt repo).
3. Copy monorepo `deploy/cloud` (+ compose realm base) to `/opt/codesteward/deploy/cloud`.
   Prefer baking a full shallow clone at `/opt/codesteward` pinned to a release tag.
4. Install per-instance script (see `per-instance.sh`).
5. Clean machine-id, SSH host keys, logs (DO Marketplace image guidelines).
6. Snapshot → submit via [DigitalOcean Vendor Portal](https://marketplace.digitalocean.com/).

## User-data parameters (optional)

Document for Marketplace listing:

| Key | Required | Description |
|-----|----------|-------------|
| `domain` | No | Enables Let's Encrypt when DNS points at droplet |
| `acme_email` | If domain | LE registration email |

## Listing copy (draft)

- **Name:** Codesteward Review  
- **Summary:** Agentic code review with structural graph — PR gate + stewardship, self-hosted with Keycloak.  
- **Min size:** 4 GB RAM (8 GB recommended)  
- **Ports:** 80, 443  
- **Post-create:** Open UI on droplet IP; credentials in `/var/lib/codesteward/credentials.txt`; configure models in Settings → Models.

## Validation checklist

- [ ] Fresh droplet boots to healthy `docker compose ps`
- [ ] Keycloak login works on `https://$IP/auth/` (or HTTP redirect)
- [ ] UI loads; no LLM key required until Models UI
- [ ] Optional domain + TLS path works
- [ ] Security: no default weak secrets reused across droplets (first-boot regenerates)
