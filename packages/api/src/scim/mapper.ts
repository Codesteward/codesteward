/**
 * SCIM 2.0 User / Group JSON mappers (RFC 7643).
 */
import type { StewardUser, UserRole } from "../auth-file.js";
import type { ScimGroupRecord } from "./groups-store.js";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ENTERPRISE =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

export type ScimRole = UserRole;

export function roleFromScim(raw: unknown): ScimRole {
  if (typeof raw !== "string") return "reviewer";
  const s = raw.toLowerCase().replace(/^role:/, "").trim();
  if (s === "admin" || s === "owner" || s === "administrator") return "admin";
  if (s === "viewer" || s === "read_only" || s === "readonly") return "viewer";
  if (s === "reviewer" || s === "member" || s === "user") return "reviewer";
  return "reviewer";
}

export function extractRoleFromScimUser(body: Record<string, unknown>): ScimRole {
  const roles = body.roles;
  if (Array.isArray(roles) && roles[0]) {
    const r0 = roles[0] as { value?: string; display?: string; type?: string };
    return roleFromScim(r0.value ?? r0.display ?? r0.type);
  }
  const ent = body[SCIM_ENTERPRISE] as { department?: string; employeeType?: string } | undefined;
  if (ent?.employeeType) return roleFromScim(ent.employeeType);
  return "reviewer";
}

export function extractEmail(body: Record<string, unknown>): string {
  if (typeof body.userName === "string" && body.userName.includes("@")) {
    return body.userName.trim().toLowerCase();
  }
  const emails = body.emails;
  if (Array.isArray(emails)) {
    const primary = emails.find(
      (e) => (e as { primary?: boolean }).primary && (e as { value?: string }).value,
    ) as { value?: string } | undefined;
    const any = (emails[0] as { value?: string } | undefined)?.value;
    const v = primary?.value ?? any;
    if (v) return String(v).trim().toLowerCase();
  }
  if (typeof body.userName === "string") return body.userName.trim().toLowerCase();
  return "";
}

export function extractDisplayName(body: Record<string, unknown>, email: string): string | undefined {
  if (typeof body.displayName === "string" && body.displayName.trim()) {
    return body.displayName.trim();
  }
  const name = body.name as { formatted?: string; givenName?: string; familyName?: string } | undefined;
  if (name?.formatted?.trim()) return name.formatted.trim();
  const parts = [name?.givenName, name?.familyName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return email.split("@")[0];
}

export function toScimUser(
  user: StewardUser,
  opts?: { locationBase?: string },
): Record<string, unknown> {
  const loc = opts?.locationBase
    ? `${opts.locationBase.replace(/\/$/, "")}/Users/${user.id}`
    : undefined;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    externalId: user.externalId,
    userName: user.email,
    name: {
      formatted: user.displayName ?? user.email,
    },
    displayName: user.displayName ?? user.email,
    active: user.active !== false,
    emails: [{ value: user.email, primary: true, type: "work" }],
    roles: [{ value: user.role, display: user.role, primary: true, type: "product" }],
    meta: {
      resourceType: "User",
      created: user.createdAt,
      lastModified: user.updatedAt ?? user.createdAt,
      location: loc,
    },
  };
}

export function toScimGroup(
  group: ScimGroupRecord,
  opts?: { locationBase?: string },
): Record<string, unknown> {
  const loc = opts?.locationBase
    ? `${opts.locationBase.replace(/\/$/, "")}/Groups/${group.id}`
    : undefined;
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    externalId: group.externalId,
    displayName: group.displayName,
    members: group.memberIds.map((id) => ({
      value: id,
      $ref: opts?.locationBase
        ? `${opts.locationBase.replace(/\/$/, "")}/Users/${id}`
        : undefined,
      type: "User",
    })),
    meta: {
      resourceType: "Group",
      created: group.createdAt,
      lastModified: group.updatedAt,
      location: loc,
    },
  };
}

export function listResponse(
  resources: Record<string, unknown>[],
  total: number,
  startIndex: number,
  itemsPerPage: number,
): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): Record<string, unknown> {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  };
}

/** Parse SCIM filter: userName eq "x" | displayName eq "y" | externalId eq "z" */
export function parseEqFilter(
  filter: string | undefined,
): { attr: string; value: string } | null {
  if (!filter?.trim()) return null;
  const m = filter.match(
    /^\s*(\w+(?:\.\w+)?)\s+eq\s+"([^"]*)"\s*$/i,
  ) ?? filter.match(/^\s*(\w+(?:\.\w+)?)\s+eq\s+'([^']*)'\s*$/i);
  if (!m) return null;
  return { attr: m[1]!.toLowerCase(), value: m[2]! };
}

export function applyPatchOps(
  current: Record<string, unknown>,
  ops: Array<{ op: string; path?: string; value?: unknown }>,
): Record<string, unknown> {
  const next = { ...current };
  for (const op of ops) {
    const kind = String(op.op ?? "").toLowerCase();
    const path = (op.path ?? "").replace(/^\//, "");
    if (kind === "replace" || kind === "add") {
      if (!path || path === "") {
        if (op.value && typeof op.value === "object") {
          Object.assign(next, op.value as object);
        }
        continue;
      }
      if (path.toLowerCase() === "active") next.active = Boolean(op.value);
      else if (path.toLowerCase() === "username") next.userName = op.value;
      else if (path.toLowerCase() === "displayname") next.displayName = op.value;
      else if (path.toLowerCase() === "externalid") next.externalId = op.value;
      else if (path.toLowerCase() === "name.formatted") {
        next.name = { ...(next.name as object), formatted: op.value };
        next.displayName = op.value;
      } else if (path.toLowerCase() === "emails") next.emails = op.value;
      else if (path.toLowerCase() === "members") next.members = op.value;
      else if (path.toLowerCase().startsWith("members")) {
        // members[value eq "x"] remove handled below
        if (kind === "add" && op.value) {
          const arr = Array.isArray(next.members) ? [...(next.members as unknown[])] : [];
          if (Array.isArray(op.value)) arr.push(...op.value);
          else arr.push(op.value);
          next.members = arr;
        }
      } else if (path.toLowerCase() === "roles") next.roles = op.value;
      else next[path] = op.value;
    } else if (kind === "remove") {
      if (path.toLowerCase() === "members" || path.toLowerCase().startsWith("members[")) {
        const m = path.match(/members\[value eq "([^"]+)"\]/i);
        if (m) {
          const id = m[1]!;
          const arr = Array.isArray(next.members) ? (next.members as Array<{ value?: string }>) : [];
          next.members = arr.filter((x) => x.value !== id);
        } else if (path.toLowerCase() === "members") {
          next.members = [];
        }
      } else if (path) {
        delete next[path];
      }
    }
  }
  return next;
}

export function memberIdsFromScim(body: Record<string, unknown>): string[] {
  const members = body.members;
  if (!Array.isArray(members)) return [];
  return members
    .map((m) => {
      if (typeof m === "string") return m;
      if (m && typeof m === "object" && "value" in m) {
        return String((m as { value: string }).value);
      }
      return "";
    })
    .filter(Boolean);
}
