---
sidebar_position: 3
title: "Webhooks & mentions"
description: "Automatic gates on PR events and comment triggers."
---

# Webhooks & mentions

## GitHub App webhook

```text
https://<public-api-host>/v1/webhooks/github
```

Handled events include pull request lifecycle (opened, synchronize, reopened, ready_for_review) and `issue_comment` for mentions.

## Mention trigger

On a PR comment:

```text
@codesteward review
```

Override the token with `STEW_MENTION_TOKEN` if you need a different bot mention.

Ensure the API is reachable from GitHub (ingress, TLS, webhook secret).
