/**
 * Keycloak Admin API client — Codesteward multi-tenant identity SoT.
 *
 * Organizations are Keycloak groups under path /orgs/{slug}
 * Product roles are realm roles: steward-admin | steward-reviewer | steward-viewer
 *
 * Auth: client credentials (service account) on client KEYCLOAK_ADMIN_CLIENT_ID
 * (default: codesteward-api).
 */
import type { OrgRole } from "../tenancy/orgs.js";
import type { UserRole } from "../auth-file.js";

const ORG_GROUP_PREFIX = "orgs";

export interface KcUser {
  id: string;
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  attributes?: Record<string, string[]>;
}

export interface KcGroup {
  id: string;
  name: string;
  path?: string;
  attributes?: Record<string, string[]>;
  subGroups?: KcGroup[];
}

export interface KcConfig {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

function cfg(env: NodeJS.ProcessEnv = process.env): KcConfig | null {
  const issuer = (env.OIDC_ISSUER ?? env.KEYCLOAK_ISSUER ?? "").replace(/\/$/, "");
  if (!issuer) return null;
  // Supports plain and path-based Keycloak (http-relative-path=/auth):
  //   http://keycloak:8083/realms/codesteward
  //   http://keycloak:8083/auth/realms/codesteward
  // baseUrl is everything before "/realms/{realm}" (includes /auth when present).
  const m = issuer.match(/^(https?:\/\/.+?)\/realms\/([^/]+)/i);
  if (!m) return null;
  const clientId = env.KEYCLOAK_ADMIN_CLIENT_ID ?? env.OIDC_ADMIN_CLIENT_ID ?? "codesteward-api";
  const clientSecret =
    env.KEYCLOAK_ADMIN_CLIENT_SECRET ??
    env.OIDC_ADMIN_CLIENT_SECRET ??
    env.OIDC_CLIENT_SECRET ??
    "";
  if (!clientSecret) return null;
  return {
    baseUrl: m[1]!,
    realm: m[2]!,
    clientId,
    clientSecret,
  };
}

export function isKeycloakAdminConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(cfg(env));
}

let tokenCache: { token: string; exp: number } | undefined;

async function getAdminToken(env: NodeJS.ProcessEnv = process.env): Promise<{
  token: string;
  conf: KcConfig;
}> {
  const conf = cfg(env);
  if (!conf) {
    throw Object.assign(new Error("Keycloak Admin not configured (OIDC_ISSUER + admin client secret)"), {
      status: 503,
    });
  }
  if (tokenCache && tokenCache.exp > Date.now() + 30_000) {
    return { token: tokenCache.token, conf };
  }
  const url = `${conf.baseUrl}/realms/${conf.realm}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: conf.clientId,
    client_secret: conf.clientSecret,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(
      new Error(`Keycloak token failed: ${res.status} ${t.slice(0, 200)}`),
      { status: 502 },
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache = {
    token: data.access_token,
    exp: Date.now() + (data.expires_in ?? 60) * 1000,
  };
  return { token: data.access_token, conf };
}

async function adminFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const { token, conf } = await getAdminToken(env);
  const q = init.query
    ? "?" + new URLSearchParams(init.query).toString()
    : "";
  const url = `${conf.baseUrl}/admin/realms/${conf.realm}${path}${q}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
}

function orgGroupName(slug: string): string {
  return slug.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function orgGroupPath(slug: string): string {
  return `/${ORG_GROUP_PREFIX}/${orgGroupName(slug)}`;
}

export function productRoleToRealmRole(role: UserRole | OrgRole): string {
  if (role === "admin" || role === "owner") return "steward-admin";
  if (role === "viewer") return "steward-viewer";
  return "steward-reviewer";
}

export function realmRoleToProductRole(role: string): UserRole {
  const r = role.toLowerCase();
  if (r.includes("admin")) return "admin";
  if (r.includes("viewer")) return "viewer";
  return "reviewer";
}

export function realmRoleToOrgRole(role: string): OrgRole {
  const p = realmRoleToProductRole(role);
  if (p === "admin") return "admin";
  if (p === "viewer") return "viewer";
  return "reviewer";
}

/** Ensure /orgs parent + /orgs/{slug} group exist; return group id. */
export async function ensureOrgGroup(
  slug: string,
  displayName?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: string; name: string; path: string }> {
  const name = orgGroupName(slug);
  const path = orgGroupPath(name);

  // Find existing by path
  const search = await adminFetch("/groups", {
    query: { search: name, exact: "false", max: "50" },
  }, env);
  if (search.ok) {
    const groups = (await search.json()) as KcGroup[];
    const flat = flattenGroups(groups);
    const hit = flat.find(
      (g) => g.path === path || g.path === path + "/" || g.name === name,
    );
    if (hit?.id) {
      return { id: hit.id, name: hit.name, path: hit.path ?? path };
    }
  }

  // Ensure parent /orgs
  let parentId: string | undefined;
  const top = await adminFetch("/groups", { query: { search: ORG_GROUP_PREFIX, max: "20" } }, env);
  if (top.ok) {
    const groups = (await top.json()) as KcGroup[];
    const parent = flattenGroups(groups).find(
      (g) => g.name === ORG_GROUP_PREFIX || g.path === `/${ORG_GROUP_PREFIX}`,
    );
    parentId = parent?.id;
  }
  if (!parentId) {
    const createParent = await adminFetch("/groups", {
      method: "POST",
      body: JSON.stringify({ name: ORG_GROUP_PREFIX }),
    }, env);
    if (!createParent.ok && createParent.status !== 409) {
      const t = await createParent.text();
      throw Object.assign(new Error(`create parent group failed: ${t.slice(0, 200)}`), {
        status: 502,
      });
    }
    // re-fetch parent
    const top2 = await adminFetch("/groups", {
      query: { search: ORG_GROUP_PREFIX, max: "20" },
    }, env);
    const groups = top2.ok ? ((await top2.json()) as KcGroup[]) : [];
    parentId = flattenGroups(groups).find((g) => g.name === ORG_GROUP_PREFIX)?.id;
  }
  if (!parentId) {
    throw Object.assign(new Error("could not resolve Keycloak /orgs group"), { status: 502 });
  }

  const create = await adminFetch(`/groups/${parentId}/children`, {
    method: "POST",
    body: JSON.stringify({
      name,
      attributes: {
        displayName: displayName ? [displayName] : [name],
        codesteward_org: [name],
      },
    }),
  }, env);
  if (!create.ok && create.status !== 409) {
    const t = await create.text();
    throw Object.assign(new Error(`create org group failed: ${t.slice(0, 200)}`), {
      status: 502,
    });
  }

  // Locate created group
  const again = await adminFetch("/groups", {
    query: { search: name, max: "50" },
  }, env);
  const groups = again.ok ? ((await again.json()) as KcGroup[]) : [];
  const hit = flattenGroups(groups).find((g) => g.name === name || g.path === path);
  if (!hit?.id) {
    throw Object.assign(new Error("org group created but not found"), { status: 502 });
  }
  return { id: hit.id, name: hit.name, path: hit.path ?? path };
}

function flattenGroups(groups: KcGroup[]): KcGroup[] {
  const out: KcGroup[] = [];
  const walk = (gs: KcGroup[]) => {
    for (const g of gs) {
      out.push(g);
      if (g.subGroups?.length) walk(g.subGroups);
    }
  };
  walk(groups);
  return out;
}

export async function listOrgGroups(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ id: string; slug: string; name: string; path: string }>> {
  const res = await adminFetch("/groups", {
    query: { search: ORG_GROUP_PREFIX, max: "200", briefRepresentation: "false" },
  }, env);
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(new Error(`list groups failed: ${t.slice(0, 200)}`), { status: 502 });
  }
  const groups = (await res.json()) as KcGroup[];
  // Prefer children of /orgs
  const flat = flattenGroups(groups);
  const parent = flat.find((g) => g.name === ORG_GROUP_PREFIX);
  const children =
    parent?.subGroups?.length
      ? parent.subGroups
      : flat.filter(
          (g) =>
            g.path?.startsWith(`/${ORG_GROUP_PREFIX}/`) &&
            g.name !== ORG_GROUP_PREFIX,
        );
  // If API didn't expand subGroups, search each
  let orgs = children;
  if (parent?.id && (!orgs || orgs.length === 0)) {
    const kids = await adminFetch(`/groups/${parent.id}/children`, {
      query: { max: "200" },
    }, env);
    if (kids.ok) orgs = (await kids.json()) as KcGroup[];
  }
  return (orgs ?? []).map((g) => ({
    id: g.id!,
    slug: g.name,
    name: g.attributes?.displayName?.[0] ?? g.name,
    path: g.path ?? orgGroupPath(g.name),
  }));
}

export async function listGroupMembers(
  groupId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KcUser[]> {
  const res = await adminFetch(`/groups/${groupId}/members`, {
    query: { max: "500" },
  }, env);
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(new Error(`list members failed: ${t.slice(0, 200)}`), { status: 502 });
  }
  return (await res.json()) as KcUser[];
}

export async function getUserRealmRoles(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const res = await adminFetch(`/users/${userId}/role-mappings/realm`, {}, env);
  if (!res.ok) return [];
  const roles = (await res.json()) as Array<{ name?: string }>;
  return roles.map((r) => r.name!).filter(Boolean);
}

export async function findUserByEmail(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KcUser | undefined> {
  const e = email.trim().toLowerCase();
  const res = await adminFetch("/users", {
    query: { email: e, exact: "true" },
  }, env);
  if (res.ok) {
    const users = (await res.json()) as KcUser[];
    if (users[0]) return users[0];
  }
  // registrationEmailAsUsername — also resolve by username
  const byUser = await adminFetch("/users", {
    query: { username: e, exact: "true" },
  }, env);
  if (!byUser.ok) return undefined;
  const users = (await byUser.json()) as KcUser[];
  return users[0];
}

/**
 * Verify a user's current password via Resource Owner Password grant.
 * Uses the Admin service client (confidential) so the public UI client stays PKCE-only.
 * Requires directAccessGrantsEnabled on KEYCLOAK_ADMIN_CLIENT_ID (codesteward-api).
 */
export async function verifyUserPassword(
  usernameOrEmail: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const conf = cfg(env);
  if (!conf) return false;
  const url = `${conf.baseUrl}/realms/${conf.realm}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: conf.clientId,
    client_secret: conf.clientSecret,
    username: usernameOrEmail.trim().toLowerCase(),
    password,
    scope: "openid",
  });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Update email / display name on a Keycloak user (identity SoT). */
export async function updateUserProfile(
  userId: string,
  patch: { email?: string; displayName?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<KcUser> {
  const get = await adminFetch(`/users/${userId}`, {}, env);
  if (!get.ok) {
    throw Object.assign(new Error("identity user not found"), { status: 404 });
  }
  const user = (await get.json()) as KcUser & Record<string, unknown>;
  if (patch.email !== undefined) {
    const email = patch.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw Object.assign(new Error("valid email required"), { status: 400 });
    }
    // Enforce unique email when changing
    if (email !== (user.email ?? "").toLowerCase()) {
      const clash = await findUserByEmail(email, env);
      if (clash?.id && clash.id !== userId) {
        throw Object.assign(new Error("email already in use"), { status: 409 });
      }
    }
    user.email = email;
    user.username = email;
    user.emailVerified = true;
  }
  if (patch.displayName !== undefined) {
    const names = patch.displayName.trim().split(/\s+/).filter(Boolean);
    user.firstName = names[0] || (user.firstName as string) || "User";
    user.lastName = names.slice(1).join(" ") || (user.lastName as string) || "-";
  }
  const res = await adminFetch(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify(user),
  }, env);
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(new Error(`update identity profile failed: ${t.slice(0, 200)}`), {
      status: 502,
    });
  }
  const again = await adminFetch(`/users/${userId}`, {}, env);
  if (!again.ok) return user as KcUser;
  return (await again.json()) as KcUser;
}

export async function createUser(input: {
  email: string;
  password?: string;
  displayName?: string;
  enabled?: boolean;
  temporaryPassword?: boolean;
}, env: NodeJS.ProcessEnv = process.env): Promise<KcUser> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUserByEmail(email, env);
  if (existing) return existing;

  const names = (input.displayName ?? email.split("@")[0] ?? "user").split(/\s+/);
  const body = {
    username: email,
    email,
    enabled: input.enabled !== false,
    emailVerified: true,
    firstName: names[0] ?? "User",
    lastName: names.slice(1).join(" ") || "-",
    attributes: {
      codesteward: ["1"],
    },
  };
  const res = await adminFetch("/users", {
    method: "POST",
    body: JSON.stringify(body),
  }, env);
  if (!res.ok && res.status !== 409) {
    const t = await res.text();
    throw Object.assign(new Error(`create user failed: ${t.slice(0, 300)}`), { status: 502 });
  }
  const user = await findUserByEmail(email, env);
  if (!user?.id) {
    throw Object.assign(new Error("user created but not found"), { status: 502 });
  }
  if (input.password) {
    await setUserPassword(user.id, input.password, input.temporaryPassword !== false, env);
  }
  return user;
}

export async function setUserPassword(
  userId: string,
  password: string,
  temporary = true,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!password || password.length < 8) {
    throw Object.assign(new Error("password must be at least 8 characters"), { status: 400 });
  }
  const res = await adminFetch(`/users/${userId}/reset-password`, {
    method: "PUT",
    body: JSON.stringify({
      type: "password",
      value: password,
      temporary,
    }),
  }, env);
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(new Error(`set password failed: ${t.slice(0, 200)}`), { status: 502 });
  }
}

/**
 * Self-service password change against Keycloak (SoT).
 * Verifies current password, then sets permanent new password.
 */
export async function changeUserPassword(
  email: string,
  currentPassword: string,
  newPassword: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!newPassword || newPassword.length < 8) {
    throw Object.assign(new Error("new password must be at least 8 characters"), { status: 400 });
  }
  const ok = await verifyUserPassword(email, currentPassword, env);
  if (!ok) {
    throw Object.assign(new Error("current password is incorrect"), { status: 401 });
  }
  const kc = await findUserByEmail(email, env);
  if (!kc?.id) {
    throw Object.assign(new Error("identity user not found"), { status: 404 });
  }
  await setUserPassword(kc.id, newPassword, false, env);
}

export async function ensureRealmRole(
  roleName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: string; name: string }> {
  const list = await adminFetch("/roles", {}, env);
  if (list.ok) {
    const roles = (await list.json()) as Array<{ id?: string; name?: string }>;
    const hit = roles.find((r) => r.name === roleName);
    if (hit?.id) return { id: hit.id, name: hit.name! };
  }
  const create = await adminFetch("/roles", {
    method: "POST",
    body: JSON.stringify({ name: roleName }),
  }, env);
  if (!create.ok && create.status !== 409) {
    const t = await create.text();
    throw Object.assign(new Error(`create role failed: ${t.slice(0, 200)}`), { status: 502 });
  }
  const again = await adminFetch(`/roles/${encodeURIComponent(roleName)}`, {}, env);
  if (!again.ok) throw Object.assign(new Error("role not found after create"), { status: 502 });
  const role = (await again.json()) as { id: string; name: string };
  return role;
}

export async function setUserProductRole(
  userId: string,
  productRole: UserRole | OrgRole,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const want = productRoleToRealmRole(productRole);
  const allNames = ["steward-admin", "steward-reviewer", "steward-viewer"];
  const roles: Array<{ id: string; name: string }> = [];
  for (const n of allNames) {
    roles.push(await ensureRealmRole(n, env));
  }
  // Remove other steward roles, add desired
  const current = await adminFetch(`/users/${userId}/role-mappings/realm`, {}, env);
  if (current.ok) {
    const cur = (await current.json()) as Array<{ id: string; name: string }>;
    const toRemove = cur.filter((r) => allNames.includes(r.name) && r.name !== want);
    if (toRemove.length) {
      await adminFetch(`/users/${userId}/role-mappings/realm`, {
        method: "DELETE",
        body: JSON.stringify(toRemove),
      }, env);
    }
  }
  const role = roles.find((r) => r.name === want)!;
  await adminFetch(`/users/${userId}/role-mappings/realm`, {
    method: "POST",
    body: JSON.stringify([role]),
  }, env);
}

export async function addUserToOrgGroup(
  userId: string,
  orgSlug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const g = await ensureOrgGroup(orgSlug, undefined, env);
  const res = await adminFetch(`/users/${userId}/groups/${g.id}`, { method: "PUT" }, env);
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    throw Object.assign(new Error(`add to group failed: ${t.slice(0, 200)}`), { status: 502 });
  }
}

export async function removeUserFromOrgGroup(
  userId: string,
  orgSlug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const g = await ensureOrgGroup(orgSlug, undefined, env);
  const res = await adminFetch(`/users/${userId}/groups/${g.id}`, { method: "DELETE" }, env);
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const t = await res.text();
    throw Object.assign(new Error(`remove from group failed: ${t.slice(0, 200)}`), {
      status: 502,
    });
  }
}

export async function setUserEnabled(
  userId: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const get = await adminFetch(`/users/${userId}`, {}, env);
  if (!get.ok) throw Object.assign(new Error("user not found"), { status: 404 });
  const user = (await get.json()) as KcUser;
  const res = await adminFetch(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ ...user, enabled }),
  }, env);
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(new Error(`update user failed: ${t.slice(0, 200)}`), { status: 502 });
  }
}

/** Provision user into Keycloak org + role (Codesteward Members UI). */
export async function provisionMember(input: {
  email: string;
  password?: string;
  displayName?: string;
  orgSlug: string;
  role: OrgRole | UserRole;
  temporaryPassword?: boolean;
}, env: NodeJS.ProcessEnv = process.env): Promise<{
  kcUserId: string;
  email: string;
  orgSlug: string;
  role: string;
}> {
  const user = await createUser(
    {
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      temporaryPassword: input.temporaryPassword,
    },
    env,
  );
  await ensureOrgGroup(input.orgSlug, undefined, env);
  await addUserToOrgGroup(user.id!, input.orgSlug, env);
  await setUserProductRole(user.id!, input.role, env);
  return {
    kcUserId: user.id!,
    email: input.email.trim().toLowerCase(),
    orgSlug: orgGroupName(input.orgSlug),
    role: productRoleToRealmRole(input.role),
  };
}

export async function healthCheck(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; realm?: string; error?: string }> {
  try {
    const { conf } = await getAdminToken(env);
    const res = await adminFetch("", {}, env);
    // GET /admin/realms/{realm} 
    const realmRes = await fetch(
      `${conf.baseUrl}/admin/realms/${conf.realm}`,
      {
        headers: { Authorization: `Bearer ${(await getAdminToken(env)).token}` },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!realmRes.ok) {
      return { ok: false, realm: conf.realm, error: `realm ${realmRes.status}` };
    }
    void res;
    return { ok: true, realm: conf.realm };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Clear token cache (tests). */
export function resetKeycloakAdminTokenCache(): void {
  tokenCache = undefined;
}
