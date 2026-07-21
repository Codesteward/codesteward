# ClickHouse (product session traces)

Local ClickHouse for Codesteward dual-write of full review traces.

## Start with category stack

```bash
cd deploy/compose

docker compose \
  -f docker-compose.category.yml \
  -f docker-compose.clickhouse.yml \
  up --build -d
```

This puts **api**, **worker**, and **clickhouse** on the same Compose network so the hostname `clickhouse` works from the API.

## Configure in the UI (preferred)

As a **platform admin**:

1. Open **Platform → ClickHouse**
2. Fill in:

| Field | Value |
|-------|--------|
| Enable | ✓ |
| URL | `http://clickhouse:8123` |
| Username | `steward` |
| Password | `steward` |
| Database | `codesteward` |
| Table | `steward_observations` (default) |
| Default TTL | `90` |

3. **Save & test** → expect `Schema ensure OK`

No compose “wire” file and no env vars are required. Settings are stored under `STEW_DATA_DIR` (shared volume) so **workers** load the same config at job start.

### If Save & test fails

| Symptom | Cause / fix |
|---------|-------------|
| Network / ENOTFOUND `clickhouse` | ClickHouse not on the same compose project — re-run with **both** compose files above |
| `host.docker.internal` works but TTL error | Old API image — rebuild api with latest code (`TTL toDateTime(ts) + …`) |
| `localhost:8123` from UI form | Wrong — that is the **API container’s** loopback, not the host. Use `clickhouse` or `host.docker.internal` |

## Defaults

| Setting | Value |
|--------|--------|
| HTTP (host browser / curl) | `http://localhost:8123` |
| HTTP (from api/worker) | `http://clickhouse:8123` |
| User / password | `steward` / `steward` |
| Database | `codesteward` |

```bash
curl -s http://localhost:8123/ping
# → Ok
```

## After a review

Worker log:

```text
clickhouse sink on sessionId=ses_… ttlDays=90
```

UI: **Review → Traces** (any org member).

## ClickHouse only (stack already up)

```bash
docker compose -p codesteward-category \
  -f docker-compose.clickhouse.yml \
  up -d
```

Then configure Platform → ClickHouse with `http://clickhouse:8123` (same project network).
