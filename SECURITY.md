# Security Policy

## Supported Versions

Only the latest released version of Codesteward Review is supported with security
updates. Patches ship as point releases.

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| older   | No        |

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Codesteward Review,
**do not open a public GitHub issue**. Report it privately via:

- **GitHub Security Advisories** (preferred):
  https://github.com/Codesteward/codesteward/security/advisories/new
- **Email**: security@bitkaio.com

Please include:

- Description of the vulnerability and potential impact
- Steps to reproduce (minimal PoC when possible)
- Affected version(s) or commit
- Optional credit name/handle

## Response targets

| Severity | Acknowledgement | Fix target         |
| -------- | --------------- | ------------------ |
| Critical | within 48 hours | 7 days             |
| High     | within 7 days   | 30 days            |
| Medium   | within 14 days  | next minor release |
| Low      | best effort     | next minor release |

## Disclosure

We follow coordinated disclosure: private report → confirmation and fix →
patched release → public advisory after operators have had time to upgrade
(typically 7–14 days).

## Scope

In scope:

- Packages under `packages/*` and `services/*`
- Published container images and Helm charts for this product
- GitHub Actions workflows and the review GitHub Action in this repository
- The product API, worker, CLI, MCP server, and UI

Out of scope:

- Third-party LLM providers and SCM hosts you connect
- Misconfiguration of self-hosted deployments (e.g. running without auth in production)
- Vulnerabilities only present in `research/` vendored snapshots

## Hardening notes for self-hosters

- Set `STEW_API_KEY` / user auth and never expose the API without authentication in production
- Prefer `STEW_SECRETS_KEY` (32-byte hex or base64) for at-rest connector encryption
- Restrict SCM tokens to least privilege; use GitHub App installation tokens when possible
- Keep Node ≥ 22 and dependencies current (`pnpm audit` / Dependabot)
