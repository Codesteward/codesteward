---
sidebar_position: 4
title: "Findings & learning"
description: "Durable issues, confidence, reactions, and quieter next reviews."
---

# Findings & learning

## Findings

A **finding** is a durable issue Codesteward believes is worth tracking:

- Severity, confidence, path/line, category  
- Optional **suggested fix** and specialist **reasoning**  
- Fingerprint for lifecycle (auto-fix / reopen when code changes)  
- Export as **SARIF** for GHAS / other tools  

Findings appear in the session blade, the **Findings** backlog, PR comments (gate), and reports.

## Learning

Humans teach the system without rewriting prompts every time:

| Action | Effect |
|--------|--------|
| 👍 / 👎 on a finding | Org memory bias for similar patterns |
| Mark false positive / won’t fix | Suppress or de-prioritize next runs |
| Scoped memories | Org-wide, repo, or PR |

Learning is injected into specialist context and post-judge **noise** filtering so the product gets quieter as your team reacts.

## Policy interaction

Policy (`STEWARD.md`) sets severity floors, nit caps, and skip globs. Learning does **not** let PR authors weaken base-branch policy — it steers specialist attention and noise, not security floors.

UI: [Findings](../product/ui-guide#5-findings) · [Learnings](../product/ui-guide#9-learnings)
