# Enterprise gap register — CodeSteward Review

**Updated:** 2026-07-14 (wave 2)

## Shipped

| Capability | Notes |
|------------|--------|
| Session Audit + UI Review audit | Provenance, specialists, zero-findings |
| Workspace prepare / optional clone | `STEW_WORKSPACE_CLONE=1` |
| **GitHub Check Runs** | `codesteward/gate` in_progress → completed |
| **Policy gate** | `blockSeverities`, `gateMode` enforce\|advisory, STEWARD.md parse |
| **Graph required** | Thorough/security fails if graph degraded + requireGraph |
| **Webhook product org** | `resolveProductOrgId` from installation map (not SCM owner login) |
| **Admin audit log** | `GET /v1/org/audit` + NDJSON + Settings UI |
| **Sandbox hardening** | Docker `--network none`, cap-drop, no host env secrets |
| **Workspace GC** | Delete clone dir after job unless `STEW_WORKSPACE_KEEP=1` |

### STEWARD.md gate section example

```markdown
## Merge gate
- Mode: enforce
- Block: critical, high
```

### Branch protection

Require status check: **codesteward/gate** (GitHub App needs `checks:write`).

## Remaining P0 / P1

- Secrets KMS/Vault backend (fail-closed prod key)
- Scoped service API keys (not global STEW_API_KEY admin)
- Retention / legal hold purge API
- SAML/SCIM
- Check Runs parity for GitLab/ADO
- GIT_ASKPASS clone (no token in argv) when clone re-enabled by default
- Full OTel OTLP exporters

## Env cheat sheet

| Env | Purpose |
|-----|---------|
| `STEW_CHECK_NAME` | Check run name (default `codesteward/gate`) |
| `STEW_REQUIRE_GRAPH=1` | Always require graph |
| `STEW_WORKSPACE_CLONE=1` | Clone selected repo |
| `STEW_SANDBOX_NETWORK` | `none` (default) \| `bridge` |
| `STEW_SCM_ORG_MAP` | `github-org:productOrgId,...` |
| `DEFAULT_ORG_ID` | Fallback product org for webhooks |
