/**
 * Codesteward claim contract for Keycloak / OIDC tokens.
 *
 * Realm roles (product RBAC):
 *   steward-admin | steward-reviewer | steward-viewer
 *   (aliases: codesteward-admin, …)
 *
 * Organizations (multi-tenant) — any of:
 *   - groups claim paths: /orgs/{slug} or orgs/{slug}
 *   - claim "orgs" or "organizations": string[] of slugs/ids
 *   - claim "org" / "organization" / "org_id": single slug/id
 *   - claim "org_roles": { [orgSlug]: "admin"|"reviewer"|"viewer" }
 *
 * When no org claim is present, return no memberships — UI routes to org onboarding.
 * (Do not auto-assign "local"; that breaks SaaS multi-tenant signup.)
 */
import type { UserRole } from "../auth-file.js";
import type { OrgRole } from "../tenancy/orgs.js";

export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  groups?: string[] | string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
  orgs?: string[] | string;
  organizations?: string[] | string;
  org?: string;
  organization?: string;
  org_id?: string;
  org_roles?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClaimedOrgMembership {
  /** Product org id or slug from IdP (resolved to local id later). */
  key: string;
  role: OrgRole;
}

function asStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") {
    // space- or comma-separated
    return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function collectRoles(claims: OidcClaims): Set<string> {
  const roles = new Set<string>();
  for (const r of claims.realm_access?.roles ?? []) roles.add(String(r).toLowerCase());
  for (const g of asStringArray(claims.groups)) roles.add(String(g).toLowerCase());
  if (claims.resource_access) {
    for (const entry of Object.values(claims.resource_access)) {
      for (const r of entry?.roles ?? []) roles.add(String(r).toLowerCase());
    }
  }
  return roles;
}

/** Global product role hint from realm roles (never bare IdP "admin"). */
export function mapProductRole(claims: OidcClaims): UserRole {
  const roles = collectRoles(claims);
  if (
    roles.has("steward-admin") ||
    roles.has("codesteward-admin") ||
    roles.has("steward_admin")
  ) {
    return "admin";
  }
  if (
    roles.has("steward-viewer") ||
    roles.has("codesteward-viewer") ||
    roles.has("steward_viewer")
  ) {
    return "viewer";
  }
  return "reviewer";
}

function parseOrgKeyFromGroup(g: string): string | null {
  const s = g.replace(/^\/+/, "");
  // /orgs/{slug} or orgs/{slug}
  const m = s.match(/^(?:orgs?|organizations)\/([a-zA-Z0-9._-]+)$/i);
  if (m) return m[1]!.toLowerCase();
  // bare slug if group is just the org name under convention org-{slug}
  const m2 = s.match(/^org-([a-zA-Z0-9._-]+)$/i);
  if (m2) return m2[1]!.toLowerCase();
  return null;
}

function mapOrgRoleString(raw: string | undefined, fallback: OrgRole): OrgRole {
  const r = (raw ?? "").toLowerCase().replace(/^steward-|^codesteward-/, "");
  if (r === "owner") return "owner";
  if (r === "admin" || r === "administrator") return "admin";
  if (r === "viewer" || r === "read" || r === "readonly") return "viewer";
  if (r === "reviewer" || r === "member" || r === "user") return "reviewer";
  return fallback;
}

/**
 * Extract org memberships from OIDC claims.
 * Product role is used as default org role when per-org roles are absent.
 */
export function mapOrgMemberships(
  claims: OidcClaims,
  productRole: UserRole = mapProductRole(claims),
): ClaimedOrgMembership[] {
  const defaultOrgRole: OrgRole =
    productRole === "admin" ? "admin" : productRole === "viewer" ? "viewer" : "reviewer";

  const byKey = new Map<string, OrgRole>();

  // Explicit map claim
  if (claims.org_roles && typeof claims.org_roles === "object") {
    for (const [k, v] of Object.entries(claims.org_roles)) {
      const key = k.trim().toLowerCase();
      if (key) byKey.set(key, mapOrgRoleString(String(v), defaultOrgRole));
    }
  }

  // List claims
  for (const key of [
    ...asStringArray(claims.orgs),
    ...asStringArray(claims.organizations),
  ]) {
    const k = key.trim().toLowerCase();
    if (k && !byKey.has(k)) byKey.set(k, defaultOrgRole);
  }

  // Single org claim
  for (const single of [claims.org, claims.organization, claims.org_id]) {
    if (typeof single === "string" && single.trim()) {
      const k = single.trim().toLowerCase();
      if (!byKey.has(k)) byKey.set(k, defaultOrgRole);
    }
  }

  // Groups convention
  for (const g of asStringArray(claims.groups)) {
    const k = parseOrgKeyFromGroup(g);
    if (k && !byKey.has(k)) byKey.set(k, defaultOrgRole);
  }

  // Empty → no org yet (create via onboarding or wait for admin invite)
  return [...byKey.entries()].map(([key, role]) => ({ key, role }));
}

export function displayNameFromClaims(claims: OidcClaims): string | undefined {
  if (claims.name?.trim()) return claims.name.trim();
  const parts = [claims.given_name, claims.family_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (claims.preferred_username?.trim()) return claims.preferred_username.trim();
  return undefined;
}

export function emailFromClaims(claims: OidcClaims): string | undefined {
  if (claims.email?.trim()) return claims.email.trim().toLowerCase();
  if (claims.preferred_username?.includes("@")) {
    return claims.preferred_username.trim().toLowerCase();
  }
  return undefined;
}
