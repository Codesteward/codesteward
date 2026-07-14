import { createId, nowIso } from "@codesteward/core";
import type { Queryable } from "../client.js";
import type { AuthSession, StewardUser, UserRole } from "../types.js";
import { toIso } from "../util.js";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  org_id: string;
  platform_admin?: boolean | null;
  active?: boolean | null;
  external_id?: string | null;
  scim_meta?: unknown;
  created_at: Date | string;
  updated_at?: Date | string | null;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date | string;
  created_at: Date | string;
}

function mapUser(row: UserRow): StewardUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name ?? undefined,
    role: row.role as UserRole,
    orgId: row.org_id,
    platformAdmin: Boolean(row.platform_admin),
    active: row.active === undefined || row.active === null ? true : Boolean(row.active),
    externalId: row.external_id ?? undefined,
    scimMeta:
      row.scim_meta && typeof row.scim_meta === "object"
        ? (row.scim_meta as Record<string, unknown>)
        : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
  };
}

export function newUserId(): string {
  return createId("usr");
}

export function newAuthSessionId(): string {
  return createId("ase");
}

export class UsersRepository {
  constructor(private readonly db: Queryable) {}

  async count(): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users`,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async getById(id: string): Promise<StewardUser | undefined> {
    const res = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    const row = res.rows[0];
    return row ? mapUser(row) : undefined;
  }

  async getByEmail(email: string): Promise<StewardUser | undefined> {
    const res = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    const row = res.rows[0];
    return row ? mapUser(row) : undefined;
  }

  async list(orgId?: string): Promise<StewardUser[]> {
    if (orgId) {
      const res = await this.db.query<UserRow>(
        `SELECT * FROM users WHERE org_id = $1 ORDER BY created_at ASC`,
        [orgId],
      );
      return res.rows.map(mapUser);
    }
    const res = await this.db.query<UserRow>(
      `SELECT * FROM users ORDER BY created_at ASC`,
    );
    return res.rows.map(mapUser);
  }

  async getByExternalId(externalId: string): Promise<StewardUser | undefined> {
    const res = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE external_id = $1`,
      [externalId],
    );
    const row = res.rows[0];
    return row ? mapUser(row) : undefined;
  }

  async update(
    id: string,
    patch: {
      email?: string;
      displayName?: string | null;
      role?: UserRole;
      orgId?: string;
      passwordHash?: string;
      platformAdmin?: boolean;
      active?: boolean;
      externalId?: string | null;
      scimMeta?: Record<string, unknown> | null;
    },
  ): Promise<StewardUser | undefined> {
    const cur = await this.getById(id);
    if (!cur) return undefined;
    const next: StewardUser = {
      ...cur,
      email: patch.email !== undefined ? patch.email.trim().toLowerCase() : cur.email,
      displayName:
        patch.displayName === undefined
          ? cur.displayName
          : patch.displayName === null || patch.displayName === ""
            ? undefined
            : patch.displayName,
      role: patch.role ?? cur.role,
      orgId: patch.orgId ?? cur.orgId,
      passwordHash: patch.passwordHash ?? cur.passwordHash,
      platformAdmin:
        patch.platformAdmin !== undefined ? patch.platformAdmin : cur.platformAdmin,
      active: patch.active !== undefined ? patch.active : (cur.active ?? true),
      externalId:
        patch.externalId === undefined
          ? cur.externalId
          : patch.externalId === null || patch.externalId === ""
            ? undefined
            : patch.externalId,
      scimMeta:
        patch.scimMeta === undefined
          ? cur.scimMeta
          : patch.scimMeta === null
            ? undefined
            : patch.scimMeta,
      updatedAt: nowIso(),
    };
    await this.db.query(
      `UPDATE users SET email = $2, display_name = $3, role = $4, org_id = $5, password_hash = $6,
         platform_admin = $7, active = $8, external_id = $9, scim_meta = $10::jsonb
       WHERE id = $1`,
      [
        next.id,
        next.email,
        next.displayName ?? null,
        next.role,
        next.orgId,
        next.passwordHash,
        Boolean(next.platformAdmin),
        next.active !== false,
        next.externalId ?? null,
        JSON.stringify(next.scimMeta ?? {}),
      ],
    );
    return next;
  }

  async create(input: {
    id?: string;
    email: string;
    passwordHash: string;
    displayName?: string;
    role: UserRole;
    orgId?: string;
    platformAdmin?: boolean;
    active?: boolean;
    externalId?: string;
    scimMeta?: Record<string, unknown>;
  }): Promise<StewardUser> {
    const user: StewardUser = {
      id: input.id ?? newUserId(),
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      role: input.role,
      orgId: input.orgId ?? "local",
      platformAdmin: Boolean(input.platformAdmin),
      active: input.active !== false,
      externalId: input.externalId,
      scimMeta: input.scimMeta,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO users (id, email, password_hash, display_name, role, org_id, platform_admin, active, external_id, scim_meta, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        user.id,
        user.email,
        user.passwordHash,
        user.displayName ?? null,
        user.role,
        user.orgId,
        Boolean(user.platformAdmin),
        user.active !== false,
        user.externalId ?? null,
        JSON.stringify(user.scimMeta ?? {}),
        user.createdAt,
      ],
    );
    return user;
  }

  async delete(id: string): Promise<boolean> {
    await this.db.query(`DELETE FROM scim_group_members WHERE user_id = $1`, [id]);
    await this.db.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [id]);
    const res = await this.db.query(`DELETE FROM users WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async createSession(input: {
    id?: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<AuthSession> {
    const session: AuthSession = {
      id: input.id ?? newAuthSessionId(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.expiresAt,
        session.createdAt,
      ],
    );
    return session;
  }

  async getSessionByTokenHash(
    tokenHash: string,
  ): Promise<(AuthSession & { user: StewardUser }) | undefined> {
    const res = await this.db.query<AuthSessionRow>(
      `SELECT id, user_id, token_hash, expires_at, created_at
       FROM auth_sessions
       WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    if (new Date(toIso(row.expires_at)).getTime() < Date.now()) {
      await this.deleteSessionByTokenHash(tokenHash);
      return undefined;
    }
    const user = await this.getById(row.user_id);
    if (!user) {
      await this.deleteSessionByTokenHash(tokenHash);
      return undefined;
    }
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: toIso(row.expires_at),
      createdAt: toIso(row.created_at),
      user,
    };
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [
      tokenHash,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    const res = await this.db.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [
      userId,
    ]);
    return res.rowCount ?? 0;
  }

  async purgeExpiredSessions(): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM auth_sessions WHERE expires_at < now()`,
    );
    return res.rowCount ?? 0;
  }
}
