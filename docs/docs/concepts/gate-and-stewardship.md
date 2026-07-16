---
sidebar_position: 2
title: "Gate vs stewardship"
description: "Dual-mode reviews on one finding model."
---

# Gate vs stewardship

Codesteward is **one platform** with two review modes. Same specialists, policy, graph, and learning — different triggers and scopes.

## Gate (PR merge check)

- Triggered by PR/MR webhooks, UI **Gate**, CLI, or GitHub Action  
- Plans **units** from the changed paths (diff packing)  
- Publishes **inline comments**, a **check run**, and optional **SARIF** to GitHub Code Scanning  
- Ends with a **verdict** (pass / fail based on severity floors and policy)  

Best for: every merge into protected branches.

## Stewardship (branch / path audit)

- Triggered from UI **Steward**, CLI `stew steward`, or scheduled jobs you wire  
- Scopes by **path**, package, or whole tree — not only a PR diff  
- Produces **durable findings** you track over time (status, reactions, reopen)  

Best for: long-lived service branches, migrations, security sweeps, legacy packages.

## Shared foundations

- **Policy:** `STEWARD.md` + `.codesteward/rules` from the **base / default** branch  
- **Findings:** one schema, fingerprinting, lifecycle  
- **Learning:** 👍/👎 and dismissals feed the next run  
- **Graph:** rebuild/query scoped to the org and session  

See the [UI guide](../product/ui-guide) for how both modes appear in the product, and [How a review works](../pipeline/overview) for the agent stages.
