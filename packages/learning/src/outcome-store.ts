/**
 * Durable store for PR / finding outcomes (Postgres or JSON file).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FindingOutcome, PrOutcome } from "@codesteward/core";
import { isDatabaseEnabled, tryCreateStewardDb } from "@codesteward/db";

export interface OutcomeStore {
  savePrOutcome(row: PrOutcome): Promise<PrOutcome>;
  saveFindingOutcomes(rows: FindingOutcome[]): Promise<void>;
  listPrOutcomes(filter?: {
    orgId?: string;
    repoId?: string;
    limit?: number;
  }): Promise<PrOutcome[]>;
  listFindingOutcomes(filter?: {
    orgId?: string;
    repoId?: string;
    prKey?: string;
    kind?: string;
    limit?: number;
  }): Promise<FindingOutcome[]>;
}

export function createOutcomeStore(opts?: {
  filePath?: string;
  forceFile?: boolean;
}): OutcomeStore {
  const filePath =
    opts?.filePath ??
    `${process.env.STEW_DATA_DIR ?? ".steward-data"}/outcomes.json`;

  if (!opts?.forceFile && isDatabaseEnabled()) {
    try {
      const db = tryCreateStewardDb();
      if (db) return createDbOutcomeStore(db);
    } catch {
      /* fall through to file */
    }
  }
  return createFileOutcomeStore(filePath);
}

function createFileOutcomeStore(filePath: string): OutcomeStore {
  let prs: PrOutcome[] = [];
  let findings: FindingOutcome[] = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw) as {
        prOutcomes?: PrOutcome[];
        findingOutcomes?: FindingOutcome[];
      };
      prs = data.prOutcomes ?? [];
      findings = data.findingOutcomes ?? [];
    } catch {
      prs = [];
      findings = [];
    }
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ prOutcomes: prs, findingOutcomes: findings }, null, 2),
      "utf8",
    );
  }

  return {
    async savePrOutcome(row) {
      await load();
      const idx = prs.findIndex(
        (p) => p.orgId === row.orgId && p.prKey === row.prKey,
      );
      if (idx >= 0) prs[idx] = row;
      else prs.push(row);
      await save();
      return row;
    },
    async saveFindingOutcomes(rows) {
      await load();
      findings.push(...rows);
      await save();
    },
    async listPrOutcomes(filter = {}) {
      await load();
      let out = prs;
      if (filter.orgId) out = out.filter((p) => p.orgId === filter.orgId);
      if (filter.repoId) out = out.filter((p) => p.repoId === filter.repoId);
      out = [...out].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out.slice(0, filter.limit ?? 100);
    },
    async listFindingOutcomes(filter = {}) {
      await load();
      let out = findings;
      if (filter.orgId) out = out.filter((p) => p.orgId === filter.orgId);
      if (filter.repoId) out = out.filter((p) => p.repoId === filter.repoId);
      if (filter.prKey) out = out.filter((p) => p.prKey === filter.prKey);
      if (filter.kind) out = out.filter((p) => p.kind === filter.kind);
      out = [...out].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out.slice(0, filter.limit ?? 500);
    },
  };
}

function createDbOutcomeStore(db: {
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
}): OutcomeStore {
  const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);

  return {
    async savePrOutcome(row) {
      await q(
        `INSERT INTO pr_outcomes (
          id, org_id, tenant_id, repo_id, pr_number, pr_key, merge_sha, base_sha, head_sha,
          session_ids, gate_verdict, counts, rates, paths_changed, metadata, created_at
        ) VALUES ($1,$2,'local',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15)
        ON CONFLICT (id) DO UPDATE SET
          counts = EXCLUDED.counts, rates = EXCLUDED.rates, metadata = EXCLUDED.metadata`,
        [
          row.id,
          row.orgId,
          row.repoId,
          row.prNumber,
          row.prKey,
          row.mergeSha ?? null,
          row.baseSha ?? null,
          row.headSha ?? null,
          JSON.stringify(row.sessionIds ?? []),
          row.gateVerdict ?? null,
          JSON.stringify(row.counts),
          JSON.stringify(row.rates),
          JSON.stringify(row.pathsChanged ?? []),
          JSON.stringify(row.metadata ?? {}),
          row.createdAt,
        ],
      );
      // Also upsert by org+pr_key for idempotent merge redelivery
      await q(
        `DELETE FROM pr_outcomes WHERE org_id = $1 AND pr_key = $2 AND id <> $3`,
        [row.orgId, row.prKey, row.id],
      ).catch(() => undefined);
      return row;
    },
    async saveFindingOutcomes(rows) {
      for (const row of rows) {
        await q(
          `INSERT INTO finding_outcomes (
            id, org_id, tenant_id, repo_id, pr_number, pr_key, finding_id, fingerprint,
            kind, session_id, merge_sha, confidence, note, metadata, created_at
          ) VALUES ($1,$2,'local',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
          ON CONFLICT (id) DO NOTHING`,
          [
            row.id,
            row.orgId,
            row.repoId,
            row.prNumber ?? null,
            row.prKey ?? null,
            row.findingId ?? null,
            row.fingerprint ?? null,
            row.kind,
            row.sessionId ?? null,
            row.mergeSha ?? null,
            row.confidence ?? 1,
            row.note ?? null,
            JSON.stringify(row.metadata ?? {}),
            row.createdAt,
          ],
        );
      }
    },
    async listPrOutcomes(filter = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.orgId) {
        params.push(filter.orgId);
        clauses.push(`org_id = $${params.length}`);
      }
      if (filter.repoId) {
        params.push(filter.repoId);
        clauses.push(`repo_id = $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(filter.limit ?? 100);
      const res = await q(
        `SELECT * FROM pr_outcomes ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return (res.rows as Record<string, unknown>[]).map(mapPrRow);
    },
    async listFindingOutcomes(filter = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.orgId) {
        params.push(filter.orgId);
        clauses.push(`org_id = $${params.length}`);
      }
      if (filter.repoId) {
        params.push(filter.repoId);
        clauses.push(`repo_id = $${params.length}`);
      }
      if (filter.prKey) {
        params.push(filter.prKey);
        clauses.push(`pr_key = $${params.length}`);
      }
      if (filter.kind) {
        params.push(filter.kind);
        clauses.push(`kind = $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(filter.limit ?? 500);
      const res = await q(
        `SELECT * FROM finding_outcomes ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return (res.rows as Record<string, unknown>[]).map(mapFindingRow);
    },
  };
}

function mapPrRow(row: Record<string, unknown>): PrOutcome {
  return {
    id: String(row.id),
    orgId: String(row.org_id ?? "local"),
    repoId: String(row.repo_id),
    prNumber: Number(row.pr_number),
    prKey: String(row.pr_key),
    mergeSha: (row.merge_sha as string) ?? undefined,
    baseSha: (row.base_sha as string) ?? undefined,
    headSha: (row.head_sha as string) ?? undefined,
    sessionIds: (row.session_ids as string[]) ?? [],
    gateVerdict: (row.gate_verdict as string) ?? undefined,
    counts: row.counts as PrOutcome["counts"],
    rates: row.rates as PrOutcome["rates"],
    pathsChanged: (row.paths_changed as string[]) ?? [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string).toISOString?.() ?? String(row.created_at),
  };
}

function mapFindingRow(row: Record<string, unknown>): FindingOutcome {
  return {
    id: String(row.id),
    orgId: String(row.org_id ?? "local"),
    repoId: String(row.repo_id),
    prNumber: row.pr_number != null ? Number(row.pr_number) : undefined,
    prKey: (row.pr_key as string) ?? undefined,
    findingId: (row.finding_id as string) ?? undefined,
    fingerprint: (row.fingerprint as string) ?? undefined,
    kind: row.kind as FindingOutcome["kind"],
    sessionId: (row.session_id as string) ?? undefined,
    mergeSha: (row.merge_sha as string) ?? undefined,
    confidence: Number(row.confidence ?? 1),
    note: (row.note as string) ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string).toISOString?.() ?? String(row.created_at),
  };
}
