/**
 * Platform-wide ClickHouse trace sink (product SoT for session deep-dive + analytics).
 *
 * - Enablement is platform-only: when configured+enabled, every org dual-writes here.
 * - Full observation I/O is stored (secret-redacted); no content truncation.
 * - Per-row TTL days: org override or platform default.
 *
 * Uses ClickHouse HTTP interface (JSONEachRow) — no extra native deps.
 */
import { createHash, randomUUID } from "node:crypto";
import { redactSecretsOnly } from "./langfuse.js";

export interface ClickHouseConfig {
  /** http(s)://host:8123 — required when enabled */
  url: string;
  username?: string;
  password?: string;
  database?: string;
  /** Table name (default steward_observations) */
  table?: string;
  enabled?: boolean;
  /** Platform default TTL in days when org does not override (default 90) */
  defaultTtlDays?: number;
}

export interface TraceObservation {
  ts?: Date | string;
  orgId: string;
  sessionId: string;
  traceId: string;
  observationId?: string;
  parentObservationId?: string;
  kind: "generation" | "span" | "tool" | "trace_summary";
  name: string;
  role?: string;
  model?: string;
  unitId?: string;
  unitLabel?: string;
  repoId?: string;
  tenantId?: string;
  runner?: string;
  level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
  statusMessage?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  /** Effective retention for this row (org override or platform default) */
  ttlDays?: number;
}

export interface ClickHouseWriter {
  enabled: boolean;
  config: ClickHouseConfig;
  /** Default TTL days applied when observation omits ttlDays */
  defaultTtlDays: number;
  record(obs: TraceObservation): void;
  flush(): Promise<void>;
  ensureSchema(): Promise<void>;
}

const DEFAULT_TABLE = "steward_observations";
const DEFAULT_TTL = 90;
/** Soft safety valve for a single cell — not product truncation of normal LLM text */
const HARD_CELL_MAX = 48 * 1024 * 1024; // 48 MiB

function tableName(cfg: ClickHouseConfig): string {
  const t = (cfg.table ?? DEFAULT_TABLE).replace(/[^a-zA-Z0-9_]/g, "");
  return t || DEFAULT_TABLE;
}

function databaseName(cfg: ClickHouseConfig): string {
  const d = (cfg.database ?? "default").replace(/[^a-zA-Z0-9_]/g, "");
  return d || "default";
}

function jsonCell(value: unknown): string {
  if (value == null) return "";
  try {
    const raw =
      typeof value === "string" ? value : JSON.stringify(value, (_k, v) => {
        if (typeof v === "bigint") return Number(v);
        return v;
      });
    // Secret redaction only — no normal content truncation
    const redacted = redactSecretsOnly(raw);
    if (redacted.length > HARD_CELL_MAX) {
      // Extreme safety only (multi‑10MB accidental dump), not product truncation
      return `${redacted.slice(0, HARD_CELL_MAX)}\n…[hard_limit ${HARD_CELL_MAX} bytes]`;
    }
    return redacted;
  } catch {
    return "[unserializable]";
  }
}

function toClickHouseTs(ts?: Date | string): string {
  const d = ts instanceof Date ? ts : ts ? new Date(ts) : new Date();
  // ClickHouse DateTime64(3) accepts 'YYYY-MM-DD HH:MM:SS.mmm'
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function authHeaders(cfg: ClickHouseConfig): Record<string, string> {
  const user = cfg.username ?? process.env.CLICKHOUSE_USER ?? "default";
  const pass = cfg.password ?? process.env.CLICKHOUSE_PASSWORD ?? "";
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "text/plain; charset=utf-8",
  };
}

function baseUrl(cfg: ClickHouseConfig): string {
  return (cfg.url || process.env.CLICKHOUSE_URL || "").replace(/\/+$/, "");
}

export function isClickHouseConfigComplete(
  cfg: ClickHouseConfig | null | undefined,
): cfg is ClickHouseConfig {
  return Boolean(cfg && cfg.enabled !== false && cfg.url?.trim());
}

export function clickHouseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClickHouseConfig | null {
  const url = env.CLICKHOUSE_URL?.trim();
  if (!url) return null;
  if (env.STEW_CLICKHOUSE_ENABLED === "0") return null;
  return {
    url,
    username: env.CLICKHOUSE_USER || "default",
    password: env.CLICKHOUSE_PASSWORD || "",
    database: env.CLICKHOUSE_DATABASE || "default",
    table: env.CLICKHOUSE_TABLE || DEFAULT_TABLE,
    enabled: env.STEW_CLICKHOUSE_ENABLED !== "0",
    defaultTtlDays: Number(env.STEW_CLICKHOUSE_DEFAULT_TTL_DAYS ?? DEFAULT_TTL) || DEFAULT_TTL,
  };
}

async function chQuery(
  cfg: ClickHouseConfig,
  query: string,
  body?: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = baseUrl(cfg);
  if (!url) return { ok: false, status: 0, text: "no url" };
  const u = new URL(url);
  u.searchParams.set("database", databaseName(cfg));
  u.searchParams.set("query", query);
  const res = await fetch(u.toString(), {
    method: "POST",
    headers: authHeaders(cfg),
    body: body ?? "",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

export async function ensureClickHouseSchema(cfg: ClickHouseConfig): Promise<void> {
  const db = databaseName(cfg);
  const table = tableName(cfg);
  const createDb = await chQuery(cfg, `CREATE DATABASE IF NOT EXISTS ${db}`);
  if (!createDb.ok && !/exist/i.test(createDb.text)) {
    console.warn("[clickhouse] create database failed", createDb.status, createDb.text.slice(0, 300));
  }
  // Per-row TTL via ttl_days column (org override or platform default)
  const ddl = `
CREATE TABLE IF NOT EXISTS ${db}.${table} (
  ts DateTime64(3, 'UTC'),
  org_id LowCardinality(String),
  session_id String,
  trace_id String,
  observation_id String,
  parent_observation_id String DEFAULT '',
  kind LowCardinality(String),
  name String,
  role LowCardinality(String) DEFAULT '',
  model String DEFAULT '',
  unit_id String DEFAULT '',
  unit_label String DEFAULT '',
  repo_id String DEFAULT '',
  tenant_id String DEFAULT '',
  runner LowCardinality(String) DEFAULT '',
  level LowCardinality(String) DEFAULT 'DEFAULT',
  status_message String DEFAULT '',
  input String CODEC(ZSTD(3)),
  output String CODEC(ZSTD(3)),
  metadata String DEFAULT '{}' CODEC(ZSTD(3)),
  prompt_tokens UInt64 DEFAULT 0,
  completion_tokens UInt64 DEFAULT 0,
  total_tokens UInt64 DEFAULT 0,
  duration_ms UInt64 DEFAULT 0,
  ttl_days UInt16 DEFAULT ${DEFAULT_TTL}
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (org_id, session_id, ts, observation_id)
TTL ts + toIntervalDay(ttl_days)
SETTINGS index_granularity = 8192
`.trim();
  const createTable = await chQuery(cfg, ddl);
  if (!createTable.ok && !/exist/i.test(createTable.text)) {
    throw new Error(
      `[clickhouse] ensure schema failed ${createTable.status}: ${createTable.text.slice(0, 500)}`,
    );
  }
}

function rowFromObs(
  obs: TraceObservation,
  defaultTtl: number,
): Record<string, unknown> {
  const ttl = Math.max(1, Math.min(3650, Math.floor(obs.ttlDays ?? defaultTtl)));
  return {
    ts: toClickHouseTs(obs.ts),
    org_id: obs.orgId || "local",
    session_id: obs.sessionId,
    trace_id: obs.traceId,
    observation_id: obs.observationId || randomUUID(),
    parent_observation_id: obs.parentObservationId ?? "",
    kind: obs.kind,
    name: obs.name,
    role: obs.role ?? "",
    model: obs.model ?? "",
    unit_id: obs.unitId ?? "",
    unit_label: obs.unitLabel ?? "",
    repo_id: obs.repoId ?? "",
    tenant_id: obs.tenantId ?? "",
    runner: obs.runner ?? "",
    level: obs.level ?? "DEFAULT",
    status_message: obs.statusMessage ?? "",
    input: jsonCell(obs.input),
    output: jsonCell(obs.output),
    metadata: jsonCell(obs.metadata ?? {}),
    prompt_tokens: Math.max(0, Math.floor(obs.promptTokens ?? 0)),
    completion_tokens: Math.max(0, Math.floor(obs.completionTokens ?? 0)),
    total_tokens: Math.max(0, Math.floor(obs.totalTokens ?? 0)),
    duration_ms: Math.max(0, Math.floor(obs.durationMs ?? 0)),
    ttl_days: ttl,
  };
}

export function createClickHouseWriter(
  cfg: ClickHouseConfig,
  opts?: { defaultTtlDays?: number },
): ClickHouseWriter {
  const fromEnv = Number(process.env.STEW_CLICKHOUSE_DEFAULT_TTL_DAYS);
  const defaultTtlDays = Math.max(
    1,
    Math.min(
      3650,
      opts?.defaultTtlDays ??
        cfg.defaultTtlDays ??
        (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TTL),
    ),
  );
  const buffer: TraceObservation[] = [];
  let schemaReady: Promise<void> | null = null;
  let flushing: Promise<void> | null = null;

  const writer: ClickHouseWriter = {
    enabled: isClickHouseConfigComplete(cfg),
    config: cfg,
    defaultTtlDays,
    record(obs: TraceObservation) {
      if (!writer.enabled) return;
      if (!obs.sessionId?.trim() || !obs.traceId?.trim()) return;
      buffer.push(obs);
      // Soft auto-flush under load so reviews don't hold multi‑MB buffers
      if (buffer.length >= 64) {
        void writer.flush().catch((err) =>
          console.warn("[clickhouse] auto-flush failed", err instanceof Error ? err.message : err),
        );
      }
    },
    async ensureSchema() {
      if (!schemaReady) {
        schemaReady = ensureClickHouseSchema(cfg).catch((err) => {
          schemaReady = null;
          throw err;
        });
      }
      await schemaReady;
    },
    async flush() {
      if (!writer.enabled || buffer.length === 0) return;
      if (flushing) {
        await flushing;
        if (buffer.length === 0) return;
      }
      flushing = (async () => {
        const batch = buffer.splice(0, buffer.length);
        try {
          await writer.ensureSchema();
          const db = databaseName(cfg);
          const table = tableName(cfg);
          const lines = batch
            .map((o) => JSON.stringify(rowFromObs(o, defaultTtlDays)))
            .join("\n");
          const q = `INSERT INTO ${db}.${table} FORMAT JSONEachRow`;
          const res = await chQuery(cfg, q, lines);
          if (!res.ok) {
            console.warn(
              "[clickhouse] insert failed",
              res.status,
              res.text.slice(0, 400),
              `rows=${batch.length}`,
            );
            // Put back for a single retry attempt on next flush is too risky (dupes).
            // Drop after log — reviews must not fail on sink errors.
          } else if (process.env.STEW_CLICKHOUSE_DEBUG === "1") {
            console.info(`[clickhouse] insert ok rows=${batch.length}`);
          }
        } catch (err) {
          console.warn(
            "[clickhouse] flush error",
            err instanceof Error ? err.message : err,
          );
        }
      })();
      try {
        await flushing;
      } finally {
        flushing = null;
      }
    },
  };
  return writer;
}

export async function querySessionObservations(
  cfg: ClickHouseConfig,
  args: {
    orgId: string;
    sessionId: string;
    limit?: number;
  },
): Promise<Array<Record<string, unknown>>> {
  if (!isClickHouseConfigComplete(cfg)) return [];
  await ensureClickHouseSchema(cfg);
  const db = databaseName(cfg);
  const table = tableName(cfg);
  const limit = Math.min(Math.max(args.limit ?? 2000, 1), 10_000);
  // Parameterize via carefully escaped literals (ClickHouse HTTP simple)
  const org = args.orgId.replace(/'/g, "\\'");
  const ses = args.sessionId.replace(/'/g, "\\'");
  const q = `
SELECT
  ts, org_id, session_id, trace_id, observation_id, parent_observation_id,
  kind, name, role, model, unit_id, unit_label, repo_id, tenant_id, runner,
  level, status_message, input, output, metadata,
  prompt_tokens, completion_tokens, total_tokens, duration_ms, ttl_days
FROM ${db}.${table}
WHERE org_id = '${org}' AND session_id = '${ses}'
ORDER BY ts ASC, observation_id ASC
LIMIT ${limit}
FORMAT JSON
`.trim();
  const res = await chQuery(cfg, q);
  if (!res.ok) {
    throw new Error(`[clickhouse] query failed ${res.status}: ${res.text.slice(0, 400)}`);
  }
  try {
    const parsed = JSON.parse(res.text) as { data?: Array<Record<string, unknown>> };
    return parsed.data ?? [];
  } catch {
    return [];
  }
}

/** Stable hash for diagnostics (never log full password). */
export function clickHouseConfigFingerprint(cfg: ClickHouseConfig): string {
  const s = `${cfg.url}|${cfg.username ?? ""}|${databaseName(cfg)}|${tableName(cfg)}`;
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
