---
sidebar_position: 1
title: "Why Codesteward"
description: "When self-hosted, graph-aware agentic review is the right tool."
---

# Why Codesteward

## The problem with diff-only AI review

A patch is a **local** signal. Real defects often hide in:

- Call chains that leave the changed files  
- Auth / tenancy guards defined elsewhere  
- Shared libraries and cross-repo contracts  
- Policy rules authors forget under deadline pressure  

Tools that only summarize a PR miss structural risk. Codesteward pairs **LLM specialists** with **Codesteward Graph** so agents can ask: *who calls this?*, *what guards this route?*, *what depends on this module?*

## Who it is for

| Fit | Why |
|-----|-----|
| **Regulated / private code** | Self-host: source, models, and identity stay in your perimeter |
| **Multi-repo platforms** | Cross-repo fan-out and graph context across linked systems |
| **Platform engineering** | You already run Postgres, IdP, and CI — this slots into that world |
| **Quality-focused orgs** | Durable findings, learning suppressions, SARIF / Security tab |

## Who it is *not* for (yet)

- Teams that want a **hosted SaaS** “sign up and review” product — that is not offered  
- Zero-ops environments with no place to run containers or Kubernetes  
- Orgs that refuse any LLM vendor and have no private model endpoint  

## Compared to alternatives

| Approach | Tradeoff |
|----------|----------|
| **Human-only review** | High quality, low scale; no structural graph assist |
| **Diff-only AI bots** | Fast noise risk; weak multi-file / multi-repo reasoning |
| **Static analysis alone** | Precise patterns, limited product intent / design smell coverage |
| **Codesteward** | Graph + multi-agent + policy + learning; you operate the stack |

## Design principles

1. **Postgres is source of truth** for jobs, sessions, findings — not an ephemeral queue  
2. **Policy from the base branch** — PR authors cannot relax gates by editing head-only rules  
3. **Identity via Keycloak** (recommended) — MFA and federated SSO stay in the IdP  
4. **Workers scale horizontally** — API/UI stay stateless  
5. **Open license** — Apache-2.0 for the review product  

Next: [Gate vs stewardship](./gate-and-stewardship) · [Quick start](../getting-started/quickstart)
