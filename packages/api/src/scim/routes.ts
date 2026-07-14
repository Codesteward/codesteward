/**
 * SCIM 2.0 multi-tenant surface (RFC 7644) for single-domain platforms.
 *
 * Canonical IdP base URL (path encodes tenant — no X-Org-Id required):
 *   {STEW_API_PUBLIC_URL}/scim/v2/orgs/{orgId|slug}
 *
 * Auth:
 *   Authorization: Bearer <per-org SCIM token>
 *   Token is hashed and bound to org_id (mint via POST /v1/org/scim/tokens).
 *   Platform STEW_API_KEY may access any /orgs/:orgKey path when licensed.
 *
 * Legacy:
 *   /scim/v2/* without path org — org resolved solely from bearer token binding.
 *   Client X-Org-Id is NEVER trusted for isolation.
 */
import type { Context, Hono } from "hono";
import { globalAuthStore } from "../auth-store.js";
import { isEntitled } from "../license.js";
import {
  createScimGroup,
  deleteScimGroup,
  getScimGroup,
  getScimGroupByExternalId,
  listScimGroups,
  updateScimGroup,
} from "./groups-store.js";
import {
  applyPatchOps,
  extractDisplayName,
  extractEmail,
  extractRoleFromScimUser,
  listResponse,
  memberIdsFromScim,
  parseEqFilter,
  SCIM_GROUP_SCHEMA,
  SCIM_PATCH_SCHEMA,
  SCIM_USER_SCHEMA,
  scimError,
  toScimGroup,
  toScimUser,
  type ScimRole,
} from "./mapper.js";
import {
  deprovisionUserFromOrg,
  listOrgScimUsers,
  orgScimBaseUrl,
  publicApiBase,
  resolveOrgKey,
  userInOrg,
} from "./tenant.js";
import { orgHasScimToken, resolveScimBearer } from "./tokens-store.js";

type AuthOk = {
  ok: true;
  orgId: string;
  orgKey: string;
  source: string;
  locationBase: string;
};
type AuthFail = { ok: false; status: number; body: Record<string, unknown> };

function reqParam(c: Context, name: string): string {
  return c.req.param(name) ?? "";
}


function pageParams(c: Context): { startIndex: number; count: number } {
  const startIndex = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
  const count = Math.min(200, Math.max(1, Number(c.req.query("count") ?? 100) || 100));
  return { startIndex, count };
}

function licenseGate(): AuthFail | null {
  const enforced =
    process.env.STEW_LICENSE_ENFORCE === "1" || process.env.NODE_ENV === "production";
  if (enforced && !isEntitled("scim")) {
    return {
      ok: false,
      status: 402,
      body: scimError(402, "SCIM requires enterprise license entitlement", "invalidValue"),
    };
  }
  if (!isEntitled("scim") && process.env.STEW_SCIM_ALLOW_WITHOUT_LICENSE !== "1") {
    // Still allow when tokens can be minted under entitled license; without entitlement block
    // soft: allow if not production unless explicitly denied
  }
  return null;
}

/**
 * Authenticate SCIM request and bind to a single org.
 * @param pathOrgKey — from /scim/v2/orgs/:orgKey/… (preferred multi-tenant)
 */
async function scimAuth(c: Context, pathOrgKey?: string): Promise<AuthOk | AuthFail> {
  const lic = licenseGate();
  if (lic && process.env.STEW_SCIM_ALLOW_WITHOUT_LICENSE !== "1") {
    if (!isEntitled("scim")) {
      // Non-enforced dev: continue only if token present later; still 402 when enforced handled above
      if (
        process.env.STEW_LICENSE_ENFORCE === "1" ||
        process.env.NODE_ENV === "production"
      ) {
        return lic;
      }
    }
  }
  if (
    (process.env.STEW_LICENSE_ENFORCE === "1" || process.env.NODE_ENV === "production") &&
    !isEntitled("scim")
  ) {
    return {
      ok: false,
      status: 402,
      body: scimError(402, "SCIM requires enterprise license entitlement"),
    };
  }

  const auth = c.req.header("Authorization") ?? c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) {
    return {
      ok: false,
      status: 401,
      body: scimError(
        401,
        "Authorization: Bearer <org SCIM token> required. Mint via POST /v1/org/scim/tokens",
      ),
    };
  }

  const resolved = await resolveScimBearer(bearer);
  if (!resolved) {
    return {
      ok: false,
      status: 401,
      body: scimError(401, "Invalid SCIM bearer token"),
    };
  }

  // Resolve path org (canonical multi-tenant)
  let orgId = resolved.orgId;
  let orgKey = resolved.orgId;

  if (pathOrgKey) {
    const org = await resolveOrgKey(pathOrgKey);
    if (!org) {
      return {
        ok: false,
        status: 404,
        body: scimError(404, `Unknown org in SCIM path: ${pathOrgKey}`),
      };
    }
    // Token must match path org — except platform API key which may target any org
    if (resolved.source !== "api_key" && resolved.orgId !== org.id) {
      // Also allow if token org was "local" default from API key mishap — still deny
      return {
        ok: false,
        status: 403,
        body: scimError(
          403,
          "SCIM token is not authorized for this organization (path/token org mismatch)",
        ),
      };
    }
    orgId = org.id;
    orgKey = org.slug || org.id;
  } else {
    // Legacy unscoped path: org comes only from token (never from X-Org-Id)
    if (resolved.source === "api_key") {
      return {
        ok: false,
        status: 400,
        body: scimError(
          400,
          "Platform API key must use tenant path: /scim/v2/orgs/{orgId|slug}/…",
        ),
      };
    }
    const org = await resolveOrgKey(resolved.orgId);
    orgKey = org?.slug || resolved.orgId;
    orgId = org?.id || resolved.orgId;
  }

  const locationBase = `${publicApiBase()}/scim/v2/orgs/${encodeURIComponent(orgKey)}`;
  return {
    ok: true,
    orgId,
    orgKey,
    source: resolved.source,
    locationBase,
  };
}

async function auditScim(
  action: string,
  orgId: string,
  resourceType: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const { auditLog } = await import("../audit.js");
    await auditLog({
      action,
      orgId,
      actorUserId: "scim",
      resourceType,
      resourceId,
      metadata,
      outcome: "success",
    });
  } catch {
    /* ignore */
  }
}

function serviceProviderConfig() {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://datatracker.ietf.org/doc/html/rfc7644",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description:
          "Per-organization SCIM token (mint in Org Settings). Path /scim/v2/orgs/{org} scopes the tenant.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      },
    ],
  };
}

function resourceTypesBody() {
  return listResponse(
    [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: SCIM_USER_SCHEMA,
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: SCIM_GROUP_SCHEMA,
      },
    ],
    2,
    1,
    2,
  );
}

function schemasBody() {
  return listResponse(
    [
      {
        id: SCIM_USER_SCHEMA,
        name: "User",
        description: "User Account (org-scoped)",
        attributes: [
          { name: "userName", type: "string", required: true, uniqueness: "server" },
          { name: "name", type: "complex", required: false },
          { name: "displayName", type: "string", required: false },
          { name: "active", type: "boolean", required: false },
          { name: "emails", type: "complex", multiValued: true, required: false },
          { name: "roles", type: "complex", multiValued: true, required: false },
          { name: "externalId", type: "string", required: false },
        ],
      },
      {
        id: SCIM_GROUP_SCHEMA,
        name: "Group",
        description: "Group (org-scoped)",
        attributes: [
          { name: "displayName", type: "string", required: true },
          { name: "members", type: "complex", multiValued: true },
          { name: "externalId", type: "string", required: false },
        ],
      },
    ],
    2,
    1,
    2,
  );
}

async function handleListUsers(c: Context, auth: AuthOk) {
  const { startIndex, count } = pageParams(c);
  const filter = parseEqFilter(c.req.query("filter"));
  let filtered = await listOrgScimUsers(auth.orgId);
  if (filter) {
    if (filter.attr === "username") {
      filtered = filtered.filter(
        (u) => u.email.toLowerCase() === filter.value.toLowerCase(),
      );
    } else if (filter.attr === "externalid") {
      filtered = filtered.filter((u) => u.externalId === filter.value);
    } else if (filter.attr === "displayname") {
      filtered = filtered.filter(
        (u) => (u.displayName ?? "").toLowerCase() === filter.value.toLowerCase(),
      );
    }
  }
  const total = filtered.length;
  const slice = filtered.slice(startIndex - 1, startIndex - 1 + count);
  return c.json(
    listResponse(
      slice.map((u) => toScimUser(u, { locationBase: auth.locationBase })),
      total,
      startIndex,
      slice.length,
    ),
  );
}

async function handleGetUser(c: Context, auth: AuthOk) {
  const id = reqParam(c, "id");
  if (!(await userInOrg(id, auth.orgId))) {
    return c.json(scimError(404, "User not found in this organization"), 404);
  }
  const user = await globalAuthStore.getUserById(id);
  if (!user) return c.json(scimError(404, "User not found"), 404);
  return c.json(toScimUser(user, { locationBase: auth.locationBase }));
}

async function handleCreateUser(c: Context, auth: AuthOk) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = extractEmail(body);
  if (!email || !email.includes("@")) {
    return c.json(scimError(400, "userName or emails.value required", "invalidValue"), 400);
  }
  const role: ScimRole = extractRoleFromScimUser(body);
  const displayName = extractDisplayName(body, email);
  const active = body.active === undefined ? true : Boolean(body.active);
  const externalId =
    typeof body.externalId === "string" ? body.externalId : undefined;

  const existing = await globalAuthStore.getUserByEmail(email);
  if (existing) {
    // Multi-tenant: add membership if user exists globally but not in this org
    if (await userInOrg(existing.id, auth.orgId)) {
      return c.json(scimError(409, "User already exists in this organization", "uniqueness"), 409);
    }
    try {
      const { getTenancyStore } = await import("../tenancy/orgs.js");
      await getTenancyStore().upsertMember({
        orgId: auth.orgId,
        userId: existing.id,
        role: role === "admin" ? "admin" : role === "viewer" ? "viewer" : "reviewer",
      });
      if (active === false) {
        await globalAuthStore.updateUser(existing.id, { active: false });
      } else if (existing.active === false) {
        await globalAuthStore.updateUser(existing.id, { active: true });
      }
      if (externalId) {
        await globalAuthStore.updateUser(existing.id, { externalId });
      }
      const full = await globalAuthStore.getUserById(existing.id);
      await auditScim("scim.user.create", auth.orgId, "user", existing.id, {
        email,
        role,
        linkedExisting: true,
      });
      return c.json(toScimUser(full!, { locationBase: auth.locationBase }), 201);
    } catch (err) {
      return c.json(
        scimError(400, err instanceof Error ? err.message : String(err)),
        400,
      );
    }
  }

  if (externalId) {
    const byExt = await globalAuthStore.getUserByExternalId(externalId);
    if (byExt) {
      return c.json(scimError(409, "externalId already exists", "uniqueness"), 409);
    }
  }

  try {
    const user = await globalAuthStore.createUserRaw({
      email,
      displayName,
      role,
      orgId: auth.orgId,
      active,
      externalId,
      scimMeta: { provisionedBy: "scim", orgId: auth.orgId },
    });
    const { getTenancyStore } = await import("../tenancy/orgs.js");
    await getTenancyStore().upsertMember({
      orgId: auth.orgId,
      userId: user.id,
      role: role === "admin" ? "admin" : role === "viewer" ? "viewer" : "reviewer",
    });
    await auditScim("scim.user.create", auth.orgId, "user", user.id, {
      email,
      role,
      orgId: auth.orgId,
    });
    return c.json(toScimUser(user, { locationBase: auth.locationBase }), 201);
  } catch (err) {
    return c.json(scimError(400, err instanceof Error ? err.message : String(err)), 400);
  }
}

async function handlePutUser(c: Context, auth: AuthOk) {
  const id = reqParam(c, "id");
  if (!(await userInOrg(id, auth.orgId))) {
    return c.json(scimError(404, "User not found in this organization"), 404);
  }
  const cur = await globalAuthStore.getUserById(id);
  if (!cur) return c.json(scimError(404, "User not found"), 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = extractEmail(body) || cur.email;
  const role = extractRoleFromScimUser(body);
  const displayName = extractDisplayName(body, email);
  const active = body.active === undefined ? cur.active !== false : Boolean(body.active);
  const externalId =
    typeof body.externalId === "string"
      ? body.externalId
      : body.externalId === null
        ? null
        : cur.externalId;
  await globalAuthStore.updateUser(id, {
    email,
    displayName,
    role,
    active,
    externalId: externalId ?? null,
  });
  try {
    const { getTenancyStore } = await import("../tenancy/orgs.js");
    await getTenancyStore().upsertMember({
      orgId: auth.orgId,
      userId: id,
      role: role === "admin" ? "admin" : role === "viewer" ? "viewer" : "reviewer",
    });
  } catch {
    /* ignore */
  }
  const full = await globalAuthStore.getUserById(id);
  await auditScim("scim.user.replace", auth.orgId, "user", id, { email, role, active });
  return c.json(toScimUser(full!, { locationBase: auth.locationBase }));
}

async function handlePatchUser(c: Context, auth: AuthOk) {
  const id = reqParam(c, "id");
  if (!(await userInOrg(id, auth.orgId))) {
    return c.json(scimError(404, "User not found in this organization"), 404);
  }
  const cur = await globalAuthStore.getUserById(id);
  if (!cur) return c.json(scimError(404, "User not found"), 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    Operations?: Array<{ op: string; path?: string; value?: unknown }>;
  };
  const ops = body.Operations ?? [];
  if (!ops.length) {
    return c.json(scimError(400, "Operations required", "invalidValue"), 400);
  }
  const patched = applyPatchOps(toScimUser(cur), ops);
  const email = extractEmail(patched) || cur.email;
  const role = extractRoleFromScimUser(patched);
  const displayName = extractDisplayName(patched, email);
  const active =
    patched.active === undefined ? cur.active !== false : Boolean(patched.active);
  await globalAuthStore.updateUser(id, {
    email,
    displayName,
    role,
    active,
    externalId:
      typeof patched.externalId === "string"
        ? patched.externalId
        : patched.externalId === null
          ? null
          : undefined,
  });
  const full = await globalAuthStore.getUserById(id);
  await auditScim("scim.user.patch", auth.orgId, "user", id, {
    ops: ops.map((o) => o.op),
    active,
  });
  return c.json(toScimUser(full!, { locationBase: auth.locationBase }));
}

async function handleDeleteUser(c: Context, auth: AuthOk) {
  const id = reqParam(c, "id");
  const hard = process.env.STEW_SCIM_HARD_DELETE === "1";
  const result = await deprovisionUserFromOrg(id, auth.orgId, { hard });
  if (result === "not_found") {
    return c.json(scimError(404, "User not found in this organization"), 404);
  }
  await auditScim("scim.user.delete", auth.orgId, "user", id, { hard, result });
  return c.body(null, 204);
}

async function handleListGroups(c: Context, auth: AuthOk) {
  const { startIndex, count } = pageParams(c);
  const filter = parseEqFilter(c.req.query("filter"));
  let groups = await listScimGroups(auth.orgId);
  if (filter) {
    if (filter.attr === "displayname") {
      groups = groups.filter(
        (g) => g.displayName.toLowerCase() === filter.value.toLowerCase(),
      );
    } else if (filter.attr === "externalid") {
      groups = groups.filter((g) => g.externalId === filter.value);
    }
  }
  const total = groups.length;
  const slice = groups.slice(startIndex - 1, startIndex - 1 + count);
  return c.json(
    listResponse(
      slice.map((g) => toScimGroup(g, { locationBase: auth.locationBase })),
      total,
      startIndex,
      slice.length,
    ),
  );
}

async function handleGetGroup(c: Context, auth: AuthOk) {
  const g = await getScimGroup(auth.orgId, reqParam(c, "id"));
  if (!g) return c.json(scimError(404, "Group not found"), 404);
  return c.json(toScimGroup(g, { locationBase: auth.locationBase }));
}

async function handleCreateGroup(c: Context, auth: AuthOk) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) {
    return c.json(scimError(400, "displayName required", "invalidValue"), 400);
  }
  const externalId =
    typeof body.externalId === "string" ? body.externalId : undefined;
  if (externalId) {
    const clash = await getScimGroupByExternalId(auth.orgId, externalId);
    if (clash) {
      return c.json(scimError(409, "externalId already exists", "uniqueness"), 409);
    }
  }
  // Only accept members that belong to this org
  const rawMembers = memberIdsFromScim(body);
  const memberIds: string[] = [];
  for (const mid of rawMembers) {
    if (await userInOrg(mid, auth.orgId)) memberIds.push(mid);
  }
  const g = await createScimGroup({
    orgId: auth.orgId,
    displayName,
    externalId,
    memberIds,
  });
  await applyRoleGroupSideEffects(auth.orgId, displayName, memberIds);
  await auditScim("scim.group.create", auth.orgId, "group", g.id, {
    displayName,
    members: memberIds.length,
  });
  return c.json(toScimGroup(g, { locationBase: auth.locationBase }), 201);
}

async function handlePutGroup(c: Context, auth: AuthOk) {
  const id = reqParam(c, "id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : undefined;
  let memberIds: string[] | undefined;
  if (body.members !== undefined) {
    memberIds = [];
    for (const mid of memberIdsFromScim(body)) {
      if (await userInOrg(mid, auth.orgId)) memberIds.push(mid);
    }
  }
  const g = await updateScimGroup(auth.orgId, id, {
    displayName,
    externalId:
      typeof body.externalId === "string"
        ? body.externalId
        : body.externalId === null
          ? null
          : undefined,
    memberIds,
  });
  if (!g) return c.json(scimError(404, "Group not found"), 404);
  if (memberIds) await applyRoleGroupSideEffects(auth.orgId, g.displayName, memberIds);
  await auditScim("scim.group.replace", auth.orgId, "group", id, {});
  return c.json(toScimGroup(g, { locationBase: auth.locationBase }));
}

async function handlePatchGroup(c: Context, auth: AuthOk) {
  const id = reqParam(c, "id");
  const cur = await getScimGroup(auth.orgId, id);
  if (!cur) return c.json(scimError(404, "Group not found"), 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    Operations?: Array<{ op: string; path?: string; value?: unknown }>;
  };
  const patched = applyPatchOps(toScimGroup(cur), body.Operations ?? []);
  const rawMembers = memberIdsFromScim(patched);
  const memberIds: string[] = [];
  for (const mid of rawMembers) {
    if (await userInOrg(mid, auth.orgId)) memberIds.push(mid);
  }
  const touchesMembers = body.Operations?.some((o) =>
    (o.path ?? "").toLowerCase().includes("member"),
  );
  const g = await updateScimGroup(auth.orgId, id, {
    displayName:
      typeof patched.displayName === "string" ? patched.displayName : undefined,
    memberIds: touchesMembers ? memberIds : undefined,
  });
  if (!g) return c.json(scimError(404, "Group not found"), 404);
  await auditScim("scim.group.patch", auth.orgId, "group", id, {
    schemas: [SCIM_PATCH_SCHEMA],
  });
  return c.json(toScimGroup(g, { locationBase: auth.locationBase }));
}

async function handleDeleteGroup(c: Context, auth: AuthOk) {
  const ok = await deleteScimGroup(auth.orgId, reqParam(c, "id"));
  if (!ok) return c.json(scimError(404, "Group not found"), 404);
  await auditScim("scim.group.delete", auth.orgId, "group", reqParam(c, "id"), {});
  return c.body(null, 204);
}

async function applyRoleGroupSideEffects(
  orgId: string,
  displayName: string,
  memberIds: string[],
): Promise<void> {
  const n = displayName.toLowerCase().replace(/^role:/, "").trim();
  let role: ScimRole | null = null;
  if (["admin", "admins", "administrators", "owners"].includes(n)) role = "admin";
  else if (["reviewer", "reviewers", "members", "developers"].includes(n))
    role = "reviewer";
  else if (["viewer", "viewers", "read-only", "readonly"].includes(n)) role = "viewer";
  if (!role) return;
  const { getTenancyStore } = await import("../tenancy/orgs.js");
  const store = getTenancyStore();
  for (const id of memberIds) {
    try {
      await globalAuthStore.updateUser(id, { role });
      await store.upsertMember({
        orgId,
        userId: id,
        role: role === "admin" ? "admin" : role === "viewer" ? "viewer" : "reviewer",
      });
    } catch {
      /* skip */
    }
  }
}

function mountScimHandlers(
  app: Hono,
  prefix: string,
  getPathOrg: (c: Context) => string | undefined,
) {
  app.get(`${prefix}/ServiceProviderConfig`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return c.json(serviceProviderConfig());
  });
  app.get(`${prefix}/ResourceTypes`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return c.json(resourceTypesBody());
  });
  app.get(`${prefix}/Schemas`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return c.json(schemasBody());
  });

  app.get(`${prefix}/Users`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleListUsers(c, auth);
  });
  app.get(`${prefix}/Users/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleGetUser(c, auth);
  });
  app.post(`${prefix}/Users`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleCreateUser(c, auth);
  });
  app.put(`${prefix}/Users/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handlePutUser(c, auth);
  });
  app.patch(`${prefix}/Users/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handlePatchUser(c, auth);
  });
  app.delete(`${prefix}/Users/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleDeleteUser(c, auth);
  });

  app.get(`${prefix}/Groups`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleListGroups(c, auth);
  });
  app.get(`${prefix}/Groups/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleGetGroup(c, auth);
  });
  app.post(`${prefix}/Groups`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleCreateGroup(c, auth);
  });
  app.put(`${prefix}/Groups/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handlePutGroup(c, auth);
  });
  app.patch(`${prefix}/Groups/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handlePatchGroup(c, auth);
  });
  app.delete(`${prefix}/Groups/:id`, async (c) => {
    const auth = await scimAuth(c, getPathOrg(c));
    if (!auth.ok) return c.json(auth.body, auth.status as 401);
    return handleDeleteGroup(c, auth);
  });
}

export function registerScimRoutes(app: Hono): void {
  // Canonical multi-tenant paths
  mountScimHandlers(app, "/scim/v2/orgs/:orgKey", (c) => reqParam(c, "orgKey"));
  // Legacy unscoped — token-bound org only
  mountScimHandlers(app, "/scim/v2", () => undefined);

  // Discovery root (no auth): tells IdPs about multi-tenant layout
  app.get("/scim/v2", (c) => {
    return c.json({
      multiTenant: true,
      tenantBasePath: "/scim/v2/orgs/{orgId|slug}",
      example: `${publicApiBase()}/scim/v2/orgs/local`,
      note:
        "Each product organization has its own SCIM base URL and bearer token. Configure the IdP with the org path; do not rely on X-Org-Id.",
    });
  });
}

/** Admin API helpers re-exported for app.ts status endpoints */
export { orgScimBaseUrl, orgHasScimToken, publicApiBase };
