---
sidebar_position: 2
title: "Your first review"
description: "From login to findings on a real PR or branch."
---

# Your first review

## Gate a pull request

1. **Connectors** → install / configure GitHub App (or paste SCM credentials where allowed)  
2. **Models** → add a provider key and confirm stage routing has a default model  
3. **Gate** → select repository + PR number, choose risk tier, start  
4. Open the **session blade**: stage pipeline fills as workers claim the job  
5. When complete: **Evidence**, **Review report**, **Review audit**, token usage  

![Start gate](/img/screenshots/sessions-start-gate.png)

![Stage pipeline](/img/screenshots/session-blade-stage-pipeline.png)

If the session stays `queued`, check that a **worker** is running and `DATABASE_URL` is shared between API and worker.

## Steward a branch

1. **Steward** → repository + base branch/path (no PR field by design)  
2. Scope paths (`.` for whole tree on small repos; narrower paths on large monorepos)  
3. Review durable findings on **Findings** after the run  

## React and learn

On a finding, use 👍/👎 or mark false positive. Those signals become **Learnings** for the next review — the fastest way to reduce noise for your org.

## Export

- Session **Download audit JSON** (provenance)  
- Findings **SARIF** export  
- Optional automatic SARIF publish to GitHub Code Scanning when configured  

Continue: [UI guide](../product/ui-guide) · [Pipeline](../pipeline/overview)
