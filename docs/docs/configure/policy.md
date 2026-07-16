---
sidebar_position: 3
title: "Policy (STEWARD.md)"
description: "Severity floors, skip globs, and path rules from the base branch."
---

# Policy (`STEWARD.md`)

Policy is how you tell Codesteward **what good looks like** for your repo.

## Sources

1. **`STEWARD.md`** on the **base / default branch**  
2. **`.codesteward/rules/**/*.md`** path-scoped guidance  
3. **Org policy editor** in the UI (org defaults; base branch still applies for PR authors)  

:::warning Base branch only
Gates load policy from the **base** branch so a PR cannot relax severity floors by editing rules only on the head branch.
:::

## Typical knobs

- Severity floor / fail-on threshold  
- Nit cap  
- Skip globs (generated code, vendor)  
- Verification bar / focus areas  

UI: [Policy editor](../product/ui-guide#14-policy-stewardmd)
