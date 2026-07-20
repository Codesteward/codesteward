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
| 👍 on a finding | **Positive** preference memory — reinforce similar high-signal issues |
| 👎 on a finding | **Negative** memory + fingerprint suppress on next runs |
| Mark false positive / won’t fix | Suppress or de-prioritize next runs |
| Scoped memories | Org-wide, repo, or PR |

Learning is injected into specialist context and post-judge **noise** filtering (including a lightweight embedding preference filter) so the product gets quieter as your team reacts.

## Automatic / indirect eval (merge outcomes)

When a PR **merges**, Codesteward enqueues a lightweight `pr_outcome` job (not a full agent re-review):

| Outcome | Meaning |
|---------|---------|
| **Accepted / fixed** | Suggestion likely applied or finding path changed at merge |
| **Unaddressed at merge** | Still open and path untouched — soft ignore signal |
| **False positive / dismissed** | Human rejected the finding |
| **Agent-miss candidate** | Sensitive path changed with **no** prior finding |
| **Gate regret** | Approve with critical open, or block with only noise |

Snapshots land in `pr_outcomes` / `finding_outcomes` (Postgres or `.steward-data/outcomes.json`).

### Self-improvement: outcome → memory (scoped)

History is **not** always written as org learning. A consolidator promotes only when patterns are **common**, and chooses **scope**:

| Evidence | Memory scope |
|----------|----------------|
| Same fingerprint/path often in **one** repo only | **repo** |
| Same signal across **≥2 repos** | **org** |
| **Important** (critical/high severity, gate regret, very high confidence) even in one repo | **org** (elevated) |

Thresholds default to ~3 outcomes / 90 days (important elevation uses a lower bar). Source is `outcome_aggregate` so you can audit/delete on **Learnings**.

Runs automatically after each merge outcome job, or manually:

`POST /v1/analytics/outcomes/consolidate`

**KPIs** (prefer these over a mixed “address rate”):

- **fixAcceptRate** = fixed \| auto-fixed \| 👍  
- **noiseRate** = false_positive \| 👎 \| dismissed \| wontfix  
- **openRate** = still active  

APIs: `GET /v1/analytics/address-rate`, `GET /v1/analytics/outcomes`, `POST .../consolidate`, `GET .../eval-export`  
Offline: `node packages/evals/src/run-eval.mjs packages/evals/fixtures/sample-outcomes.json`

## Policy interaction

Policy (`STEWARD.md`) sets severity floors, nit caps, and skip globs. Learning does **not** let PR authors weaken base-branch policy — it steers specialist attention and noise, not security floors.

UI: [Findings](../product/ui-guide#5-findings) · [Learnings](../product/ui-guide#9-learnings)
