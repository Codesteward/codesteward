# Category leader demo script (K21)

Run on stock Compose with Keycloak + live graph (not GRAPH_MOCK).

## Prerequisites
```bash
# Secrets
export STEW_AUTH_STRICT=1
export STEW_SECRETS_KEY=$(openssl rand -hex 32)
export STEW_API_KEY=$(openssl rand -hex 16)
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 16)
export GRAPH_MOCK=0
export STEW_PUBLIC_URL=http://localhost:8080
export OIDC_ISSUER=http://localhost:8083/realms/codesteward
export OIDC_CLIENT_ID=codesteward-ui
export OIDC_REDIRECT_URI=http://localhost:8081/v1/auth/oidc/callback

pnpm install && pnpm -r run build
pnpm compose:keycloak   # Keycloak :8083
# Start graph MCP (GraphQLite/Neo4j) per README
GRAPH_MOCK=0 pnpm dev:api
pnpm dev:ui
```

## Binary steps (all required)
1. [ ] Open UI → bootstrap or SSO (OIDC ready)
2. [ ] Create org / switch org
3. [ ] Connectors → **Install GitHub App** (not PAT first)
4. [ ] Setup callback binds installation
5. [ ] Gate a PR → findings with severity + graph evidence drawer
6. [ ] 👎 a finding → appears in Learnings
7. [ ] Steward a branch/ref without PR
8. [ ] Analytics address-rate real or honest empty
9. [ ] Viewer cannot open connectors (RBAC)
10. [ ] Thorough session shows discourse transcript
11. [ ] Resume a killed session
12. [ ] Export SARIF

If any step needs PEM archaeology, GRAPH_MOCK=1, or global session leak → **still second group**.
