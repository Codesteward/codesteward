# Codesteward documentation

Product and operator docs for the self-hosted review platform.

| Doc | Audience | Description |
|-----|----------|-------------|
| **[UI guide](./UI_GUIDE.md)** | Operators, admins, reviewers | Visual tour of the product UI with screenshots |
| **[Review pipeline](./REVIEW_PIPELINE.md)** | Engineers | How a review job runs (units, specialists, judge, publish) |
| **[Session audit](./ENTERPRISE_SESSION_AUDIT.md)** | Compliance, platform | Provenance ledger, specialist runs, export |

Screenshots live under [`screenshots/`](./screenshots/) (kebab-case names).

Deploy / ops:

- [Helm chart](../deploy/helm/codesteward/README.md)
- [Compose stacks](../deploy/compose/)
- Root [README](../README.md) — install, CLI, architecture overview
