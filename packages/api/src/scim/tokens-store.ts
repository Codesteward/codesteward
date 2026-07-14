/**
 * Per-org SCIM bearer tokens (hashed at rest).
 * Multi-tenant single-domain: token → orgId binding (IdPs never send X-Org-Id).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createId, nowIso } from "@codesteward/core";

export interface ScimTokenMeta {
  id: string;
  orgId: string;
  label?: string;
  last4: string;
  createdBy?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface StoredToken extends ScimTokenMeta {
  tokenHash: string;
}

function dataPath(): string {
  return join(process.env.STEW_DATA_DIR ?? ".steward-data", "scim-tokens.json");
}

export function hashScimToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return a === b;
  }
}

async function pg() {
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (!isDatabaseEnabled()) return null;
    return tryCreateStewardDb()?.pool ?? null;
  } catch {
    return null;
  }
}

async function readFileTokens(): Promise<StoredToken[]> {
  try {
    const raw = await readFile(dataPath(), "utf8");
    const parsed = JSON.parse(raw) as { tokens?: StoredToken[] };
    return parsed.tokens ?? [];
  } catch {
    return [];
  }
}

async function writeFileTokens(tokens: StoredToken[]): Promise<void> {
  await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
  await writeFile(dataPath(), JSON.stringify({ tokens }, null, 2), "utf8");
}

function toMeta(t: StoredToken): ScimTokenMeta {
  return {
    id: t.id,
    orgId: t.orgId,
    label: t.label,
    last4: t.last4,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  };
}

/** Mint a new per-org SCIM token. Returns plaintext once. */
export async function mintScimToken(input: {
  orgId: string;
  label?: string;
  createdBy?: string;
}): Promise<{ token: string; meta: ScimTokenMeta }> {
  const raw = `scim_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashScimToken(raw);
  const meta: StoredToken = {
    id: createId("sct"),
    orgId: input.orgId,
    tokenHash,
    label: input.label ?? "IdP connector",
    last4: raw.slice(-4),
    createdBy: input.createdBy,
    createdAt: nowIso(),
  };

  const pool = await pg();
  if (pool) {
    await pool.query(
      `INSERT INTO scim_tokens (id, org_id, token_hash, label, last4, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        meta.id,
        meta.orgId,
        meta.tokenHash,
        meta.label ?? null,
        meta.last4,
        meta.createdBy ?? null,
        meta.createdAt,
      ],
    );
    return { token: raw, meta: toMeta(meta) };
  }

  const tokens = await readFileTokens();
  tokens.push(meta);
  await writeFileTokens(tokens);
  return { token: raw, meta: toMeta(meta) };
}

export async function listScimTokens(orgId: string): Promise<ScimTokenMeta[]> {
  const pool = await pg();
  if (pool) {
    const res = await pool.query<{
      id: string;
      org_id: string;
      label: string | null;
      last4: string;
      created_by: string | null;
      created_at: Date | string;
      last_used_at: Date | string | null;
      revoked_at: Date | string | null;
    }>(
      `SELECT id, org_id, label, last4, created_by, created_at, last_used_at, revoked_at
       FROM scim_tokens WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      label: r.label ?? undefined,
      last4: r.last4,
      createdBy: r.created_by ?? undefined,
      createdAt:
        typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
      lastUsedAt: r.last_used_at
        ? typeof r.last_used_at === "string"
          ? r.last_used_at
          : r.last_used_at.toISOString()
        : undefined,
      revokedAt: r.revoked_at
        ? typeof r.revoked_at === "string"
          ? r.revoked_at
          : r.revoked_at.toISOString()
        : undefined,
    }));
  }
  return (await readFileTokens())
    .filter((t) => t.orgId === orgId)
    .map(toMeta)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeScimToken(
  orgId: string,
  tokenId: string,
): Promise<boolean> {
  const pool = await pg();
  if (pool) {
    const res = await pool.query(
      `UPDATE scim_tokens SET revoked_at = now()
       WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
      [tokenId, orgId],
    );
    return (res.rowCount ?? 0) > 0;
  }
  const tokens = await readFileTokens();
  const t = tokens.find((x) => x.id === tokenId && x.orgId === orgId && !x.revokedAt);
  if (!t) return false;
  t.revokedAt = nowIso();
  await writeFileTokens(tokens);
  return true;
}

/**
 * Resolve bearer token → orgId.
 * Checks: per-org DB/file tokens, then STEW_SCIM_TOKEN_<ORG>, then STEW_SCIM_TOKEN (single-tenant).
 * Never trusts client-supplied org alone.
 */
export async function resolveScimBearer(
  bearer: string,
): Promise<{ orgId: string; source: "org_token" | "env_org" | "env_global" | "api_key" } | null> {
  if (!bearer) return null;
  const hash = hashScimToken(bearer);

  const pool = await pg();
  if (pool) {
    try {
      const res = await pool.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM scim_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1`,
        [hash],
      );
      const row = res.rows[0];
      if (row) {
        void pool.query(`UPDATE scim_tokens SET last_used_at = now() WHERE id = $1`, [
          row.id,
        ]);
        return { orgId: row.org_id, source: "org_token" };
      }
    } catch {
      /* table may not exist yet — fall through */
    }
  } else {
    const tokens = await readFileTokens();
    const hit = tokens.find((t) => !t.revokedAt && safeEqualHex(t.tokenHash, hash));
    if (hit) {
      hit.lastUsedAt = nowIso();
      await writeFileTokens(tokens);
      return { orgId: hit.orgId, source: "org_token" };
    }
  }

  // Env: STEW_SCIM_TOKEN_<ORGID> (ORGID uppercased, non-alnum → _)
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith("STEW_SCIM_TOKEN_") || key === "STEW_SCIM_TOKEN_ORG") continue;
    if (!val || !safeEqualString(bearer, val)) continue;
    const orgPart = key.slice("STEW_SCIM_TOKEN_".length).toLowerCase().replace(/_/g, "-");
    // Prefer matching org id as stored (often org_xxx or slug). Try reverse: common local
    const orgId = process.env.STEW_SCIM_ORG_ID_MAP
      ? mapEnvOrg(key, orgPart)
      : orgPart === "local"
        ? "local"
        : orgPart.startsWith("org-")
          ? orgPart.replace(/^org-/, "org_")
          : orgPart;
    return { orgId, source: "env_org" };
  }

  // Exact env per-org keys: STEW_SCIM_TOKEN_LOCAL etc. already handled.
  // Also accept STEW_SCIM_TOKEN with STEW_SCIM_ORG_ID (single-tenant install only)
  if (process.env.STEW_SCIM_TOKEN && safeEqualString(bearer, process.env.STEW_SCIM_TOKEN)) {
    return {
      orgId: process.env.STEW_SCIM_ORG_ID ?? process.env.STEW_DEFAULT_ORG_ID ?? "local",
      source: "env_global",
    };
  }

  // API key only when STEW_SCIM_ACCEPT_API_KEY=1 OR no dedicated SCIM tokens configured (bootstrap)
  if (
    process.env.STEW_API_KEY &&
    safeEqualString(bearer, process.env.STEW_API_KEY) &&
    (process.env.STEW_SCIM_ACCEPT_API_KEY === "1" || process.env.STEW_SCIM_ALLOW_API_KEY !== "0")
  ) {
    // API key is platform-scoped — MUST be combined with path orgKey; returns marker
    return {
      orgId: process.env.STEW_DEFAULT_ORG_ID ?? "local",
      source: "api_key",
    };
  }

  return null;
}

function mapEnvOrg(_key: string, orgPart: string): string {
  return orgPart;
}

function safeEqualString(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export async function orgHasScimToken(orgId: string): Promise<boolean> {
  const list = await listScimTokens(orgId);
  if (list.some((t) => !t.revokedAt)) return true;
  const envKey = `STEW_SCIM_TOKEN_${orgId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  if (process.env[envKey]) return true;
  if (
    (process.env.STEW_SCIM_ORG_ID ?? "local") === orgId &&
    process.env.STEW_SCIM_TOKEN
  ) {
    return true;
  }
  return false;
}
