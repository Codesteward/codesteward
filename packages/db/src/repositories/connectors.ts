import { nowIso } from "@codesteward/core";
import type { Queryable } from "../client.js";
import type { OrgConnector } from "../types.js";
import { asRecord, jsonParam, toIso } from "../util.js";

interface ConnectorRow {
  org_id: string;
  type: string;
  config: unknown;
  enabled: boolean;
  updated_at: Date | string;
}

function mapRow(row: ConnectorRow): OrgConnector {
  return {
    orgId: row.org_id,
    type: row.type,
    config: asRecord(row.config),
    enabled: Boolean(row.enabled),
    updatedAt: toIso(row.updated_at),
  };
}

export class ConnectorsRepository {
  constructor(private readonly db: Queryable) {}

  async list(orgId: string): Promise<OrgConnector[]> {
    const res = await this.db.query<ConnectorRow>(
      `SELECT * FROM org_connectors WHERE org_id = $1 ORDER BY type ASC`,
      [orgId],
    );
    return res.rows.map(mapRow);
  }

  async get(orgId: string, type: string): Promise<OrgConnector | undefined> {
    const res = await this.db.query<ConnectorRow>(
      `SELECT * FROM org_connectors WHERE org_id = $1 AND type = $2`,
      [orgId, type],
    );
    const row = res.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async listAll(): Promise<OrgConnector[]> {
    const res = await this.db.query<ConnectorRow>(
      `SELECT * FROM org_connectors ORDER BY org_id, type`,
    );
    return res.rows.map(mapRow);
  }

  async upsert(input: {
    orgId: string;
    type: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<OrgConnector> {
    const existing = await this.get(input.orgId, input.type);
    const next: OrgConnector = {
      orgId: input.orgId,
      type: input.type,
      config: input.config ?? existing?.config ?? {},
      enabled: input.enabled ?? existing?.enabled ?? true,
      updatedAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO org_connectors (org_id, type, config, enabled, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (org_id, type) DO UPDATE SET
         config = EXCLUDED.config,
         enabled = EXCLUDED.enabled,
         updated_at = EXCLUDED.updated_at`,
      [
        next.orgId,
        next.type,
        jsonParam(next.config),
        next.enabled,
        next.updatedAt,
      ],
    );
    return next;
  }

  async delete(orgId: string, type: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM org_connectors WHERE org_id = $1 AND type = $2`,
      [orgId, type],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
