/**
 * Sync Keycloak/OIDC claims into Codesteward local shadow (users + org memberships).
 * Local rows exist for FKs only — Keycloak remains identity SoT in keycloak mode.
 */
import { globalAuthStore } from "../auth-store.js";
import type { PublicAuthUser } from "../auth-store.js";
import { getTenancyStore, type OrgRole, type ProductOrg } from "../tenancy/orgs.js";
import {
  displayNameFromClaims,
  emailFromClaims,
  mapOrgMemberships,
  mapProductRole,
  type OidcClaims,
} from "./claims.js";
import { ensureOrgGroup, isKeycloakAdminConfigured } from "./keycloak-admin.js";
import { isKeycloakIdentityMode } from "./mode.js";

export interface SyncLoginResult {
  user: PublicAuthUser;
  token: string;
  created: boolean;
  orgs: Array<ProductOrg & { role: OrgRole }>;
  primaryOrgId: string;
}

/**
 * Stateless JWT path: ensure shadow user + memberships exist, no app session cookie.
 * Prefer this for Bearer access_token validation on every request (cache at caller).
 */
export async function resolveOidcUser(claims: OidcClaims): Promise<PublicAuthUser> {
  const result = await syncOidcLogin(claims);
  return result.user;
}

/**
 * After successful OIDC: upsert shadow user + memberships from claims.
 * Still issues a Codesteward session token for legacy/API-RP flows.
 */
export async function syncOidcLogin(claims: OidcClaims): Promise<SyncLoginResult> {
  const email = emailFromClaims(claims);
  if (!email) {
    throw Object.assign(new Error("OIDC token missing email claim"), { status: 400 });
  }
  const productRole = mapProductRole(claims);
  const displayName = displayNameFromClaims(claims);
  const memberships = mapOrgMemberships(claims, productRole);
  const tenancy = getTenancyStore();
  await tenancy.ensureDefaults();

  // Resolve / create local product orgs from claim keys (slug or id)
  const resolved: Array<{ org: ProductOrg; role: OrgRole }> = [];
  for (const m of memberships) {
    let org = await tenancy.getOrg(m.key);
    if (!org) {
      // try by slug
      const all = await tenancy.listOrgs();
      org = all.find((o) => o.slug === m.key || o.id === m.key);
    }
    if (!org) {
      try {
        org = await tenancy.createOrg({
          name: m.key === "local" ? "Local" : m.key,
          slug: m.key,
          tenantId: "local",
        });
      } catch {
        // race: re-fetch
        const all = await tenancy.listOrgs();
        org = all.find((o) => o.slug === m.key || o.id === m.key);
      }
    }
    if (!org) continue;

    // Best-effort: ensure Keycloak group exists when Admin API configured
    if (isKeycloakIdentityMode() && isKeycloakAdminConfigured()) {
      try {
        await ensureOrgGroup(org.slug || org.id, org.name);
      } catch (err) {
        console.warn("[identity] ensureOrgGroup", org.slug, err);
      }
    }

    resolved.push({ org, role: m.role });
  }

  // No org claims → no memberships. SaaS users create an org or wait for invite.
  // Legacy self-host can still auto-join "local" via listOrgsForUser when STEW_AUTH_STRICT is off.

  const primaryOrgId = resolved[0]?.org.id;
  const { user, token, created } = await globalAuthStore.findOrCreateFromOidc({
    email,
    displayName,
    roleHint: productRole,
    orgId: primaryOrgId,
    subject: claims.sub,
  });

  // Sync memberships for all claimed orgs
  for (const r of resolved) {
    try {
      await tenancy.upsertMember({
        orgId: r.org.id,
        userId: user.id,
        role: r.role,
      });
    } catch (err) {
      console.warn("[identity] upsertMember", r.org.id, err);
    }
  }

  // Update local role/home org if existing user
  if (!created) {
    try {
      await globalAuthStore.updateUser(user.id, {
        role: productRole,
        ...(primaryOrgId ? { orgId: primaryOrgId } : {}),
        displayName: displayName ?? undefined,
      });
    } catch {
      /* ignore */
    }
  }

  const orgs = resolved.map((r) => ({ ...r.org, role: r.role }));
  return {
    user: { ...user, role: productRole, orgId: primaryOrgId ?? user.orgId },
    token,
    created,
    orgs,
    primaryOrgId: primaryOrgId ?? "",
  };
}
