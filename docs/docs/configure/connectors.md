---
sidebar_position: 5
title: "SCM connectors"
description: "GitHub App, multi-SCM, and webhooks."
---

# SCM connectors

## GitHub (recommended)

- Prefer a **GitHub App** (org connector or platform-enforced shared App)  
- Webhook URL: `https://<public-api>/v1/webhooks/github`  
- Events: `pull_request` (opened / synchronize / reopened / ready_for_review)  
- Mention trigger on comments: default **`@codesteward review`** (`STEW_MENTION_TOKEN`)  

Permissions typically needed: contents read, pull requests write, checks write, and `security_events` write for SARIF → Code Scanning.

## Other SCM

Org connectors support **GitLab**, **Bitbucket**, **Azure DevOps**, and **Gitea** with appropriate tokens. Capability parity varies by provider for webhooks and publish.

## Platform-enforced GitHub App

Platform operators can enforce a **shared** GitHub App so tenants install the same App instead of pasting private App credentials. See Platform settings in the UI.

UI: [Connectors](../product/ui-guide#10-connectors)
