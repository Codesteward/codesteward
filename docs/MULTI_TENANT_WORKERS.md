# Multi-tenant worker isolation

## Threat

Workers clone SCM trees under `STEW_WORKSPACE_DIR` for each review session. On a **shared
worker host**, concurrent sessions from different organizations sit side-by-side. If an
agent tool (DeepAgents `sandbox_exec` / `sandbox_read`) can leave the session workdir —
via bug, misconfiguration, or **prompt injection** — it could read another tenant’s source.

Logical multi-tenancy (org on sessions, findings, connectors) does **not** by itself stop
host filesystem cross-reads.

## Defense layers (implemented)

| Layer | Control | Env / config |
|-------|---------|----------------|
| **A. Path layout** | Clones under `{STEW_WORKSPACE_DIR}/{orgId}/{sessionId}` | `STEW_TENANT_ISOLATION=path` (default) |
| **B. Tool jail** | `sandbox_read` + packing resolve paths only under the session tree; refuse `..` | same |
| **C. Hard sandbox** | Strict mode forces **Docker** (or k8s) so the container only bind-mounts one session | `STEW_TENANT_ISOLATION=strict` |
| **D. Worker affinity** | Workers only claim jobs for listed orgs | `STEW_WORKER_ORG_IDS=org_a,org_b` |
| **E. GC** | Delete session trees after terminal status (both nested + legacy flat) | `STEW_WORKSPACE_KEEP=0` |

### Isolation modes (`STEW_TENANT_ISOLATION`)

| Value | Behavior |
|-------|----------|
| `off` | Legacy flat `{workspace}/{sessionId}` (not recommended multi-tenant) |
| `path` (default) | Org-prefixed paths + path jail on tools/packing |
| `strict` | `path` + prefer Docker sandbox for agent tools (no host shell) |

### Org-affine workers (strongest operational split)

Run **separate worker Deployments** per tenant (or tenant tier):

```bash
# Org A pool — never claims other orgs’ jobs
STEW_WORKER_ORG_IDS=org_acme
STEW_WORKSPACE_DIR=/workspace-acme   # optional dedicated volume
STEW_TENANT_ISOLATION=strict
STEW_SANDBOX_PROVIDER=docker

# Org B pool
STEW_WORKER_ORG_IDS=org_globex
STEW_WORKSPACE_DIR=/workspace-globex
```

Jobs must carry `orgId` in the payload (API sets this from the session). Claim SQL filters:

```sql
COALESCE(payload->>'orgId', payload->>'tenantId', 'local') = ANY($worker_orgs)
```

Unset / `*` / `all` → worker claims any org (single-tenant / small installs).

### Recommended production matrix

| Scale | Recommendation |
|-------|----------------|
| Single org / dogfood | `path` + GC; Docker optional |
| Multi-org shared workers | `strict` + Docker/k8s sandbox + GC |
| Regulated multi-org | Per-org (or per-sensitivity) **worker pools** + dedicated volumes + `strict` |

## Graph MCP isolation

**Architecture (current):** Graph MCP is **embedded in each worker** via stdio (`codesteward-mcp`).
There is **no standalone graph-mcp Deployment** and **no shared clone PVC** with a graph sidecar.
Workers parse local `repo_path` under their own `STEW_WORKSPACE_DIR`.

**Shared index (recommended multi-worker):** point all workers at the same **Neo4j or JanusGraph**
with `GRAPH_BACKEND=neo4j|janusgraph`. Structure is still namespaced by **`tenant_id` = product orgId**.

| Env | Purpose |
|-----|---------|
| `GRAPH_MCP_MODE=stdio` | Spawn MCP in-process (default) |
| `GRAPH_MCP_COMMAND=codesteward-mcp` | Binary from worker image venv |
| `GRAPH_BACKEND=neo4j` | Shared durable graph |
| `NEO4J_URI` / `JANUSGRAPH_URL` | Shared backend endpoints |
| `GRAPHQLITE_PATH` | Local SQLite only (dev / single worker) |

Graph structure is keyed by **`(tenant_id, repo_id)`** in Codesteward Graph. Risks if mis-scoped:

| Risk | Mitigation (product) |
|------|----------------------|
| All orgs share `tenant_id=local` | Graph `tenant_id` = **product orgId** (`graphTenantId()`) |
| Agent `graph_query` with another `repoId` | Allow-list = primary + this session’s fan-out repos only |
| Agent `graph_rebuild` with path to another clone | `repo_path` must stay under session workspace |
| Shared GraphQLite file | Acceptable if tenant_id is org-scoped; for hard isolation run **per-org Graph MCP** + DB |

```text
Worker  ──rebuild/query──►  Graph MCP
                              tenant_id = orgId   (not global "local")
                              repo_id   = owner/repo for this review
                              repo_path = only under {workspace}/{orgId}/{sessionId}
```

**Ops:** one Graph MCP + multi-tenant backend (Neo4j/Janus with tenant_id) is normal.  
**High assurance:** dedicate Graph MCP (+ storage) per org or per sensitivity tier, like org-affine workers.

## Residual risk

- **Host-local `sandbox_exec`** can still escape path jails with creative shell if isolation is only `path` — use **`strict` + docker/k8s**.
- **Shared Graph MCP process** still sees all rebuild paths on its disk if `repo_path` were ever mis-pinned — path jail + org `tenant_id` close the product side; process isolation is the remaining ops control.
- **`applyOrgRuntimeToProcess`** mutates process env per job — prefer one job at a time per worker process (current default loop) or isolate env per org pool.

## Related code

- `packages/agents/src/path-jail.ts` — layout + path containment  
- `packages/agents/src/tools/sandbox-tools.ts` — tool jail  
- `packages/db/src/repositories/jobs.ts` — `STEW_WORKER_ORG_IDS` claim filter  
- `packages/sandbox/src/factory.ts` — strict → docker  
