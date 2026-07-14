# STEWARD.md — CodeSteward Review dogfood policy

This repository dogfoods CodeSteward Review. Policy is loaded from the
**base branch only** (not PR head) so authors cannot relax gates.

## Severity

- Floor: **low**
- Max findings: **40**

## Noise

- Nit cap: **3**

Prefer high-signal correctness and security findings over style.

## Skip

- `**/node_modules/**`
- `**/dist/**`
- `**/research/source/**`
- `**/*.lock`
- `**/pnpm-lock.yaml`

## Verification

- Bar: **full**

## Focus

- Multi-agent orchestration correctness
- Graph client multi-tenant scoping
- Policy base-branch loading
- Sandbox isolation boundaries

## Prove

- On severity: **critical**

## Graph

- Prefer graph-backed referential checks for security paths
