---
name: steward-security
description: Security-focused CodeSteward review — SAST adapters, secrets, auth-guard graph checks.
version: 0.1.0
---

# Steward Security Skill

Use for security-tier reviews, secret scanning, and auth-path analysis.

## Prerequisites

- Optional binaries on PATH: `semgrep`, `gitleaks` (orchestrator runs them early when present)
- `STEW_SAST=0` disables adapters
- Models: strong model preferred for security specialist (`MODEL_NAME` / role routing)

## Commands

```bash
# Security-tier gate
pnpm stew -- review -p . -r <repoId> --tier security

# Thorough + discourse
pnpm stew -- review -p . -r <repoId> --tier thorough --depth thorough

# Pre-commit lite guard (attestation)
pnpm stew -- guard install -p .
```

## Review focus

1. Run SAST adapters (semgrep / gitleaks) — findings tagged `sast`.
2. Graph: auth guards on routes (`codebase_graph_query` referential).
3. Specialist role `security` + judge severity floor.
4. Prove tier on critical findings when sandbox available (`STEW_SANDBOX_PROVIDER=local|docker`).
5. Publish includes `STW-REVIEWED` trailers for audit.

## Env

| Var | Effect |
|-----|--------|
| `STEW_SAST` | Set `0` to skip |
| `STEW_SANDBOX_PROVIDER` | `local`/`docker`/`k8s`/`null` |
| `GITHUB_TOKEN` / `GITLAB_TOKEN` | SCM publish + webhooks |
