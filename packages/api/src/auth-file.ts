/**
 * File-backed auth when DATABASE_URL is unset.
 * Path: `.steward-data/users.json` (override via USERS_STORE_PATH / STEW_DATA_DIR).
 *
 * Password hashes: scrypt via node:crypto (format scrypt$N$r$p$salt$key).
 * Session tokens are stored as SHA-256 hashes only.
 */
import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId, nowIso } from "@codesteward/core";

function scryptAsync(
  password: string,
  salt: Buffer | string,
  keylen: number,
  options?: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, derived?: Buffer) => {
      if (err || !derived) reject(err ?? new Error("scrypt failed"));
      else resolve(derived);
    };
    if (options) {
      scrypt(password, salt, keylen, options, cb);
    } else {
      scrypt(password, salt, keylen, cb);
    }
  });
}

export type UserRole = "admin" | "reviewer" | "viewer";

export interface StewardUser {
  id: string;
  email: string;
  passwordHash: string;
  displayName?: string;
  role: UserRole;
  orgId: string;
  /** Install-wide platform operator (not tenant org admin). */
  platformAdmin?: boolean;
  /** SCIM / directory active flag (false = deprovisioned). */
  active?: boolean;
  externalId?: string;
  scimMeta?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface AuthFileData {
  users: StewardUser[];
  sessions: AuthSessionRecord[];
}

function dataDir(): string {
  return process.env.STEW_DATA_DIR ?? ".steward-data";
}

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, KEYLEN, { N, r, p })) as Buffer;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    // New format
    if (stored.startsWith("scrypt$")) {
      const parts = stored.split("$");
      if (parts.length !== 6) return false;
      const n = Number(parts[1]);
      const rr = Number(parts[2]);
      const pp = Number(parts[3]);
      const salt = Buffer.from(parts[4]!, "base64");
      const expected = Buffer.from(parts[5]!, "base64");
      const key = (await scryptAsync(password, salt, expected.length, {
        N: n,
        r: rr,
        p: pp,
      })) as Buffer;
      return key.length === expected.length && timingSafeEqual(key, expected);
    }
    // Legacy salt:hash (hex) from earlier auth-store
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const next = (await scryptAsync(password, salt, 64)) as Buffer;
    const prev = Buffer.from(hash, "hex");
    return next.length === prev.length && timingSafeEqual(next, prev);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function publicUser(user: StewardUser): {
  id: string;
  email: string;
  displayName?: string;
  role: UserRole;
  orgId: string;
  platformAdmin?: boolean;
  createdAt: string;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    orgId: user.orgId,
    platformAdmin: Boolean(user.platformAdmin),
    createdAt: user.createdAt,
  };
}

export class FileAuthStore {
  private data: AuthFileData = { users: [], sessions: [] };
  private loaded = false;
  readonly path: string;

  constructor(filePath?: string) {
    this.path =
      filePath ??
      process.env.USERS_STORE_PATH ??
      process.env.AUTH_STORE_PATH ??
      `${dataDir()}/users.json`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<AuthFileData> & {
        // migrate from auth.json shape if present
        users?: Array<StewardUser & { name?: string }>;
      };
      this.data = {
        users: (parsed.users ?? []).map((u) => ({
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          displayName: u.displayName ?? (u as { name?: string }).name,
          role: (String(u.role) === "member" ? "reviewer" : u.role) as UserRole,
          orgId: u.orgId ?? "local",
          platformAdmin: Boolean((u as { platformAdmin?: boolean }).platformAdmin),
          active: (u as { active?: boolean }).active !== false,
          externalId: (u as { externalId?: string }).externalId,
          scimMeta: (u as { scimMeta?: Record<string, unknown> }).scimMeta,
          createdAt: u.createdAt,
          updatedAt: (u as { updatedAt?: string }).updatedAt,
        })),
        sessions: Array.isArray(parsed.sessions)
          ? parsed.sessions.map((s) => {
              // Migrate plaintext token → hash if needed
              const rec = s as AuthSessionRecord & { token?: string };
              if (rec.token && !rec.tokenHash) {
                return {
                  id: rec.id ?? createId("ase"),
                  userId: rec.userId,
                  tokenHash: hashToken(rec.token),
                  expiresAt: rec.expiresAt,
                  createdAt: rec.createdAt ?? nowIso(),
                };
              }
              return rec as AuthSessionRecord;
            })
          : [],
      };
    } catch {
      this.data = { users: [], sessions: [] };
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data, null, 2), "utf8");
  }

  async count(): Promise<number> {
    await this.load();
    return this.data.users.length;
  }

  userCountSync(): number {
    return this.data.users.length;
  }

  async getById(id: string): Promise<StewardUser | undefined> {
    await this.load();
    return this.data.users.find((u) => u.id === id);
  }

  async getByEmail(email: string): Promise<StewardUser | undefined> {
    await this.load();
    const e = email.trim().toLowerCase();
    return this.data.users.find((u) => u.email === e);
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
    await this.load();
    const email = input.email.trim().toLowerCase();
    if (this.data.users.some((u) => u.email === email)) {
      throw new Error("email already registered");
    }
    if (
      input.externalId &&
      this.data.users.some((u) => u.externalId === input.externalId)
    ) {
      throw new Error("externalId already registered");
    }
    const user: StewardUser = {
      id: input.id ?? createId("usr"),
      email,
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
    this.data.users.push(user);
    await this.save();
    return user;
  }

  async getByExternalId(externalId: string): Promise<StewardUser | undefined> {
    await this.load();
    return this.data.users.find((u) => u.externalId === externalId);
  }

  async deleteUser(id: string): Promise<boolean> {
    await this.load();
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
    if (this.data.users.length === before) return false;
    await this.save();
    return true;
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    await this.load();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId);
    const n = before - this.data.sessions.length;
    if (n > 0) await this.save();
    return n;
  }

  async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<AuthSessionRecord> {
    await this.load();
    const session: AuthSessionRecord = {
      id: createId("ase"),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: nowIso(),
    };
    this.data.sessions.push(session);
    await this.save();
    return session;
  }

  async getSessionByTokenHash(
    tokenHash: string,
  ): Promise<(AuthSessionRecord & { user: StewardUser }) | undefined> {
    await this.load();
    const now = Date.now();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(
      (s) => new Date(s.expiresAt).getTime() >= now,
    );
    if (this.data.sessions.length !== before) await this.save();
    const session = this.data.sessions.find((s) => s.tokenHash === tokenHash);
    if (!session) return undefined;
    const user = this.data.users.find((u) => u.id === session.userId);
    if (!user) return undefined;
    return { ...session, user };
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<boolean> {
    await this.load();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== tokenHash);
    if (this.data.sessions.length === before) return false;
    await this.save();
    return true;
  }

  async list(orgId?: string): Promise<StewardUser[]> {
    await this.load();
    let users = [...this.data.users];
    if (orgId) users = users.filter((u) => u.orgId === orgId);
    return users;
  }

  async updateUser(
    id: string,
    patch: {
      role?: UserRole;
      displayName?: string | null;
      email?: string;
      orgId?: string;
      passwordHash?: string;
      platformAdmin?: boolean;
      active?: boolean;
      externalId?: string | null;
      scimMeta?: Record<string, unknown> | null;
    },
  ): Promise<StewardUser | undefined> {
    await this.load();
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return undefined;
    if (patch.role) u.role = patch.role;
    if (patch.displayName !== undefined) {
      u.displayName =
        patch.displayName === null || patch.displayName === ""
          ? undefined
          : patch.displayName;
    }
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!email.includes("@")) {
        throw Object.assign(new Error("invalid email"), { status: 400 });
      }
      const clash = this.data.users.find(
        (x) => x.id !== id && x.email.toLowerCase() === email,
      );
      if (clash) {
        throw Object.assign(new Error("email already in use"), { status: 409 });
      }
      u.email = email;
    }
    if (patch.orgId) u.orgId = patch.orgId;
    if (patch.passwordHash) u.passwordHash = patch.passwordHash;
    if (patch.platformAdmin !== undefined) u.platformAdmin = patch.platformAdmin;
    if (patch.active !== undefined) u.active = patch.active;
    if (patch.externalId !== undefined) {
      u.externalId =
        patch.externalId === null || patch.externalId === ""
          ? undefined
          : patch.externalId;
    }
    if (patch.scimMeta !== undefined) {
      u.scimMeta = patch.scimMeta === null ? undefined : patch.scimMeta;
    }
    u.updatedAt = nowIso();
    await this.save();
    return u;
  }
}

let shared: FileAuthStore | undefined;
export function getFileAuthStore(): FileAuthStore {
  if (!shared) shared = new FileAuthStore();
  return shared;
}
