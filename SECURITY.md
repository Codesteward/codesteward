# Security Policy

## Supported Versions

Only the latest released version of Codesteward is supported with security
updates. Patches are issued as point releases (e.g. a fix for a `0.3.x` issue
ships as `0.3.x+1`).

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| older   | No        |

## Reporting a Vulnerability

If you believe you've found a security vulnerability in Codesteward, please
**do not open a public GitHub issue**. Instead, report it privately via one of
the following channels:

- **GitHub Security Advisories**
  (preferred): <https://github.com/Codesteward/codesteward/security/advisories/new>
- **Email**: `security@bitkaio.com`

Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal proof-of-concept where possible)
- The affected version(s)
- Your name/handle for credit (optional)

## Response SLA

| Severity | Acknowledgement | Fix target         |
| -------- | --------------- | ------------------ |
| Critical | within 48 hours | 7 days             |
| High     | within 7 days   | 30 days            |
| Medium   | within 14 days  | next minor release |
| Low      | best effort     | next minor release |

## Disclosure Policy

We follow **coordinated disclosure**:

1. Reporter privately discloses the issue to the maintainers.
2. Maintainers confirm, assess impact, and develop a fix.
3. A patched release is published.
4. A security advisory is published after patched users have had time to
   upgrade (typically 7–14 days post-release).
5. Credit is given to the reporter unless they prefer to remain anonymous.

## Scope

In scope:

- The `codesteward-graph` and `codesteward-mcp` Python packages
- The published `ghcr.io/Codesteward/codesteward` container images
- GitHub Actions workflows in this repository

Out of scope:

- Issues in third-party dependencies that we don't bundle (report upstream)
- Denial of service from untrusted local input to the parser
  (the parser trusts local repo contents by design)
- Vulnerabilities in development-only dev tooling
