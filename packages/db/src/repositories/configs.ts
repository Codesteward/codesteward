import { nowIso } from "@codesteward/core";
import type { Queryable } from "../client.js";
import type { OrgSettings } from "../types.js";
import { asRecord, jsonParam, toIso } from "../util.js";

interface OrgSettingsRow {
  org_id: string;
  tenant_id: string;
  model_profiles: unknown;
  steward_overrides: unknown;
  feature_flags: unknown;
  settings: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: OrgSettingsRow): OrgSettings {
  return {
    orgId: row.org_id,
    tenantId: row.tenant_id,
    modelProfiles: asRecord(row.model_profiles),
    stewardOverrides: asRecord(row.steward_overrides),
    featureFlags: asRecord(row.feature_flags),
    settings: asRecord(row.settings),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const emptySettings = (orgId: string, tenantId = "local"): OrgSettings => {
  const ts = nowIso();
  return {
    orgId,
    tenantId,
    modelProfiles: {},
    stewardOverrides: {},
    featureFlags: {},
    settings: {},
    createdAt: ts,
    updatedAt: ts,
  };
};

export class ConfigsRepository {
  constructor(private readonly db: Queryable) {}

  async get(orgId: string): Promise<OrgSettings | undefined> {
    const res = await this.db.query<OrgSettingsRow>(
      `SELECT * FROM org_settings WHERE org_id = $1`,
      [orgId],
    );
    const row = res.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async getOrCreate(orgId: string, tenantId = "local"): Promise<OrgSettings> {
    const existing = await this.get(orgId);
    if (existing) return existing;
    const created = emptySettings(orgId, tenantId);
    await this.upsert(created);
    return created;
  }

  async upsert(settings: Partial<OrgSettings> & { orgId: string }): Promise<OrgSettings> {
    const cur = (await this.get(settings.orgId)) ?? emptySettings(settings.orgId);
    const next: OrgSettings = {
      ...cur,
      ...settings,
      orgId: settings.orgId,
      updatedAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO org_settings (
        org_id, tenant_id, model_profiles, steward_overrides, feature_flags, settings,
        created_at, updated_at
      ) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)
      ON CONFLICT (org_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        model_profiles = EXCLUDED.model_profiles,
        steward_overrides = EXCLUDED.steward_overrides,
        feature_flags = EXCLUDED.feature_flags,
        settings = EXCLUDED.settings,
        updated_at = EXCLUDED.updated_at`,
      [
        next.orgId,
        next.tenantId,
        jsonParam(next.modelProfiles),
        jsonParam(next.stewardOverrides),
        jsonParam(next.featureFlags),
        jsonParam(next.settings),
        next.createdAt,
        next.updatedAt,
      ],
    );
    return next;
  }

  async setFeatureFlags(
    orgId: string,
    flags: Record<string, unknown>,
  ): Promise<OrgSettings> {
    const cur = await this.getOrCreate(orgId);
    return this.upsert({
      orgId,
      featureFlags: { ...cur.featureFlags, ...flags },
    });
  }

  async setModelProfiles(
    orgId: string,
    profiles: Record<string, unknown>,
  ): Promise<OrgSettings> {
    return this.upsert({ orgId, modelProfiles: profiles });
  }

  async setStewardOverrides(
    orgId: string,
    overrides: Record<string, unknown>,
  ): Promise<OrgSettings> {
    return this.upsert({ orgId, stewardOverrides: overrides });
  }
}
