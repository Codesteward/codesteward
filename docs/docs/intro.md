---
sidebar_position: 1
title: "Codesteward Review"
sidebar_label: "Introduction"
description: "Self-hosted agentic code review that knows your graph. Gate merges, steward branches."
slug: /
---

# Codesteward Review

**Agentic code review that knows your graph.**  
Gate every merge. Steward every branch. **Self-hosted** — your cloud, your models, your keys.

:::info Self-hosted only
Codesteward Review is distributed under **Apache-2.0** for self-host installs. There is **no hosted SaaS** product today — this documentation is for teams evaluating and operating their own deployment.
:::

Most AI review tools skim a diff and guess. Codesteward runs **multi-agent** reviews against a **structural code graph** (call chains, dependencies, auth paths) so findings are grounded in how the codebase actually works — not only the patch text.

<div className="row margin-top--lg margin-bottom--lg">
  <div className="col col--4">
    <h3>For engineering leaders</h3>
    <p>Consistent merge gates, durable findings, policy from the base branch, and an audit trail you can show compliance.</p>
  </div>
  <div className="col col--4">
    <h3>For platform / DevOps</h3>
    <p>Compose demo in minutes, Helm for production, Keycloak OIDC, horizontal workers, optional KEDA queue scaling.</p>
  </div>
  <div className="col col--4">
    <h3>For developers</h3>
    <p>PR comments and check runs that cite structure, not noise — plus a product UI for sessions, findings, and learnings.</p>
  </div>
</div>

## Two review modes, one platform

| | **Gate** | **Stewardship** |
|--|----------|-----------------|
| **When** | PR / MR open, push, or `@codesteward review` | Long-lived branches and path scopes |
| **Scope** | Diff-focused units | Package / path / tree batches |
| **Output** | Inline review, check run, gate verdict | Durable findings lifecycle |
| **Policy** | `STEWARD.md` + path rules from **base** branch | Same model |

## What you get

- **Graph-aware specialists** — correctness, security, testing, rules, and more, with optional thorough discourse  
- **Product UI** — sessions, findings, reports, connectors, models, org settings, platform ops  
- **CLI + GitHub Action** — same pipeline outside the browser  
- **Learning loop** — 👍/👎 and dismissals become quieter next reviews  
- **Multi-SCM** — GitHub App, GitLab, Bitbucket, Azure DevOps, Gitea  
- **Multi-org ready** — Keycloak groups, RBAC, optional SCIM; worker isolation for shared hosts  

## Decide in three steps

1. **[Why Codesteward](./concepts/why-codesteward)** — when graph-aware review is worth running yourself  
2. **[Quick start](./getting-started/quickstart)** — category Compose stack on your laptop  
3. **[Kubernetes quick start](./getting-started/kubernetes)** or **[Install overview](./install/overview)** — Helm / Compose, Postgres, Keycloak, workers  

Then explore the [UI guide](./product/ui-guide) and [review pipeline](./pipeline/overview) when you want depth.

## License & cost model

- **Software:** Apache-2.0 (see repository `LICENSE`)  
- **Your cost:** infrastructure + **LLM API usage** (OpenAI, Anthropic, SpaceXAI, OpenAI-compatible, LiteLLM, …)  
- **Not included:** managed multi-tenant SaaS, hosted billing portal for end customers  

Ready to try? → **[Quick start](./getting-started/quickstart)**
