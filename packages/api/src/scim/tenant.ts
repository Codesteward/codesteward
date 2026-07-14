/**
 * Multi-tenant SCIM helpers — org isolation for single-domain installs.
 *
 * Canonical IdP base URL (no custom headers required):
 *   {API_PUBLIC}/scim/v2/orgs/{orgId|slug}
 *
 * Org is resolved from:
 *   1. Path /orgs/:orgKey (required for multi-tenant)
 *   2. Bearer token binding (must match path org)
 * API key (platform) may operate on any path org when entitled.
 */
import type { StewardUser } from "../auth-file.js";
import { globalAuthStore } from "../auth-store.js";
import { getTenancyStore, type ProductOrg } from "../tenancy/orgs.js";

export async function resolveOrgKey(
  orgKey: string | undefined,
): Promise<ProductOrg | undefined> {
  if (!orgKey?.trim()) return undefined;
  const key = orgKey.trim();
  const store = getTenancyStore();
  await store.ensureDefaults?.().catch(() => undefined);
  const byId = await store.getOrg(key);
  if (byId) return byId;
  const orgs = await store.listOrgs();
  return orgs.find((o) => o.slug === key || o.id === key);
}

/** Users visible to SCIM for an org = org members (multi-tenant safe). */
export async function listOrgScimUsers(orgId: string): Promise<StewardUser[]> {
  const store = getTenancyStore();
  const members = await store.listMembers(orgId);
  const out: StewardUser[] = [];
  const seen = new Set<string>();

  for (const m of members) {
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    const u = await globalAuthStore.getUserById(m.userId);
    if (u) out.push(u);
  }

  // Also include users whose home org_id matches (bootstrap / single-tenant)
  const home = await globalAuthStore.listUsers(orgId);
  for (const p of home) {
    if (seen.has(p.id)) continue;
    const u = await globalAuthStore.getUserById(p.id);
    if (u) {
      seen.add(u.id);
      out.push(u);
    }
  }
  return out;
}

export async function userInOrg(userId: string, orgId: string): Promise<boolean> {
  const store = getTenancyStore();
  const members = await store.listMembers(orgId);
  if (members.some((m) => m.userId === userId)) return true;
  const u = await globalAuthStore.getUserById(userId);
  return Boolean(u && u.orgId === orgId);
}

/**
 * Deprovision from one org without nuking multi-org users:
 * remove membership; soft-deactivate only if no remaining memberships.
 */
export async function deprovisionUserFromOrg(
  userId: string,
  orgId: string,
  opts?: { hard?: boolean },
): Promise<"removed" | "deactivated" | "deleted" | "not_found"> {
  const store = getTenancyStore();
  const inOrg = await userInOrg(userId, orgId);
  if (!inOrg) return "not_found";

  await store.removeMember(orgId, userId);

  let remaining: Array<{ id: string }> = [];
  try {
    remaining = (await store.listOrgsForUser(userId)).filter((o) => o.id !== orgId);
  } catch {
    remaining = [];
  }

  if (opts?.hard) {
    if (remaining.length === 0) {
      await globalAuthStore.deleteUser(userId);
      return "deleted";
    }
    return "removed";
  }

  if (remaining.length === 0) {
    await globalAuthStore.updateUser(userId, { active: false });
    return "deactivated";
  }
  return "removed";
}

export function publicApiBase(): string {
  return (
    process.env.STEW_API_PUBLIC_URL?.replace(/\/$/, "") ||
    `http://localhost:${process.env.PORT ?? process.env.STEW_API_PORT ?? 8081}`
  );
}

/** Canonical multi-tenant SCIM base for an org (what IdPs should use). */
export function orgScimBaseUrl(org: ProductOrg | { id: string; slug?: string }): string {
  const key = org.slug || org.id;
  return `${publicApiBase()}/scim/v2/orgs/${encodeURIComponent(key)}`;
}
