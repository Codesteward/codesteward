---
sidebar_position: 1
title: "CLI (stew)"
description: "Doctor, review, steward, findings export."
---

# CLI (`stew`)

```bash
pnpm stew -- doctor full
pnpm stew -- review -p . -r codesteward --tier thorough --depth thorough
pnpm stew -- steward -p . -r codesteward
pnpm stew -- resume <sessionId>
pnpm stew -- findings export --sarif -s <sessionId>
pnpm stew -- config doctor
pnpm stew -- ask "What does a review unit cover?"
```

Use the CLI for CI agents, local dogfood without the UI, and SARIF export automation. The same orchestrator path runs as the worker when jobs are enqueued to a shared API/DB.
