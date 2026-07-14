import type { Queryable } from "../client.js";
import { createId, nowIso } from "@codesteward/core";

export interface DbOrg {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface DbMembership {
  orgId: string;
  userId: string;
  role: string;
  createdAt: string;
}

export interface DbScmInstallation {
  id: string;
  tenantId: string;
  orgId: string;
  provider: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  baseUrl?: string;
  status: string;
  authMode: string;
  repositorySelection?: string;
  permissions?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface DbScmApp {
  id: string;
  tenantId: string;
  provider: string;
  authMode: string;
  appId?: string;
  clientId?: string;
  clientSecretRef?: string;
  privateKeyRef?: string;
  webhookSecretRef?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class TenancyRepository {
  constructor(private readonly db: Queryable) {}

  async ensureSeed(): Promise<void> {
    await this.db.query(
      `INSERT INTO tenants (id, name, slug) VALUES ('local', 'Local', 'local') ON CONFLICT (id) DO NOTHING`,
    );
    await this.db.query(
      `INSERT INTO organizations (id, tenant_id, name, slug) VALUES ('local', 'local', 'Local', 'local') ON CONFLICT (id) DO NOTHING`,
    );
  }

  async listOrgs(tenantId = "local"): Promise<DbOrg[]> {
    const res = await this.db.query(
      `SELECT id, tenant_id, name, slug, created_at FROM organizations WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      name: String(r.name),
      slug: String(r.slug),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }

  async createOrg(input: {
    id?: string;
    tenantId?: string;
    name: string;
    slug: string;
  }): Promise<DbOrg> {
    const org: DbOrg = {
      id: input.id ?? createId("org"),
      tenantId: input.tenantId ?? "local",
      name: input.name,
      slug: input.slug,
      createdAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO organizations (id, tenant_id, name, slug, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [org.id, org.tenantId, org.name, org.slug, org.createdAt],
    );
    return org;
  }

  async updateOrg(
    orgId: string,
    patch: { name?: string; slug?: string },
  ): Promise<DbOrg | undefined> {
    const res = await this.db.query(
      `SELECT id, tenant_id, name, slug, created_at FROM organizations WHERE id = $1`,
      [orgId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const name = patch.name?.trim() || String(row.name);
    const slug =
      patch.slug?.trim() ||
      (patch.name
        ? patch.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
        : String(row.slug));
    await this.db.query(
      `UPDATE organizations SET name = $2, slug = $3 WHERE id = $1`,
      [orgId, name, slug],
    );
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name,
      slug,
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }

  async listMembers(orgId: string): Promise<DbMembership[]> {
    const res = await this.db.query(
      `SELECT org_id, user_id, role, created_at FROM organization_members WHERE org_id = $1`,
      [orgId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      orgId: String(r.org_id),
      userId: String(r.user_id),
      role: String(r.role),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }

  async upsertMember(input: {
    orgId: string;
    userId: string;
    role: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO organization_members (org_id, user_id, role, created_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [input.orgId, input.userId, input.role],
    );
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getMembership(orgId: string, userId: string): Promise<DbMembership | undefined> {
    const res = await this.db.query(
      `SELECT org_id, user_id, role, created_at FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      orgId: String(r.org_id),
      userId: String(r.user_id),
      role: String(r.role),
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async listMembershipsForUser(userId: string): Promise<DbMembership[]> {
    const res = await this.db.query(
      `SELECT org_id, user_id, role, created_at FROM organization_members WHERE user_id = $1`,
      [userId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      orgId: String(r.org_id),
      userId: String(r.user_id),
      role: String(r.role),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }

  async listInstallations(orgId?: string): Promise<DbScmInstallation[]> {
    const res = orgId
      ? await this.db.query(
          `SELECT * FROM scm_installations WHERE org_id = $1 ORDER BY updated_at DESC`,
          [orgId],
        )
      : await this.db.query(`SELECT * FROM scm_installations ORDER BY updated_at DESC`);
    return res.rows.map(mapInstall);
  }

  async upsertInstallation(input: {
    id?: string;
    tenantId?: string;
    orgId: string;
    provider: string;
    installationId: string;
    accountLogin: string;
    accountType?: string;
    baseUrl?: string;
    status?: string;
    authMode?: string;
    repositorySelection?: string;
    permissions?: Record<string, unknown>;
  }): Promise<DbScmInstallation> {
    const now = nowIso();
    const id = input.id ?? createId("inst");
    const existing = await this.db.query(
      `SELECT id FROM scm_installations
       WHERE provider = $1 AND installation_id = $2 AND COALESCE(base_url,'') = COALESCE($3,'')`,
      [input.provider, input.installationId, input.baseUrl ?? null],
    );
    if (existing.rows[0]) {
      const eid = String((existing.rows[0] as { id: string }).id);
      await this.db.query(
        `UPDATE scm_installations SET
          org_id = $2, account_login = $3, account_type = $4, status = $5,
          auth_mode = COALESCE($6, auth_mode), repository_selection = $7,
          permissions = COALESCE($8::jsonb, permissions), updated_at = $9
         WHERE id = $1`,
        [
          eid,
          input.orgId,
          input.accountLogin,
          input.accountType ?? "Organization",
          input.status ?? "active",
          input.authMode ?? "github_app",
          input.repositorySelection ?? null,
          input.permissions ? JSON.stringify(input.permissions) : null,
          now,
        ],
      );
      const rows = await this.listInstallations(input.orgId);
      return rows.find((r) => r.id === eid)!;
    }
    await this.db.query(
      `INSERT INTO scm_installations (
        id, tenant_id, org_id, provider, installation_id, account_login, account_type,
        base_url, status, permissions, repository_selection, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
      [
        id,
        input.tenantId ?? "local",
        input.orgId,
        input.provider,
        input.installationId,
        input.accountLogin,
        input.accountType ?? "Organization",
        input.baseUrl ?? null,
        input.status ?? "active",
        JSON.stringify(input.permissions ?? {}),
        input.repositorySelection ?? null,
        now,
      ],
    );
    // store auth_mode in config jsonb if column missing — 005 has no auth_mode column
    // Keep in permissions/config via update of config
    await this.db.query(
      `UPDATE scm_installations SET config = COALESCE(config,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [id, JSON.stringify({ authMode: input.authMode ?? "github_app" })],
    );
    const rows = await this.listInstallations(input.orgId);
    return rows.find((r) => r.id === id)!;
  }

  async findInstallationByProviderId(
    provider: string,
    installationId: string,
  ): Promise<DbScmInstallation | undefined> {
    const res = await this.db.query(
      `SELECT * FROM scm_installations WHERE provider = $1 AND installation_id = $2 LIMIT 1`,
      [provider, installationId],
    );
    const row = res.rows[0];
    return row ? mapInstall(row as Record<string, unknown>) : undefined;
  }

  async deleteInstallation(provider: string, installationId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM scm_installations WHERE provider = $1 AND installation_id = $2`,
      [provider, installationId],
    );
  }

  async suspendInstallation(provider: string, installationId: string): Promise<void> {
    await this.db.query(
      `UPDATE scm_installations SET status = 'suspended', updated_at = now()
       WHERE provider = $1 AND installation_id = $2`,
      [provider, installationId],
    );
  }

  async upsertScmApp(input: {
    id?: string;
    tenantId?: string;
    provider: string;
    authMode?: string;
    appId?: string;
    clientId?: string;
    clientSecretRef?: string;
    privateKeyRef?: string;
    webhookSecretRef?: string;
    baseUrl?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DbScmApp> {
    const id = input.id ?? createId("sapp");
    const now = nowIso();
    await this.db.query(
      `INSERT INTO scm_apps (
        id, tenant_id, provider, auth_mode, app_id, client_id, client_secret_ref,
        private_key_ref, webhook_secret_ref, base_url, metadata, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12)
      ON CONFLICT (tenant_id, provider, app_id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        client_secret_ref = COALESCE(EXCLUDED.client_secret_ref, scm_apps.client_secret_ref),
        private_key_ref = COALESCE(EXCLUDED.private_key_ref, scm_apps.private_key_ref),
        webhook_secret_ref = COALESCE(EXCLUDED.webhook_secret_ref, scm_apps.webhook_secret_ref),
        base_url = EXCLUDED.base_url,
        metadata = COALESCE(EXCLUDED.metadata, scm_apps.metadata),
        updated_at = EXCLUDED.updated_at`,
      [
        id,
        input.tenantId ?? "local",
        input.provider,
        input.authMode ?? "github_app",
        input.appId ?? null,
        input.clientId ?? null,
        input.clientSecretRef ?? null,
        input.privateKeyRef ?? null,
        input.webhookSecretRef ?? null,
        input.baseUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    const res = await this.db.query(
      `SELECT * FROM scm_apps WHERE tenant_id = $1 AND provider = $2 AND app_id IS NOT DISTINCT FROM $3 LIMIT 1`,
      [input.tenantId ?? "local", input.provider, input.appId ?? null],
    );
    return mapApp(res.rows[0] as Record<string, unknown>);
  }

  async getScmApp(provider: string, tenantId = "local"): Promise<DbScmApp | undefined> {
    const res = await this.db.query(
      `SELECT * FROM scm_apps WHERE tenant_id = $1 AND provider = $2 ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, provider],
    );
    const row = res.rows[0];
    return row ? mapApp(row as Record<string, unknown>) : undefined;
  }

  async deleteScmApp(provider: string, tenantId = "local"): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM scm_apps WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider],
    );
    return res.rowCount ?? 0;
  }

  async deleteInstallationsForOrg(orgId: string, provider?: string): Promise<number> {
    if (provider) {
      const res = await this.db.query(
        `DELETE FROM scm_installations WHERE org_id = $1 AND provider = $2`,
        [orgId, provider],
      );
      return res.rowCount ?? 0;
    }
    const res = await this.db.query(`DELETE FROM scm_installations WHERE org_id = $1`, [orgId]);
    return res.rowCount ?? 0;
  }
}

function mapInstall(r: Record<string, unknown>): DbScmInstallation {
  const config = (r.config as Record<string, unknown>) ?? {};
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    orgId: String(r.org_id),
    provider: String(r.provider),
    installationId: String(r.installation_id),
    accountLogin: String(r.account_login),
    accountType: String(r.account_type ?? "Organization"),
    baseUrl: r.base_url ? String(r.base_url) : undefined,
    status: String(r.status ?? "active"),
    authMode: String(config.authMode ?? "github_app"),
    repositorySelection: r.repository_selection
      ? String(r.repository_selection)
      : undefined,
    permissions: (r.permissions as Record<string, string>) ?? undefined,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

function mapApp(r: Record<string, unknown>): DbScmApp {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    provider: String(r.provider),
    authMode: String(r.auth_mode ?? "github_app"),
    appId: r.app_id ? String(r.app_id) : undefined,
    clientId: r.client_id ? String(r.client_id) : undefined,
    clientSecretRef: r.client_secret_ref ? String(r.client_secret_ref) : undefined,
    privateKeyRef: r.private_key_ref ? String(r.private_key_ref) : undefined,
    webhookSecretRef: r.webhook_secret_ref ? String(r.webhook_secret_ref) : undefined,
    baseUrl: r.base_url ? String(r.base_url) : undefined,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}
