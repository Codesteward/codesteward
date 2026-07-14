/**
 * SCIM Groups store — Postgres when available, file fallback under STEW_DATA_DIR.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createId, nowIso } from "@codesteward/core";

export interface ScimGroupRecord {
  id: string;
  orgId: string;
  displayName: string;
  externalId?: string;
  memberIds: string[];
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function dataPath(): string {
  return join(process.env.STEW_DATA_DIR ?? ".steward-data", "scim-groups.json");
}

async function readFileGroups(): Promise<ScimGroupRecord[]> {
  try {
    const raw = await readFile(dataPath(), "utf8");
    const parsed = JSON.parse(raw) as { groups?: ScimGroupRecord[] };
    return parsed.groups ?? [];
  } catch {
    return [];
  }
}

async function writeFileGroups(groups: ScimGroupRecord[]): Promise<void> {
  await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
  await writeFile(dataPath(), JSON.stringify({ groups }, null, 2), "utf8");
}

async function pg() {
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (!isDatabaseEnabled()) return null;
    const db = tryCreateStewardDb();
    return db?.pool ?? null;
  } catch {
    return null;
  }
}

export async function listScimGroups(orgId: string): Promise<ScimGroupRecord[]> {
  const pool = await pg();
  if (pool) {
    const res = await pool.query<{
      id: string;
      org_id: string;
      display_name: string;
      external_id: string | null;
      meta: unknown;
      created_at: Date | string;
      updated_at: Date | string;
    }>(`SELECT * FROM scim_groups WHERE org_id = $1 ORDER BY display_name ASC`, [orgId]);
    const out: ScimGroupRecord[] = [];
    for (const row of res.rows) {
      const mem = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM scim_group_members WHERE group_id = $1`,
        [row.id],
      );
      out.push({
        id: row.id,
        orgId: row.org_id,
        displayName: row.display_name,
        externalId: row.external_id ?? undefined,
        memberIds: mem.rows.map((m) => m.user_id),
        meta:
          row.meta && typeof row.meta === "object"
            ? (row.meta as Record<string, unknown>)
            : undefined,
        createdAt:
          typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
        updatedAt:
          typeof row.updated_at === "string" ? row.updated_at : row.updated_at.toISOString(),
      });
    }
    return out;
  }
  return (await readFileGroups()).filter((g) => g.orgId === orgId);
}

export async function getScimGroup(
  orgId: string,
  id: string,
): Promise<ScimGroupRecord | undefined> {
  const all = await listScimGroups(orgId);
  return all.find((g) => g.id === id);
}

export async function getScimGroupByExternalId(
  orgId: string,
  externalId: string,
): Promise<ScimGroupRecord | undefined> {
  const all = await listScimGroups(orgId);
  return all.find((g) => g.externalId === externalId);
}

export async function createScimGroup(input: {
  orgId: string;
  displayName: string;
  externalId?: string;
  memberIds?: string[];
  meta?: Record<string, unknown>;
  id?: string;
}): Promise<ScimGroupRecord> {
  const now = nowIso();
  const rec: ScimGroupRecord = {
    id: input.id ?? createId("grp"),
    orgId: input.orgId,
    displayName: input.displayName,
    externalId: input.externalId,
    memberIds: [...new Set(input.memberIds ?? [])],
    meta: input.meta,
    createdAt: now,
    updatedAt: now,
  };
  const pool = await pg();
  if (pool) {
    await pool.query(
      `INSERT INTO scim_groups (id, org_id, display_name, external_id, meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [
        rec.id,
        rec.orgId,
        rec.displayName,
        rec.externalId ?? null,
        JSON.stringify(rec.meta ?? {}),
        rec.createdAt,
        rec.updatedAt,
      ],
    );
    for (const uid of rec.memberIds) {
      await pool.query(
        `INSERT INTO scim_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [rec.id, uid],
      );
    }
    return rec;
  }
  const groups = await readFileGroups();
  groups.push(rec);
  await writeFileGroups(groups);
  return rec;
}

export async function updateScimGroup(
  orgId: string,
  id: string,
  patch: {
    displayName?: string;
    externalId?: string | null;
    memberIds?: string[];
    meta?: Record<string, unknown>;
  },
): Promise<ScimGroupRecord | undefined> {
  const pool = await pg();
  if (pool) {
    const cur = await getScimGroup(orgId, id);
    if (!cur) return undefined;
    const next: ScimGroupRecord = {
      ...cur,
      displayName: patch.displayName ?? cur.displayName,
      externalId:
        patch.externalId === undefined
          ? cur.externalId
          : patch.externalId === null || patch.externalId === ""
            ? undefined
            : patch.externalId,
      memberIds: patch.memberIds !== undefined ? [...new Set(patch.memberIds)] : cur.memberIds,
      meta: patch.meta ?? cur.meta,
      updatedAt: nowIso(),
    };
    await pool.query(
      `UPDATE scim_groups SET display_name = $2, external_id = $3, meta = $4::jsonb, updated_at = $5
       WHERE id = $1 AND org_id = $6`,
      [
        next.id,
        next.displayName,
        next.externalId ?? null,
        JSON.stringify(next.meta ?? {}),
        next.updatedAt,
        orgId,
      ],
    );
    if (patch.memberIds !== undefined) {
      await pool.query(`DELETE FROM scim_group_members WHERE group_id = $1`, [id]);
      for (const uid of next.memberIds) {
        await pool.query(
          `INSERT INTO scim_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, uid],
        );
      }
    }
    return next;
  }
  const groups = await readFileGroups();
  const idx = groups.findIndex((g) => g.id === id && g.orgId === orgId);
  if (idx < 0) return undefined;
  const cur = groups[idx]!;
  const next: ScimGroupRecord = {
    ...cur,
    displayName: patch.displayName ?? cur.displayName,
    externalId:
      patch.externalId === undefined
        ? cur.externalId
        : patch.externalId === null || patch.externalId === ""
          ? undefined
          : patch.externalId,
    memberIds: patch.memberIds !== undefined ? [...new Set(patch.memberIds)] : cur.memberIds,
    meta: patch.meta ?? cur.meta,
    updatedAt: nowIso(),
  };
  groups[idx] = next;
  await writeFileGroups(groups);
  return next;
}

export async function deleteScimGroup(orgId: string, id: string): Promise<boolean> {
  const pool = await pg();
  if (pool) {
    await pool.query(`DELETE FROM scim_group_members WHERE group_id = $1`, [id]);
    const res = await pool.query(`DELETE FROM scim_groups WHERE id = $1 AND org_id = $2`, [
      id,
      orgId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }
  const groups = await readFileGroups();
  const next = groups.filter((g) => !(g.id === id && g.orgId === orgId));
  if (next.length === groups.length) return false;
  await writeFileGroups(next);
  return true;
}
