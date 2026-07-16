---
sidebar_position: 2
title: "GitHub Action"
description: "PR gate in CI with check runs and SARIF."
---

# GitHub Action

Path: `actions/review-action` in the monorepo.

```yaml
permissions:
  contents: read
  pull-requests: write
  checks: write
  security-events: write   # Code Scanning SARIF

- uses: ./actions/review-action
  with:
    risk-tier: full
    publish: "true"
    fail-on: high
    sarif-output: codesteward.sarif
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    STEW_PUBLISH_SARIF: "1"

- uses: github/codeql-action/upload-sarif@v4
  if: always()
  with:
    sarif_file: codesteward.sarif
    category: codesteward/gate
```

**Checks tab** shows `codesteward/gate`. **Security → Code scanning** is separate and needs code scanning enabled on the repo plus `security_events: write`.
