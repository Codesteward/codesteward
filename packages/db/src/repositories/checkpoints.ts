import { nowIso } from "@codesteward/core";
import type { Queryable } from "../client.js";
import type { UnitCheckpoint } from "../types.js";
import { asRecord, jsonParam, newCheckpointId, toIso } from "../util.js";

interface CheckpointRow {
  id: string;
  unit_id?: string;
  session_id: string;
  stage: string;
  cursor: unknown;
  state: unknown;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapUnitRow(row: CheckpointRow): UnitCheckpoint {
  return {
    id: row.id,
    unitId: row.unit_id ?? "",
    sessionId: row.session_id,
    stage: row.stage,
    cursor: asRecord(row.cursor),
    state: asRecord(row.state),
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSessionRow(row: CheckpointRow): UnitCheckpoint {
  return {
    id: row.id,
    unitId: `__session__:${row.session_id}`,
    sessionId: row.session_id,
    stage: row.stage,
    cursor: asRecord(row.cursor),
    state: asRecord(row.state),
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Checkpoints: session payloads go to session_checkpoints (no unit FK);
 * unit payloads go to unit_checkpoints after ensuring review_units row exists.
 */
export class CheckpointsRepository {
  constructor(private readonly db: Queryable) {}

  // ── Session-level (preferred for SessionCheckpointPayload) ──────────────

  async saveSession(input: {
    sessionId: string;
    stage: string;
    cursor?: Record<string, unknown>;
    state?: Record<string, unknown>;
    id?: string;
  }): Promise<UnitCheckpoint> {
    const existing = await this.getSessionStage(input.sessionId, input.stage);
    const ts = nowIso();
    if (existing) {
      const next: UnitCheckpoint = {
        ...existing,
        cursor: input.cursor ?? existing.cursor,
        state: input.state ?? existing.state,
        version: existing.version + 1,
        updatedAt: ts,
      };
      await this.db.query(
        `UPDATE session_checkpoints SET
           cursor = $2::jsonb, state = $3::jsonb, version = $4, updated_at = $5
         WHERE id = $1`,
        [
          next.id,
          jsonParam(next.cursor),
          jsonParam(next.state),
          next.version,
          next.updatedAt,
        ],
      );
      return next;
    }

    const created: UnitCheckpoint = {
      id: input.id ?? newCheckpointId(),
      unitId: `__session__:${input.sessionId}`,
      sessionId: input.sessionId,
      stage: input.stage,
      cursor: input.cursor ?? {},
      state: input.state ?? {},
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.query(
      `INSERT INTO session_checkpoints (
        id, session_id, stage, cursor, state, version, created_at, updated_at
      ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
      [
        created.id,
        created.sessionId,
        created.stage,
        jsonParam(created.cursor),
        jsonParam(created.state),
        created.version,
        created.createdAt,
        created.updatedAt,
      ],
    );
    return created;
  }

  async getSessionStage(
    sessionId: string,
    stage: string,
  ): Promise<UnitCheckpoint | undefined> {
    const res = await this.db.query<CheckpointRow>(
      `SELECT * FROM session_checkpoints WHERE session_id = $1 AND stage = $2`,
      [sessionId, stage],
    );
    const row = res.rows[0];
    return row ? mapSessionRow(row) : undefined;
  }

  async listSessionCheckpoints(sessionId: string): Promise<UnitCheckpoint[]> {
    const res = await this.db.query<CheckpointRow>(
      `SELECT * FROM session_checkpoints WHERE session_id = $1 ORDER BY updated_at DESC`,
      [sessionId],
    );
    return res.rows.map(mapSessionRow);
  }

  async deleteSessionCheckpoint(id: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM session_checkpoints WHERE id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Unit-level (real unit ids only; FK to review_units) ─────────────────

  /**
   * Ensure a review_units row exists so unit_checkpoints FK succeeds.
   * Minimal stub when only checkpointing without full unit plan.
   */
  async ensureUnitRow(input: {
    unitId: string;
    sessionId: string;
    kind?: string;
    label?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO review_units (
        id, session_id, kind, label, paths, symbols, status, assigned_roles, metadata
      ) VALUES ($1,$2,$3,$4,'[]'::jsonb,'[]'::jsonb,'pending','[]'::jsonb,'{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`,
      [
        input.unitId,
        input.sessionId,
        input.kind ?? "file_group",
        input.label ?? input.unitId,
      ],
    );
  }

  async save(
    input: Omit<UnitCheckpoint, "id" | "createdAt" | "updatedAt" | "version"> & {
      id?: string;
      version?: number;
    },
  ): Promise<UnitCheckpoint> {
    // Route synthetic session ids to session_checkpoints
    if (input.unitId.startsWith("__session__:")) {
      return this.saveSession({
        sessionId: input.sessionId,
        stage: input.stage,
        cursor: input.cursor,
        state: input.state,
        id: input.id,
      });
    }

    // Ensure parent unit row exists before FK insert
    await this.ensureUnitRow({
      unitId: input.unitId,
      sessionId: input.sessionId,
      label: input.unitId,
    });

    const existing = await this.getByUnitStage(input.unitId, input.stage);
    const ts = nowIso();
    if (existing) {
      const next: UnitCheckpoint = {
        ...existing,
        cursor: input.cursor ?? existing.cursor,
        state: input.state ?? existing.state,
        version: existing.version + 1,
        updatedAt: ts,
      };
      await this.db.query(
        `UPDATE unit_checkpoints SET
           cursor = $2::jsonb, state = $3::jsonb, version = $4, updated_at = $5
         WHERE id = $1`,
        [
          next.id,
          jsonParam(next.cursor),
          jsonParam(next.state),
          next.version,
          next.updatedAt,
        ],
      );
      return next;
    }

    const created: UnitCheckpoint = {
      id: input.id ?? newCheckpointId(),
      unitId: input.unitId,
      sessionId: input.sessionId,
      stage: input.stage,
      cursor: input.cursor ?? {},
      state: input.state ?? {},
      version: input.version ?? 1,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.query(
      `INSERT INTO unit_checkpoints (
        id, unit_id, session_id, stage, cursor, state, version, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
      [
        created.id,
        created.unitId,
        created.sessionId,
        created.stage,
        jsonParam(created.cursor),
        jsonParam(created.state),
        created.version,
        created.createdAt,
        created.updatedAt,
      ],
    );
    return created;
  }

  async getByUnitStage(
    unitId: string,
    stage: string,
  ): Promise<UnitCheckpoint | undefined> {
    if (unitId.startsWith("__session__:")) {
      const sessionId = unitId.slice("__session__:".length);
      return this.getSessionStage(sessionId, stage);
    }
    const res = await this.db.query<CheckpointRow>(
      `SELECT * FROM unit_checkpoints WHERE unit_id = $1 AND stage = $2`,
      [unitId, stage],
    );
    const row = res.rows[0];
    return row ? mapUnitRow(row) : undefined;
  }

  async listForSession(sessionId: string): Promise<UnitCheckpoint[]> {
    const [sessionRows, unitRows] = await Promise.all([
      this.listSessionCheckpoints(sessionId),
      this.db.query<CheckpointRow>(
        `SELECT * FROM unit_checkpoints WHERE session_id = $1 ORDER BY updated_at DESC`,
        [sessionId],
      ),
    ]);
    return [...sessionRows, ...unitRows.rows.map(mapUnitRow)];
  }

  async listForUnit(unitId: string): Promise<UnitCheckpoint[]> {
    const res = await this.db.query<CheckpointRow>(
      `SELECT * FROM unit_checkpoints WHERE unit_id = $1 ORDER BY updated_at DESC`,
      [unitId],
    );
    return res.rows.map(mapUnitRow);
  }

  async delete(id: string): Promise<boolean> {
    const a = await this.db.query(`DELETE FROM unit_checkpoints WHERE id = $1`, [id]);
    const b = await this.db.query(`DELETE FROM session_checkpoints WHERE id = $1`, [id]);
    return (a.rowCount ?? 0) + (b.rowCount ?? 0) > 0;
  }
}
