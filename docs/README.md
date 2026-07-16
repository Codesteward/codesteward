# Codesteward Review documentation

Public product & operator handbook (Docusaurus). Top-level monorepo package.

**Audience:** teams evaluating self-host install (no SaaS today) and operators running production.

## Develop

```bash
# from monorepo root
pnpm dev:docs      # http://localhost:3000
pnpm build:docs    # → docs/build
```

```bash
cd docs && pnpm start && pnpm build
npx wrangler deploy   # Cloudflare Workers (wrangler.toml → ./build)
```

## Information architecture

| Section | Contents |
|---------|----------|
| **Introduction** | Value prop, dual mode, self-host framing |
| **Concepts** | Why Codesteward, Gate vs Steward, architecture, findings |
| **Getting started** | Prerequisites, Compose quickstart, first review |
| **Install** | Overview, Compose, Helm, local monorepo dev |
| **Configure** | Keycloak, models, policy, queue, SCM connectors |
| **Product** | UI overview + full screenshot guide |
| **Pipeline** | Agent stages (deep technical) |
| **Integrations** | CLI, GitHub Action, webhooks |
| **Platform ops** | Multi-tenant workers, scaling, platform ops UI |
| **Security** | Overview + session audit |
| **Reference** | Env vars, glossary, FAQ |

Theme tokens match `packages/ui` (dark surfaces, brand purple `#7c5cfc`, DM Sans).
