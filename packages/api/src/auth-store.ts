/**
 * Auth store facade: Postgres when DATABASE_URL is set, else file (users.json).
 */
import { randomBytes } from "node:crypto";
import {
  isDatabaseEnabled,
  tryCreateStewardDb,
  type StewardUser as DbUser,
  type UserRole as DbRole,
  type UsersRepository,
} from "@codesteward/db";
import {
  FileAuthStore,
  generateSessionToken,
  getFileAuthStore,
  hashPassword,
  hashToken,
  publicUser,
  verifyPassword,
  type StewardUser,
  type UserRole,
} from "./auth-file.js";

export type AuthRole = UserRole;
export type { StewardUser, UserRole };

export type AuthMode = "open" | "api_key" | "users";

export interface PublicAuthUser {
  id: string;
  email: string;
  displayName?: string;
  /** @deprecated use displayName */
  name?: string;
  role: UserRole;
  orgId: string;
  /** Install-wide platform operator (license / runtime). Not tenant org admin. */
  platformAdmin?: boolean;
  createdAt: string;
}

const SESSION_TTL_MS = () => {
  const hours = Number(process.env.STEW_SESSION_TTL_HOURS ?? 24 * 14);
  return hours * 3600_000;
};

type Backend = UsersRepository | FileAuthStore;

function toPublic(u: StewardUser | DbUser): PublicAuthUser {
  const p = publicUser(u as StewardUser);
  return {
    ...p,
    platformAdmin: Boolean(
      (u as StewardUser).platformAdmin ?? (p as { platformAdmin?: boolean }).platformAdmin,
    ),
    name: p.displayName ?? p.email.split("@")[0],
  };
}

export class AuthStore {
  private backend: Backend | undefined;
  private file: FileAuthStore;

  constructor(filePath?: string) {
    this.file = filePath ? new FileAuthStore(filePath) : getFileAuthStore();
  }

  private getBackend(): Backend {
    if (this.backend) return this.backend;
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          this.backend = db.users;
          return this.backend;
        }
      } catch (err) {
        console.warn("[auth] DATABASE_URL set but pool failed; using file store", err);
      }
    }
    this.backend = this.file;
    return this.backend;
  }

  async ensureLoaded(): Promise<void> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) await b.load();
  }

  /** Alias for server startup. */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  async userCount(): Promise<number> {
    return this.getBackend().count();
  }

  /** Sync count after ensureLoaded (file) — prefer async userCount. */
  userCountSync(): number {
    return this.file.userCountSync();
  }

  bootstrapRequired(): boolean {
    // May be stale until ensureLoaded; callers should await ensureLoaded first
    return this.file.userCountSync() === 0 && !(this.backend && !(this.backend instanceof FileAuthStore));
  }

  async isBootstrapRequired(): Promise<boolean> {
    return (await this.getBackend().count()) === 0;
  }

  authRequired(): boolean {
    // Prefer calling async status; this is best-effort after ensureLoaded
    if (process.env.STEW_API_KEY) return true;
    if (this.file.userCountSync() > 0) return true;
    return false;
  }

  async getStatus(): Promise<{
    mode: AuthMode;
    hasUsers: boolean;
    bootstrapRequired: boolean;
    authRequired: boolean;
    hint: string;
    oidc: { status: string; issuer?: string };
  }> {
    await this.ensureLoaded();
    const n = await this.getBackend().count();
    const hasUsers = n > 0;
    const apiKey = Boolean(process.env.STEW_API_KEY);
    let mode: AuthMode;
    if (hasUsers) mode = "users";
    else if (apiKey) mode = "api_key";
    else mode = "open";

    const bootstrapRequired = !hasUsers;
    const authRequired = hasUsers || apiKey;

    let hint: string;
    if (mode === "open") {
      hint =
        "No users and STEW_API_KEY unset — open (dev). POST /v1/auth/bootstrap creates the first admin.";
    } else if (mode === "api_key") {
      hint =
        "Send Authorization: Bearer <STEW_API_KEY>. Optional: bootstrap users via POST /v1/auth/bootstrap.";
    } else {
      hint =
        "User auth enabled. Login via POST /v1/auth/login or use STEW_API_KEY as service credential.";
    }

    // Real OIDC status via discovery + JWKS (not a stub)
    let oidc: { status: string; issuer?: string; error?: string } = {
      status: "optional_not_configured",
    };
    try {
      const { getOidcStatus } = await import("./auth/oidc.js");
      oidc = await getOidcStatus();
    } catch (err) {
      oidc = {
        status: "misconfigured",
        issuer: process.env.OIDC_ISSUER,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      mode,
      hasUsers,
      bootstrapRequired,
      authRequired,
      hint,
      oidc,
    };
  }

  async bootstrap(input: {
    email: string;
    password: string;
    displayName?: string;
    name?: string;
    orgId?: string;
  }): Promise<{ user: PublicAuthUser; token: string }> {
    const n = await this.getBackend().count();
    if (n > 0) throw Object.assign(new Error("bootstrap already completed"), { status: 409 });
    const email = input.email?.trim() ?? "";
    if (!email || !input.password || input.password.length < 8) {
      throw Object.assign(
        new Error("email and password (min 8 chars) required"),
        { status: 400 },
      );
    }
    const passwordHash = await hashPassword(input.password);
    const user = await this.getBackend().create({
      email,
      passwordHash,
      displayName: input.displayName ?? input.name,
      role: "admin" as DbRole,
      orgId: input.orgId ?? "local",
      // First install user is platform operator (tenant admins created later are not)
      platformAdmin: true,
    });
    // keep file count in sync for bootstrapRequired sync helpers
    if (!(this.getBackend() instanceof FileAuthStore)) {
      /* db path */
    } else {
      /* file already saved */
    }
    return this.issueSession(user as StewardUser);
  }

  async login(input: {
    email: string;
    password: string;
  }): Promise<{ user: PublicAuthUser; token: string }> {
    if (!input.email?.trim() || !input.password) {
      throw Object.assign(new Error("email and password required"), { status: 400 });
    }
    const user = await this.getBackend().getByEmail(input.email);
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw Object.assign(new Error("invalid email or password"), { status: 401 });
    }
    if ((user as StewardUser).active === false) {
      throw Object.assign(new Error("account deactivated"), { status: 403 });
    }
    return this.issueSession(user as StewardUser);
  }

  private async issueSession(
    user: StewardUser,
  ): Promise<{ user: PublicAuthUser; token: string }> {
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS()).toISOString();
    await this.getBackend().createSession({
      userId: user.id,
      tokenHash,
      expiresAt,
    });
    return { user: toPublic(user), token };
  }

  async logout(token: string): Promise<boolean> {
    if (!token || token === process.env.STEW_API_KEY) return false;
    return this.getBackend().deleteSessionByTokenHash(hashToken(token));
  }

  async resolveToken(token: string): Promise<PublicAuthUser | null> {
    const found = await this.getBackend().getSessionByTokenHash(hashToken(token));
    if (!found) return null;
    if ((found.user as StewardUser).active === false) {
      await this.getBackend().deleteSessionByTokenHash(hashToken(token));
      return null;
    }
    return toPublic(found.user as StewardUser);
  }

  resolveApiKey(token: string): PublicAuthUser | null {
    const key = process.env.STEW_API_KEY;
    if (!key || token !== key) return null;
    return {
      id: "api_key",
      email: "api-key@local",
      displayName: "API Key",
      name: "API Key",
      role: "admin",
      orgId: "local",
      platformAdmin: true,
      createdAt: new Date(0).toISOString(),
    };
  }

  async listUsers(orgId?: string): Promise<PublicAuthUser[]> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) {
      return (await b.list(orgId)).map((u) => toPublic(u));
    }
    // UsersRepository
    const users = await (b as UsersRepository).list(orgId);
    return users.map((u) => toPublic(u as StewardUser));
  }

  async updateUser(
    id: string,
    patch: {
      role?: UserRole;
      displayName?: string | null;
      email?: string;
      orgId?: string;
      passwordHash?: string;
      active?: boolean;
      externalId?: string | null;
      scimMeta?: Record<string, unknown> | null;
    },
  ): Promise<PublicAuthUser | undefined> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) {
      const u = await b.updateUser(id, patch);
      if (u && patch.active === false) {
        await b.deleteSessionsForUser(id);
      }
      return u ? toPublic(u) : undefined;
    }
    const repo = b as UsersRepository;
    if (patch.email) {
      const email = patch.email.trim().toLowerCase();
      const existing = await repo.getByEmail(email);
      if (existing && existing.id !== id) {
        throw Object.assign(new Error("email already in use"), { status: 409 });
      }
    }
    const updated = await repo.update(id, {
      role: patch.role,
      displayName: patch.displayName,
      email: patch.email,
      orgId: patch.orgId,
      passwordHash: patch.passwordHash,
      active: patch.active,
      externalId: patch.externalId,
      scimMeta: patch.scimMeta,
    });
    if (updated && patch.active === false) {
      await repo.deleteSessionsForUser(id);
    }
    return updated ? toPublic(updated as StewardUser) : undefined;
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) {
      await b.deleteSessionsForUser(userId);
      return;
    }
    await (b as UsersRepository).deleteSessionsForUser(userId);
  }

  async getUserById(id: string): Promise<StewardUser | undefined> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) return b.getById(id);
    return (b as UsersRepository).getById(id);
  }

  async getUserByEmail(email: string): Promise<StewardUser | undefined> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) return b.getByEmail(email);
    return (b as UsersRepository).getByEmail(email);
  }

  async getUserByExternalId(externalId: string): Promise<StewardUser | undefined> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) return b.getByExternalId(externalId);
    return (b as UsersRepository).getByExternalId(externalId);
  }

  async deleteUser(id: string): Promise<boolean> {
    const b = this.getBackend();
    if (b instanceof FileAuthStore) return b.deleteUser(id);
    return (b as UsersRepository).delete(id);
  }

  async createUserRaw(input: {
    id?: string;
    email: string;
    password?: string;
    passwordHash?: string;
    displayName?: string;
    role: UserRole;
    orgId?: string;
    active?: boolean;
    externalId?: string;
    scimMeta?: Record<string, unknown>;
  }): Promise<StewardUser> {
    const passwordHash =
      input.passwordHash ??
      (await hashPassword(
        input.password ?? `scim:${randomBytes(24).toString("hex")}`,
      ));
    const user = await this.getBackend().create({
      id: input.id,
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      role: input.role as DbRole,
      orgId: input.orgId ?? "local",
      active: input.active,
      externalId: input.externalId,
      scimMeta: input.scimMeta,
    } as never);
    return user as StewardUser;
  }

  /** Self-service profile update (display name / email). */
  async updateOwnProfile(
    userId: string,
    patch: { displayName?: string; email?: string },
  ): Promise<PublicAuthUser> {
    if (userId === "api_key") {
      throw Object.assign(new Error("API key principal has no editable profile"), {
        status: 400,
      });
    }
    const updated = await this.updateUser(userId, {
      displayName: patch.displayName,
      email: patch.email,
    });
    if (!updated) {
      throw Object.assign(new Error("user not found"), { status: 404 });
    }
    return updated;
  }

  /** Self-service password change — requires current password. */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (userId === "api_key") {
      throw Object.assign(new Error("API key principal has no password"), { status: 400 });
    }
    if (!newPassword || newPassword.length < 8) {
      throw Object.assign(new Error("new password must be at least 8 characters"), {
        status: 400,
      });
    }
    const b = this.getBackend();
    const user =
      b instanceof FileAuthStore
        ? await b.getById(userId)
        : await (b as UsersRepository).getById(userId);
    if (!user) {
      throw Object.assign(new Error("user not found"), { status: 404 });
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw Object.assign(new Error("current password is incorrect"), { status: 401 });
    }
    const passwordHash = await hashPassword(newPassword);
    await this.updateUser(userId, { passwordHash });
    if (!(b instanceof FileAuthStore)) {
      await (b as UsersRepository).deleteSessionsForUser(userId);
    }
  }

  async createUser(input: {
    email: string;
    password: string;
    displayName?: string;
    role: UserRole;
    orgId?: string;
  }): Promise<PublicAuthUser> {
    const passwordHash = await hashPassword(input.password);
    const user = await this.getBackend().create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      role: input.role as DbRole,
      orgId: input.orgId ?? "local",
    });
    return toPublic(user as StewardUser);
  }

  /**
   * JIT provision from OIDC claims. Password is random unusable hash.
   */
  async findOrCreateFromOidc(input: {
    email: string;
    displayName?: string;
    roleHint?: UserRole;
    orgId?: string;
    subject: string;
  }): Promise<{ user: PublicAuthUser; token: string; created: boolean }> {
    const email = input.email.trim().toLowerCase();
    if (!email) {
      throw Object.assign(new Error("OIDC token missing email claim"), { status: 400 });
    }
    let user = await this.getBackend().getByEmail(email);
    let created = false;
    if (!user) {
      const passwordHash = await hashPassword(
        `oidc:${input.subject}:${randomBytes(16).toString("hex")}`,
      );
      user = await this.getBackend().create({
        email,
        passwordHash,
        displayName: input.displayName,
        role: (input.roleHint ?? "reviewer") as DbRole,
        // Empty home org until onboarding / invite (SaaS multi-tenant)
        orgId: input.orgId?.trim() || "",
      });
      created = true;
    }
    const session = await this.issueSession(user as StewardUser);
    return { ...session, created };
  }
}

export const globalAuthStore = new AuthStore();
