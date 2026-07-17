# GCP — Deploy to Google Cloud

## Cloud Shell button

Opens the repo in Cloud Shell with this tutorial:

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/Codesteward/codesteward&cloudshell_git_branch=main&cloudshell_working_dir=deploy/cloud/gcp&cloudshell_tutorial=tutorial.md)

Direct link:

```text
https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/Codesteward/codesteward&cloudshell_git_branch=main&cloudshell_working_dir=deploy/cloud/gcp&cloudshell_tutorial=tutorial.md
```

## CLI

```bash
export PROJECT_ID=your-gcp-project
# optional: DOMAIN=steward.example.com ACME_EMAIL=you@example.com
bash deploy/cloud/gcp/deploy.sh
```

## What gets created

| Resource | Purpose |
|----------|---------|
| GCE VM `codesteward-cloud` | Ubuntu 24.04, Docker Compose stack |
| Firewall `codesteward-http` | tcp/80, tcp/443 |
| Startup script | Clones repo + `first-boot.sh` |

No LLM API key is required at deploy time.
