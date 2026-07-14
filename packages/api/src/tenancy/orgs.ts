/**
 * Multi-org tenancy store (file-backed; Postgres path when DATABASE_URL set via TenancyRepository).
 * Membership is the access control boundary — never trust client X-Org-Id alone.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decryptSecret, encryptSecret, maskSecret } from "../secrets.js";

export type OrgRole = "owner" | "admin" | "reviewer" | "viewer";

export interface ProductOrg {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface OrgMembership {
  orgId: string;
  userId: string;
  role: OrgRole;
  createdAt: string;
}

export interface OrgInvitation {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  token: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
}

export interface ScmInstallation {
  id: string;
  tenantId: string;
  orgId: string;
  provider: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  baseUrl?: string;
  status: "active" | "suspended" | "deleted";
  authMode: "github_app" | "pat_legacy" | "gitlab_oauth" | "oauth_app";
  repositorySelection?: string;
  permissions?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubAppConfig {
  provider: "github";
  authMode: "github_app";
  appId: string;
  clientId?: string;
  /** Encrypted PEM or secret-ref string */
  privateKeyPem?: string;
  privateKeyRef?: string;
  webhookSecret?: string;
  baseUrl?: string;
  slug?: string;
  /** Product org that owns this app registration (self-host often "local") */
  orgId?: string;
  updatedAt: string;
}

const dataDir = () => process.env.STEW_DATA_DIR ?? ".steward-data";

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function roleRank(role: OrgRole): number {
  switch (role) {
    case "owner":
      return 4;
    case "admin":
      return 3;
    case "reviewer":
      return 2;
    case "viewer":
      return 1;
    default:
      return 0;
  }
}

export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/** File-backed multi-org store. */
export class TenancyStore {

  private async tryDb(): Promise<import("@codesteward/db").TenancyRepository | null> {
    try {
      const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
      if (!isDatabaseEnabled()) {
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
          throw new Error("STEW_REQUIRE_PG_TENANCY=1 but DATABASE_URL is not set");
        }
        return null;
      }
      const db = tryCreateStewardDb();
      if (!db?.tenancy && process.env.STEW_REQUIRE_PG_TENANCY === "1") {
        throw new Error("STEW_REQUIRE_PG_TENANCY=1 but tenancy repository unavailable");
      }
      return db?.tenancy ?? null;
    } catch (err) {
      if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      return null;
    }
  }

  private orgsFile = join(dataDir(), "organizations.json");
  private membersFile = join(dataDir(), "org_members.json");
  private invitesFile = join(dataDir(), "org_invitations.json");
  private installsFile = join(dataDir(), "scm_installations.json");
  private appsFile = join(dataDir(), "scm_apps.json");
  /** Org-scoped credential vault — never global process.env in multi-org */
  private secretsFile = join(dataDir(), "org_scm_secrets.json");

  async ensureDefaults() {
    const orgs = await this.listOrgs();
    if (!orgs.length) {
      const org: ProductOrg = {
        id: "local",
        tenantId: "local",
        name: "Local",
        slug: "local",
        createdAt: new Date().toISOString(),
      };
      await writeJson(this.orgsFile, [org]);
    }
  }

  async listOrgs(): Promise<ProductOrg[]> {
    const db = await this.tryDb();
    if (db) {
      try {
        const rows = await db.listOrgs();
        if (rows.length) {
          return rows.map((r) => ({
            id: r.id,
            tenantId: r.tenantId,
            name: r.name,
            slug: r.slug,
            createdAt: r.createdAt,
          }));
        }
      } catch (err) {
        console.warn("[tenancy] postgres listOrgs failed, file fallback", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    } else if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
      throw new Error("STEW_REQUIRE_PG_TENANCY=1 requires DATABASE_URL");
    }
    return readJson(this.orgsFile, [] as ProductOrg[]);
  }

  async getOrg(orgId: string): Promise<ProductOrg | undefined> {
    return (await this.listOrgs()).find((o) => o.id === orgId);
  }

  async updateOrg(
    orgId: string,
    patch: { name?: string; slug?: string },
  ): Promise<ProductOrg> {
    const cur = await this.getOrg(orgId);
    if (!cur) {
      throw Object.assign(new Error("org not found"), { status: 404 });
    }
    const name = patch.name?.trim() || cur.name;
    if (!name) {
      throw Object.assign(new Error("name required"), { status: 400 });
    }
    let slug = patch.slug?.trim();
    if (patch.name && !patch.slug) {
      slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    }
    slug = slug || cur.slug;
    const orgs = await this.listOrgs();
    if (
      orgs.some(
        (o) =>
          o.id !== orgId &&
          o.slug === slug &&
          o.tenantId === cur.tenantId,
      )
    ) {
      throw Object.assign(new Error(`org slug already exists: ${slug}`), { status: 409 });
    }
    const next: ProductOrg = { ...cur, name, slug };
    const db = await this.tryDb();
    if (db) {
      try {
        await db.updateOrg(orgId, { name, slug });
      } catch (err) {
        console.warn("[tenancy] postgres updateOrg failed, file fallback", err);
      }
    }
    const fileOrgs = await readJson(this.orgsFile, [] as ProductOrg[]);
    const idx = fileOrgs.findIndex((o) => o.id === orgId);
    if (idx >= 0) {
      fileOrgs[idx] = next;
    } else {
      // Ensure default "local" and new orgs are renameable even if only in DB list
      fileOrgs.push(next);
    }
    await writeJson(this.orgsFile, fileOrgs);
    return next;
  }

  async createOrg(input: {
    name: string;
    slug?: string;
    tenantId?: string;
    ownerUserId?: string;
  }): Promise<ProductOrg> {
    const orgs = await this.listOrgs();
    const slug =
      input.slug ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    if (orgs.some((o) => o.slug === slug && o.tenantId === (input.tenantId ?? "local"))) {
      throw Object.assign(new Error(`org slug already exists: ${slug}`), { status: 409 });
    }
    const org: ProductOrg = {
      id: `org_${randomBytes(6).toString("hex")}`,
      tenantId: input.tenantId ?? "local",
      name: input.name,
      slug,
      createdAt: new Date().toISOString(),
    };
    const db = await this.tryDb();
    if (db) {
      try {
        await db.createOrg(org);
      } catch (err) {
        console.warn("[tenancy] postgres createOrg failed, file fallback", err);
        orgs.push(org);
        await writeJson(this.orgsFile, orgs);
      }
    } else {
      orgs.push(org);
      await writeJson(this.orgsFile, orgs);
    }
    if (input.ownerUserId) {
      await this.upsertMember({
        orgId: org.id,
        userId: input.ownerUserId,
        role: "owner",
      });
    }
    return org;
  }

  async listMembers(orgId: string): Promise<OrgMembership[]> {
    const db = await this.tryDb();
    if (db) {
      try {
        const rows = await db.listMembers(orgId);
        if (rows.length || true) {
          return rows.map((r) => ({
            orgId: r.orgId,
            userId: r.userId,
            role: r.role as OrgRole,
            createdAt: r.createdAt,
          }));
        }
      } catch (err) {
        console.warn("[tenancy] postgres listMembers failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    } else if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
      throw new Error("STEW_REQUIRE_PG_TENANCY=1 requires DATABASE_URL");
    }
    const all = await readJson(this.membersFile, [] as OrgMembership[]);
    return all.filter((m) => m.orgId === orgId);
  }

  async listMembershipsForUser(userId: string): Promise<OrgMembership[]> {
    const db = await this.tryDb();
    if (db) {
      try {
        const rows = await db.listMembershipsForUser(userId);
        return rows.map((r) => ({
          orgId: r.orgId,
          userId: r.userId,
          role: r.role as OrgRole,
          createdAt: r.createdAt,
        }));
      } catch (err) {
        console.warn("[tenancy] postgres listMembershipsForUser failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    } else if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
      throw new Error("STEW_REQUIRE_PG_TENANCY=1 requires DATABASE_URL");
    }
    const all = await readJson(this.membersFile, [] as OrgMembership[]);
    return all.filter((m) => m.userId === userId);
  }

  async listOrgsForUser(userId: string): Promise<Array<ProductOrg & { role: OrgRole }>> {
    await this.ensureDefaults();
    const memberships = await this.listMembershipsForUser(userId);
    const orgs = await this.listOrgs();
    // Bootstrap auto-join disabled under STEW_AUTH_STRICT / production
    const strict =
      process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production";
    if (!strict && !memberships.length && userId && userId !== "api_key") {
      const local = orgs.find((o) => o.id === "local");
      if (local) {
        await this.upsertMember({ orgId: "local", userId, role: "admin" });
        return [{ ...local, role: "admin" }];
      }
    }
    const byId = new Map(orgs.map((o) => [o.id, o]));
    return memberships
      .map((m) => {
        const o = byId.get(m.orgId);
        return o ? { ...o, role: m.role } : null;
      })
      .filter(Boolean) as Array<ProductOrg & { role: OrgRole }>;
  }

  async getMembership(orgId: string, userId: string): Promise<OrgMembership | undefined> {
    const db = await this.tryDb();
    if (db) {
      try {
        const r = await db.getMembership(orgId, userId);
        if (r) {
          return {
            orgId: r.orgId,
            userId: r.userId,
            role: r.role as OrgRole,
            createdAt: r.createdAt,
          };
        }
        // fall through to file for dual-write windows
      } catch (err) {
        console.warn("[tenancy] postgres getMembership failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    } else if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
      throw new Error("STEW_REQUIRE_PG_TENANCY=1 requires DATABASE_URL");
    }
    const all = await readJson(this.membersFile, [] as OrgMembership[]);
    return all.find((m) => m.orgId === orgId && m.userId === userId);
  }

  async upsertMember(input: {
    orgId: string;
    userId: string;
    role: OrgRole;
  }): Promise<OrgMembership> {
    const row: OrgMembership = {
      orgId: input.orgId,
      userId: input.userId,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    const db = await this.tryDb();
    if (db) {
      try {
        await db.upsertMember(input);
      } catch (err) {
        console.warn("[tenancy] postgres upsertMember failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    } else if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
      throw new Error("STEW_REQUIRE_PG_TENANCY=1 requires DATABASE_URL");
    }
    const all = await readJson(this.membersFile, [] as OrgMembership[]);
    const idx = all.findIndex((m) => m.orgId === input.orgId && m.userId === input.userId);
    if (idx >= 0) {
      row.createdAt = all[idx]!.createdAt;
      all[idx] = row;
    } else all.push(row);
    await writeJson(this.membersFile, all);
    return row;
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    const db = await this.tryDb();
    if (db) {
      try {
        await db.removeMember(orgId, userId);
      } catch (err) {
        console.warn("[tenancy] removeMember PG failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    }
    const all = await readJson(this.membersFile, [] as OrgMembership[]);
    const next = all.filter((m) => !(m.orgId === orgId && m.userId === userId));
    if (next.length === all.length && !db) return false;
    await writeJson(this.membersFile, next);
    return true;
  }

  /**
   * Assert user may access org. API keys and dev_open bypass with caveats.
   * @throws status 403
   */
  async assertMembership(
    userId: string | undefined,
    orgId: string,
    opts?: {
      authMode?: string;
      minRole?: OrgRole;
      /** When true, api_key may access any org (legacy single-tenant key) */
      allowApiKeyAllOrgs?: boolean;
    },
  ): Promise<OrgMembership | { orgId: string; userId: string; role: OrgRole }> {
    const authMode = opts?.authMode;
    if (authMode === "dev_open") {
      return { orgId, userId: userId ?? "dev", role: "owner" };
    }
    if (authMode === "api_key" || userId === "api_key") {
      if (opts?.allowApiKeyAllOrgs !== false) {
        // Scoped API keys later: STEW_API_KEY only for org "local" unless STEW_API_KEY_ORGS=*
        const allowed = process.env.STEW_API_KEY_ORGS ?? "local";
        if (allowed !== "*" && !allowed.split(",").map((s) => s.trim()).includes(orgId)) {
          throw Object.assign(
            new Error(`API key not authorized for org ${orgId}`),
            { status: 403 },
          );
        }
        return { orgId, userId: "api_key", role: "admin" };
      }
    }
    if (!userId) {
      throw Object.assign(new Error("authentication required for org access"), { status: 401 });
    }
    await this.ensureDefaults();
    // Auto-bootstrap membership for first admin on local org
    let m = await this.getMembership(orgId, userId);
    const strict =
      process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production";
    if (!m && orgId === "local" && !strict) {
      const members = await this.listMembers("local");
      if (!members.length) {
        m = await this.upsertMember({ orgId: "local", userId, role: "admin" });
      }
    }
    if (!m) {
      throw Object.assign(new Error(`not a member of org ${orgId}`), { status: 403 });
    }
    if (opts?.minRole && !roleAtLeast(m.role, opts.minRole)) {
      throw Object.assign(
        new Error(`requires role ${opts.minRole} (have ${m.role})`),
        { status: 403 },
      );
    }
    return m;
  }

  async createInvitation(input: {
    orgId: string;
    email: string;
    role: OrgRole;
    invitedBy: string;
    ttlHours?: number;
  }): Promise<OrgInvitation> {
    const { createHash } = await import("node:crypto");
    const token = randomBytes(24).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const inv: OrgInvitation = {
      id: `inv_${randomBytes(6).toString("hex")}`,
      orgId: input.orgId,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      token,
      invitedBy: input.invitedBy,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + (input.ttlHours ?? 72) * 3600_000,
      ).toISOString(),
    };
    const db = await this.tryDb();
    if (db) {
      try {
        const { tryCreateStewardDb } = await import("@codesteward/db");
        const full = tryCreateStewardDb();
        if (full?.pool) {
          await full.pool.query(
            `INSERT INTO org_invitations (id, org_id, email, role, token_hash, invited_by, created_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [inv.id, inv.orgId, inv.email, inv.role, tokenHash, inv.invitedBy, inv.createdAt, inv.expiresAt],
          );
        }
      } catch (err) {
        console.warn("[tenancy] invitation PG failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    }
    const invites = await readJson(this.invitesFile, [] as OrgInvitation[]);
    invites.push(inv);
    await writeJson(this.invitesFile, invites);
    return inv;
  }

  async listInvitations(orgId: string): Promise<OrgInvitation[]> {
    const invites = await readJson(this.invitesFile, [] as OrgInvitation[]);
    return invites.filter((i) => i.orgId === orgId && !i.acceptedAt);
  }

  async acceptInvitation(token: string, userId: string, email: string): Promise<OrgMembership> {
    const { createHash } = await import("node:crypto");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const db = await this.tryDb();
    if (db) {
      try {
        const { tryCreateStewardDb } = await import("@codesteward/db");
        const full = tryCreateStewardDb();
        if (full?.pool) {
          const res = await full.pool.query(
            `SELECT id, org_id, email, role, expires_at, accepted_at
             FROM org_invitations WHERE token_hash = $1 LIMIT 1`,
            [tokenHash],
          );
          const row = res.rows[0] as
            | {
                id: string;
                org_id: string;
                email: string;
                role: string;
                expires_at: string | Date;
                accepted_at: string | Date | null;
              }
            | undefined;
          if (row) {
            if (row.accepted_at) {
              throw Object.assign(new Error("invitation already accepted"), { status: 409 });
            }
            if (new Date(row.expires_at).getTime() < Date.now()) {
              throw Object.assign(new Error("invitation expired"), { status: 410 });
            }
            if (row.email !== email.trim().toLowerCase()) {
              throw Object.assign(new Error("invitation email mismatch"), { status: 403 });
            }
            await full.pool.query(
              `UPDATE org_invitations SET accepted_at = now() WHERE id = $1`,
              [row.id],
            );
            return this.upsertMember({
              orgId: row.org_id,
              userId,
              role: row.role as OrgRole,
            });
          }
          if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
            throw Object.assign(new Error("invitation not found"), { status: 404 });
          }
        }
      } catch (err) {
        if ((err as { status?: number }).status) throw err;
        console.warn("[tenancy] acceptInvitation PG failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    }
    const invites = await readJson(this.invitesFile, [] as OrgInvitation[]);
    const inv = invites.find((i) => i.token === token && !i.acceptedAt);
    if (!inv) throw Object.assign(new Error("invitation not found"), { status: 404 });
    if (new Date(inv.expiresAt).getTime() < Date.now()) {
      throw Object.assign(new Error("invitation expired"), { status: 410 });
    }
    if (inv.email !== email.trim().toLowerCase()) {
      throw Object.assign(new Error("invitation email mismatch"), { status: 403 });
    }
    inv.acceptedAt = new Date().toISOString();
    await writeJson(this.invitesFile, invites);
    return this.upsertMember({ orgId: inv.orgId, userId, role: inv.role });
  }

  async listInstallations(orgId?: string): Promise<ScmInstallation[]> {
    const db = await this.tryDb();
    if (db) {
      try {
        await db.ensureSeed();
        const rows = await db.listInstallations(orgId);
        return rows.map((r) => ({
          id: r.id,
          tenantId: r.tenantId,
          orgId: r.orgId,
          provider: r.provider,
          installationId: r.installationId,
          accountLogin: r.accountLogin,
          accountType: r.accountType,
          baseUrl: r.baseUrl,
          status: r.status as ScmInstallation["status"],
          authMode: r.authMode as ScmInstallation["authMode"],
          repositorySelection: r.repositorySelection,
          permissions: r.permissions,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
      } catch (err) {
        console.warn("[tenancy] postgres listInstallations failed", err);
        if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
      }
    } else if (process.env.STEW_REQUIRE_PG_TENANCY === "1") {
      throw new Error("STEW_REQUIRE_PG_TENANCY=1 requires DATABASE_URL");
    }
    const all = await readJson(this.installsFile, [] as ScmInstallation[]);
    return orgId ? all.filter((i) => i.orgId === orgId) : all;
  }

  async upsertInstallation(
    input: Omit<ScmInstallation, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<ScmInstallation> {
    const db = await this.tryDb();
    if (db) {
      try {
        await db.ensureSeed();
        const r = await db.upsertInstallation({
          id: input.id,
          tenantId: input.tenantId,
          orgId: input.orgId,
          provider: input.provider,
          installationId: input.installationId,
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          baseUrl: input.baseUrl,
          status: input.status,
          authMode: input.authMode,
          repositorySelection: input.repositorySelection,
          permissions: input.permissions,
        });
        // dual-write file for offline tools
        await this.fileUpsertInstallation(input);
        return {
          id: r.id,
          tenantId: r.tenantId,
          orgId: r.orgId,
          provider: r.provider,
          installationId: r.installationId,
          accountLogin: r.accountLogin,
          accountType: r.accountType,
          baseUrl: r.baseUrl,
          status: r.status as ScmInstallation["status"],
          authMode: r.authMode as ScmInstallation["authMode"],
          repositorySelection: r.repositorySelection,
          permissions: r.permissions,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      } catch (err) {
        console.warn("[tenancy] postgres upsertInstallation failed", err);
        if (process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production") {
          throw err;
        }
      }
    }
    return this.fileUpsertInstallation(input);
  }

  private async fileUpsertInstallation(
    input: Omit<ScmInstallation, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<ScmInstallation> {
    const all = await readJson(this.installsFile, [] as ScmInstallation[]);
    const now = new Date().toISOString();
    const existing = all.find(
      (i) =>
        i.provider === input.provider &&
        i.installationId === input.installationId &&
        (i.baseUrl ?? "") === (input.baseUrl ?? ""),
    );
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      await writeJson(this.installsFile, all);
      return existing;
    }
    const row: ScmInstallation = {
      id: input.id ?? `inst_${randomBytes(6).toString("hex")}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    all.push(row);
    await writeJson(this.installsFile, all);
    return row;
  }

  async findInstallationByProviderId(
    provider: string,
    installationId: string,
  ): Promise<ScmInstallation | undefined> {
    const db = await this.tryDb();
    if (db) {
      try {
        const r = await db.findInstallationByProviderId(provider, installationId);
        if (r) {
          return {
            id: r.id,
            tenantId: r.tenantId,
            orgId: r.orgId,
            provider: r.provider,
            installationId: r.installationId,
            accountLogin: r.accountLogin,
            accountType: r.accountType,
            baseUrl: r.baseUrl,
            status: r.status as ScmInstallation["status"],
            authMode: r.authMode as ScmInstallation["authMode"],
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          };
        }
      } catch (err) {
        console.warn("[tenancy] findInstallation PG failed", err);
      }
    }
    const all = await readJson(this.installsFile, [] as ScmInstallation[]);
    return all.find(
      (i) => i.provider === provider && i.installationId === String(installationId),
    );
  }

  async suspendInstallation(provider: string, installationId: string): Promise<void> {
    const db = await this.tryDb();
    if (db) {
      try {
        await db.suspendInstallation(provider, installationId);
      } catch (err) {
        console.warn("[tenancy] suspendInstallation PG failed", err);
      }
    }
    const all = await readJson(this.installsFile, [] as ScmInstallation[]);
    let changed = false;
    for (const i of all) {
      if (i.provider === provider && i.installationId === String(installationId)) {
        i.status = "suspended";
        i.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await writeJson(this.installsFile, all);
  }

  async deleteInstallation(provider: string, installationId: string): Promise<void> {
    const db = await this.tryDb();
    if (db) {
      try {
        await db.deleteInstallation(provider, installationId);
      } catch (err) {
        console.warn("[tenancy] deleteInstallation PG failed", err);
      }
    }
    const all = await readJson(this.installsFile, [] as ScmInstallation[]);
    const next = all.filter(
      (i) => !(i.provider === provider && i.installationId === String(installationId)),
    );
    await writeJson(this.installsFile, next);
  }

  /**
   * Save GitHub App config. Secrets encrypted at rest.
   * Does NOT write PEMs to process.env (multi-tenant safe).
   * Optional single-tenant apply via applyToProcessEnv for legacy workers.
   */
  async saveGitHubAppConfig(
    cfg: {
      appId: string;
      clientId?: string;
      privateKeyPem?: string;
      privateKeyRef?: string;
      webhookSecret?: string;
      baseUrl?: string;
      slug?: string;
      orgId?: string;
    },
    opts?: { applyToProcessEnv?: boolean },
  ): Promise<GitHubAppConfig> {
    const row: GitHubAppConfig = {
      provider: "github",
      authMode: "github_app",
      appId: cfg.appId,
      clientId: cfg.clientId,
      privateKeyPem: cfg.privateKeyPem ? encryptSecret(cfg.privateKeyPem) : undefined,
      privateKeyRef: cfg.privateKeyRef,
      webhookSecret: cfg.webhookSecret ? encryptSecret(cfg.webhookSecret) : undefined,
      baseUrl: cfg.baseUrl,
      slug: cfg.slug,
      orgId: cfg.orgId ?? "local",
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.appsFile, row);

    // Also stash org-scoped vault
    const vault = await readJson(this.secretsFile, {} as Record<string, GitHubAppConfig>);
    vault[row.orgId ?? "local"] = row;
    await writeJson(this.secretsFile, vault);

    // Postgres scm_apps SoT (secret refs preferred; PEM stored as encrypted inline ref)
    const db = await this.tryDb();
    if (db) {
      try {
        await db.ensureSeed();
        const pemRef = row.privateKeyRef
          ?? (row.privateKeyPem ? `inline:enc:${row.privateKeyPem}` : undefined);
        await db.upsertScmApp({
          tenantId: "local",
          provider: "github",
          authMode: "github_app",
          appId: row.appId,
          clientId: row.clientId,
          privateKeyRef: pemRef,
          webhookSecretRef: row.webhookSecret
            ? `inline:enc:${row.webhookSecret}`
            : undefined,
          baseUrl: row.baseUrl,
          metadata: { orgId: row.orgId, slug: row.slug },
        });
      } catch (err) {
        console.warn("[tenancy] postgres scm_apps upsert failed", err);
        if (process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production") {
          if (process.env.STEW_REQUIRE_PG_TENANCY === "1") throw err;
        }
      }
    }

    if (opts?.applyToProcessEnv || process.env.STEW_APPLY_SCM_ENV === "1") {
      this.applyGitHubAppToEnv(row);
    }
    return row;
  }

  /** Resolve decrypted credentials for SCM factory (per-request). */
  resolveGitHubAppCredentials(cfg?: GitHubAppConfig | null): {
    appId: string;
    privateKey: string;
    baseUrl?: string;
    installationId?: string;
  } | null {
    const c = cfg;
    if (!c?.appId) return null;
    let privateKey: string | undefined;
    if (c.privateKeyRef?.startsWith("env:")) {
      privateKey = process.env[c.privateKeyRef.slice(4)];
    } else if (c.privateKeyRef?.startsWith("file:")) {
      /* caller may load file — leave empty */
      privateKey = undefined;
    } else if (c.privateKeyPem) {
      privateKey = decryptSecret(c.privateKeyPem);
    }
    if (!privateKey && process.env.GITHUB_APP_PRIVATE_KEY) {
      privateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
    }
    if (!privateKey) return null;
    return {
      appId: c.appId,
      privateKey: privateKey.replace(/\\n/g, "\n"),
      baseUrl: c.baseUrl,
    };
  }

  applyGitHubAppToEnv(cfg: GitHubAppConfig) {
    process.env.GITHUB_APP_ID = cfg.appId;
    const creds = this.resolveGitHubAppCredentials(cfg);
    if (creds?.privateKey) process.env.GITHUB_APP_PRIVATE_KEY = creds.privateKey;
    if (cfg.privateKeyRef) process.env.GITHUB_APP_PRIVATE_KEY_REF = cfg.privateKeyRef;
    if (cfg.baseUrl) process.env.GITHUB_API_URL = cfg.baseUrl;
    if (cfg.webhookSecret) {
      const wh = decryptSecret(cfg.webhookSecret);
      if (wh) process.env.GITHUB_WEBHOOK_SECRET = wh;
    }
  }

  async getGitHubAppConfig(orgId?: string): Promise<GitHubAppConfig | null> {
    const db = await this.tryDb();
    if (db) {
      try {
        const app = await db.getScmApp("github");
        if (app?.appId) {
          // Reconstruct from env refs + metadata
          let privateKeyPem: string | undefined;
          if (app.privateKeyRef?.startsWith("inline:enc:")) {
            privateKeyPem = app.privateKeyRef.slice("inline:enc:".length);
          } else if (app.privateKeyRef?.startsWith("env:")) {
            privateKeyPem = process.env[app.privateKeyRef.slice(4)];
          }
          const meta = app.metadata ?? {};
          return {
            provider: "github",
            authMode: "github_app",
            appId: app.appId,
            clientId: app.clientId,
            privateKeyPem,
            privateKeyRef: app.privateKeyRef?.startsWith("inline:")
              ? undefined
              : app.privateKeyRef,
            webhookSecret: app.webhookSecretRef?.startsWith("inline:enc:")
              ? app.webhookSecretRef.slice("inline:enc:".length)
              : undefined,
            baseUrl: app.baseUrl,
            slug: typeof meta.slug === "string" ? meta.slug : undefined,
            orgId: typeof meta.orgId === "string" ? meta.orgId : orgId,
            updatedAt: app.updatedAt,
          };
        }
      } catch (err) {
        console.warn("[tenancy] getGitHubAppConfig PG failed", err);
      }
    }
    if (orgId) {
      const vault = await readJson(this.secretsFile, {} as Record<string, GitHubAppConfig>);
      if (vault[orgId]) return vault[orgId]!;
    }
    // Env-only enterprise path (no PEM paste)
    if (process.env.GITHUB_APP_ID && (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_REF)) {
      return {
        provider: "github",
        authMode: "github_app",
        appId: process.env.GITHUB_APP_ID,
        privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY,
        privateKeyRef: process.env.GITHUB_APP_PRIVATE_KEY_REF,
        baseUrl: process.env.GITHUB_API_URL,
        slug: process.env.GITHUB_APP_SLUG,
        orgId: orgId ?? "local",
        updatedAt: new Date().toISOString(),
      };
    }
    return readJson(this.appsFile, null as GitHubAppConfig | null);
  }

  async getGitHubAppConfigPublic(orgId?: string): Promise<Record<string, unknown> | null> {
    const cfg = await this.getGitHubAppConfig(orgId);
    if (!cfg) return null;
    return {
      provider: cfg.provider,
      authMode: cfg.authMode,
      appId: cfg.appId,
      clientId: cfg.clientId,
      baseUrl: cfg.baseUrl,
      slug: cfg.slug,
      orgId: cfg.orgId,
      updatedAt: cfg.updatedAt,
      privateKeyConfigured: Boolean(cfg.privateKeyPem || cfg.privateKeyRef),
      webhookSecretConfigured: Boolean(cfg.webhookSecret),
      privateKeyLast4: cfg.privateKeyPem ? maskSecret(cfg.privateKeyPem) : null,
    };
  }

  /**
   * Drop GitHub App credentials + installations for an org (and optional connector mirror).
   */
  async clearGitHubAppConfig(orgId = "local"): Promise<{
    cleared: boolean;
    installationsRemoved: number;
  }> {
    const oid = orgId || "local";
    // File vault
    const vault = await readJson(this.secretsFile, {} as Record<string, GitHubAppConfig>);
    delete vault[oid];
    await writeJson(this.secretsFile, vault);
    // Legacy single-file apps store
    try {
      const single = await readJson(this.appsFile, null as GitHubAppConfig | null);
      if (single && (single.orgId ?? "local") === oid) {
        await writeJson(this.appsFile, null);
      }
    } catch {
      /* ignore */
    }

    let installationsRemoved = 0;
    const installs = await readJson(this.installsFile, [] as ScmInstallation[]);
    const nextInstalls = installs.filter(
      (i) => !(i.orgId === oid && i.provider === "github"),
    );
    installationsRemoved = installs.length - nextInstalls.length;
    await writeJson(this.installsFile, nextInstalls);

    const db = await this.tryDb();
    if (db) {
      try {
        await db.ensureSeed();
        await db.deleteScmApp("github", "local");
        const n = await db.deleteInstallationsForOrg(oid, "github");
        installationsRemoved = Math.max(installationsRemoved, n);
      } catch (err) {
        console.warn("[tenancy] clearGitHubAppConfig PG failed", err);
      }
    }

    // Clear process.env copies if they match this host's single-tenant apply
    if (process.env.GITHUB_APP_ID) {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_APP_PRIVATE_KEY_REF;
      delete process.env.GITHUB_APP_INSTALLATION_ID;
      delete process.env.GITHUB_APP_SLUG;
    }

    return { cleared: true, installationsRemoved };
  }
}

let singleton: TenancyStore | undefined;
export function getTenancyStore(): TenancyStore {
  if (!singleton) singleton = new TenancyStore();
  return singleton;
}

/** Test helper */
export function resetTenancyStoreForTests() {
  singleton = undefined;
}
