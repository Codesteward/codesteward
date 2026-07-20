/**
 * Platform-wide ClickHouse config for product trace storage.
 * When enabled, every org's review dual-writes full observations here.
 * Orgs cannot disable ingestion — only optional TTL override (days).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets.js";
import type { ClickHouseConfig } from "@codesteward/model-router";

export interface PlatformClickHouseConfig {
  enabled?: boolean;
  /** http(s)://host:8123 */
  url?: string;
  username?: string;
  /** Encrypted at rest when saved via API */
  password?: string;
  database?: string;
  table?: string;
  /** Platform default TTL days for rows (org may override lower/higher) */
  defaultTtlDays?: number;
}

function path(): string {
  return join(process.env.STEW_DATA_DIR ?? ".steward-data", "platform-clickhouse.json");
}

export async function getPlatformClickHouse(): Promise<PlatformClickHouseConfig | null> {
  try {
    const raw = await readFile(path(), "utf8");
    const parsed = JSON.parse(raw) as PlatformClickHouseConfig;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function maskClickHouse(cfg: PlatformClickHouseConfig | null | undefined): {
  enabled: boolean;
  urlSet: boolean;
  urlHint?: string;
  username?: string;
  passwordSet: boolean;
  database?: string;
  table?: string;
  defaultTtlDays: number;
} {
  const defaultTtlDays = Math.max(1, Math.min(3650, cfg?.defaultTtlDays ?? 90));
  const url = cfg?.url?.trim() ?? "";
  return {
    enabled: cfg?.enabled !== false && Boolean(url),
    urlSet: Boolean(url),
    urlHint: url
      ? url.length > 24
        ? `${url.slice(0, 18)}…`
        : url
      : undefined,
    username: cfg?.username,
    passwordSet: Boolean(cfg?.password),
    database: cfg?.database ?? "default",
    table: cfg?.table ?? "steward_observations",
    defaultTtlDays,
  };
}

export async function putPlatformClickHouse(
  incoming: (Partial<PlatformClickHouseConfig> & { clear?: boolean }) | null,
): Promise<PlatformClickHouseConfig | null> {
  const prev = await getPlatformClickHouse();
  await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
  if (!incoming || incoming.clear) {
    try {
      await writeFile(path(), "null\n", "utf8");
    } catch {
      /* ignore */
    }
    return null;
  }
  const next: PlatformClickHouseConfig = {
    enabled: incoming.enabled ?? prev?.enabled ?? true,
    url: incoming.url !== undefined ? incoming.url.trim() : prev?.url,
    username:
      incoming.username !== undefined ? incoming.username.trim() : prev?.username,
    database:
      incoming.database !== undefined ? incoming.database.trim() : prev?.database,
    table: incoming.table !== undefined ? incoming.table.trim() : prev?.table,
    defaultTtlDays:
      incoming.defaultTtlDays !== undefined
        ? Math.max(1, Math.min(3650, Math.floor(incoming.defaultTtlDays)))
        : prev?.defaultTtlDays ?? 90,
  };
  if (incoming.password !== undefined && incoming.password !== "") {
    next.password = isEncryptedSecret(incoming.password)
      ? incoming.password
      : encryptSecret(incoming.password);
  } else {
    next.password = prev?.password;
  }
  await writeFile(path(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Runtime config for workers: store wins; env CLICKHOUSE_* fills gaps.
 * When enabled at platform level, all orgs inherit dual-write.
 */
export async function loadPlatformClickHouseForRuntime(): Promise<ClickHouseConfig | null> {
  const stored = await getPlatformClickHouse();
  if (stored?.enabled === false) return null;

  let password = stored?.password ?? "";
  if (password && isEncryptedSecret(password)) {
    try {
      password = decryptSecret(password) ?? "";
    } catch {
      password = "";
    }
  }

  const url = (stored?.url || process.env.CLICKHOUSE_URL || "").trim();
  if (!url) return null;
  if (process.env.STEW_CLICKHOUSE_ENABLED === "0") return null;

  const envTtl = Number(process.env.STEW_CLICKHOUSE_DEFAULT_TTL_DAYS);
  const defaultTtlDays = Math.max(
    1,
    Math.min(
      3650,
      stored?.defaultTtlDays ??
        (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 90),
    ),
  );

  return {
    url,
    username: stored?.username || process.env.CLICKHOUSE_USER || "default",
    password: password || process.env.CLICKHOUSE_PASSWORD || "",
    database: stored?.database || process.env.CLICKHOUSE_DATABASE || "default",
    table: stored?.table || process.env.CLICKHOUSE_TABLE || "steward_observations",
    enabled: true,
    defaultTtlDays,
  };
}

/** Resolve effective TTL for an org (org override or platform default). */
export function resolveTraceTtlDays(
  platformDefault: number,
  orgTtlDays: number | null | undefined,
): number {
  const base = Math.max(1, Math.min(3650, Math.floor(platformDefault || 90)));
  if (orgTtlDays == null || !Number.isFinite(orgTtlDays)) return base;
  return Math.max(1, Math.min(3650, Math.floor(orgTtlDays)));
}
