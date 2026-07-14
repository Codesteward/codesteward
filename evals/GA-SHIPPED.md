# CodeSteward Review — Functional GA ship record

**Date:** 2026-07-12  
**Status:** **Functional GA (self-hosted)** against research design matrix  
**Design source of truth:** `research/design/05-full-product-architecture.md` §16 + `research/spa/index.html`

## Gate (required)

| Check | Result |
|-------|--------|
| `node scripts/ga-acceptance.mjs` | **PASS_GA_FUNCTIONAL** — static 47/47, runtime 6/6 |
| Architect final | **PASS** — `evals/architect-ga-final.md` |
| Validator final | **PASS** — `evals/validator-ga-final.md` |

### Confirmations

**Architect:**  
> I confirm functional GA is shipped for the self-hosted CodeSteward Review product against the research design matrix (enterprise SSO remains optional).

**Validator:**  
> Double-check confirmation: functional GA acceptance PASS against research design matrix.

## What “functional GA” means here

Coverage of the **designed** product matrix (dual-mode Gate + Stewardship, graph backends, DeepAgents, multi-SCM, self-heal, discourse, learning, connectors config, login/RBAC, Prove/SAST paths, CLI, Action, skills, Compose/Helm, analytics, etc.) with **runtime proof** that:

1. Admin can bootstrap + login  
2. Stewardship review starts and **completes** via inline worker  
3. Connectors can be configured  
4. Unauthenticated access is rejected after users exist  

## Optional (not required by design honesty note)

- Full enterprise SSO/OIDC/SAML IdP integration  
- Multi-cluster load-lab proof of 50+ concurrency  

## Re-run the gate anytime

```bash
pnpm -r run build && pnpm test
node scripts/ga-acceptance.mjs
```

## Run product

```bash
export GRAPH_MOCK=1 STEW_USE_DEEPAGENTS=0
pnpm -r run build
pnpm dev:api    # inline worker ON
pnpm dev:ui     # :8080 — /login bootstrap, then Sessions / Connectors / Diff
```
