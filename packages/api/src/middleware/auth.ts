import type { Context, MiddlewareHandler, Next } from "hono";
import { globalAuthStore, type PublicAuthUser, type UserRole } from "../auth-store.js";
import { getTenancyStore, type OrgRole } from "../tenancy/orgs.js";

/**
 * Self-host auth middleware:
 * - If any users exist → require Bearer session token OR STEW_API_KEY
 * - If no users and STEW_API_KEY set → require API key
 * - If no users and no key → open (dev) unless STEW_AUTH_STRICT=1
 * - Org isolation (multi-tenant single domain):
 *     X-Org-Id is ONLY a request selector, never a capability.
 *     Server binds org via assertMembership(user, requestedOrg).
 *     Spoofed X-Org-Id for a non-member org → 403.
 *     STEW_API_KEY is platform break-glass (scoped by STEW_API_KEY_ORGS, default "local").
 *     SCIM uses path /scim/v2/orgs/{org} + per-org bearer token (not this middleware).
 * - RBAC: viewer read-only; admin for connectors/users/policy
 */

let warnedDev = false;

const EXEMPT_EXACT = new Set([
  "/healthz",
  "/v1/healthz",
  "/v1/readyz",
  "/v1/auth/status",
  "/v1/auth/login",
  "/v1/auth/bootstrap",
  "/v1/auth/oidc/login",
  "/v1/auth/oidc/callback",
  "/v1/auth/oidc/status",
]);

/** Admin-only mutations */
const ADMIN_WRITE_PREFIXES = [
  "/v1/org/connectors",
  "/v1/org/model-profiles",
  "/v1/org/prompt-pack",
  "/v1/org/policy",
  "/v1/org/langfuse",
  "/v1/auth/users",
  "/v1/orgs",
];

export function isAuthExempt(path: string): boolean {
  if (EXEMPT_EXACT.has(path)) return true;
  if (path.startsWith("/v1/webhooks/")) return true;
  if (path.startsWith("/v1/auth/oidc/")) return true;
  // SCIM uses its own bearer token (STEW_SCIM_TOKEN) — not session cookies
  if (path.startsWith("/scim/")) return true;
  // GitHub App setup callback only (browser redirect from GitHub — state is HMAC-signed)
  if (path.startsWith("/v1/scm/github/setup")) return true;
  if (path.startsWith("/v1/scm/github/manifest/callback")) return true;
  return false;
}

export function resolveCorsOrigin(): string | string[] {
  const explicit = process.env.CORS_ORIGIN;
  if (explicit && explicit.trim()) {
    const parts = explicit.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length === 1 ? parts[0]! : parts;
  }
  if (!process.env.STEW_API_KEY && process.env.STEW_AUTH_STRICT !== "1") return "*";
  return process.env.CORS_ORIGIN_STRICT === "1" ? "null" : "*";
}

function extractBearer(c: Context): string | undefined {
  const auth = c.req.header("Authorization") ?? c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim() || undefined;
  }
  // EventSource cannot set Authorization — allow access_token query on SSE
  const q = c.req.query("access_token") ?? c.req.query("token");
  if (q?.trim()) return q.trim();
  return undefined;
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isAdminWritePath(path: string): boolean {
  // Allow POST /v1/orgs for any authenticated admin/reviewer via later check
  if (path === "/v1/orgs" && true) {
    /* membership enforced in route */
  }
  return ADMIN_WRITE_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

export function effectiveRole(c: Context): UserRole {
  const role = c.get("role") as UserRole | undefined;
  if (role === "admin" || role === "reviewer" || role === "viewer") return role;
  if (c.get("authMode") === "api_key" || c.get("authMode") === "dev_open") {
    return "admin";
  }
  return "viewer";
}

/**
 * Map org membership role onto product role for this request (stricter wins).
 */
function mapOrgRoleToProduct(orgRole: OrgRole): UserRole {
  if (orgRole === "owner" || orgRole === "admin") return "admin";
  if (orgRole === "reviewer") return "reviewer";
  return "viewer";
}

/** Paths usable before the user belongs to any org (onboarding / invite accept). */
function isNoOrgAllowedPath(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (path === "/v1/auth/me" || path === "/v1/auth/logout" || path === "/v1/auth/me/password") {
    return true;
  }
  if (path.startsWith("/v1/auth/me")) return true;
  if (path === "/v1/identity/status") return true;
  if (path === "/v1/orgs" && (m === "GET" || m === "POST")) return true;
  if (path === "/v1/orgs/invitations/accept" && m === "POST") return true;
  // Plan catalog for onboarding before org exists
  if (path === "/v1/billing/status" && m === "GET") return true;
  return false;
}

async function bindOrgContext(c: Context): Promise<Response | null> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  // Skip membership for health/auth/webhooks (already exempt mostly)
  if (isAuthExempt(path)) return null;

  const user = c.get("user") as PublicAuthUser | undefined;
  const authMode = c.get("authMode") as string | undefined;
  const store = getTenancyStore();
  const headerOrg =
    c.req.header("X-Org-Id") ?? c.req.header("x-org-id") ?? undefined;
  const homeOrg = (user as PublicAuthUser | undefined)?.orgId?.trim() || undefined;
  const requested = headerOrg || homeOrg || "local";

  try {
    const membership = await store.assertMembership(user?.id, requested, {
      authMode,
    });
    c.set("orgId", requested);
    c.set("orgRole", membership.role);
    // Elevate/restrict product role by org membership when session user
    if ((authMode === "session" || authMode === "oidc_jwt") && membership.role) {
      const productFromOrg = mapOrgRoleToProduct(membership.role);
      const sessionRole = (user?.role ?? "viewer") as UserRole;
      // Use the more restrictive of session global role and org role for admin writes
      const rank = (r: UserRole) => (r === "admin" ? 3 : r === "reviewer" ? 2 : 1);
      c.set("role", rank(productFromOrg) < rank(sessionRole) ? productFromOrg : sessionRole);
      // Prefer org-derived for admin capability when owner/admin in org
      if (membership.role === "owner" || membership.role === "admin") {
        if (sessionRole === "admin" || membership.role === "owner") {
          c.set("role", productFromOrg);
        }
      }
    }
    return null;
  } catch (err) {
    // Session/OIDC: prefer real memberships over a stale browser X-Org-Id (e.g. cached "local")
    if (user?.id && (authMode === "session" || authMode === "oidc_jwt")) {
      const orgs = await store.listOrgsForUser(user.id);
      if (orgs[0]) {
        c.set("orgId", orgs[0].id);
        c.set("orgRole", orgs[0].role);
        c.set("role", mapOrgRoleToProduct(orgs[0].role));
        return null;
      }
      // Zero memberships — allow onboarding routes only
      if (isNoOrgAllowedPath(path, method)) {
        c.set("orgId", undefined);
        c.set("needsOrg", true);
        return null;
      }
      return c.json(
        {
          error: "org_required",
          code: "ORG_REQUIRED",
          message:
            "You are not a member of any organization yet. Create one or ask an org admin to invite you.",
        },
        403,
      );
    }
    if (authMode === "dev_open" || authMode === "api_key") {
      c.set("orgId", requested);
      return null;
    }
    const status = (err as { status?: number })?.status ?? 403;
    return c.json(
      {
        error: "forbidden",
        message: err instanceof Error ? err.message : "org access denied",
      },
      status as 403,
    );
  }
}

export function apiAuthMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const path = c.req.path;
    const method = c.req.method.toUpperCase();

    // Stash raw header but do NOT trust yet
    const orgHeader = c.req.header("X-Org-Id") ?? c.req.header("x-org-id");
    if (orgHeader) c.set("orgIdRequested", orgHeader);

    if (isAuthExempt(path)) {
      return next();
    }

    const status = await globalAuthStore.getStatus();
    const bearer = extractBearer(c);

    const strict =
      process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production";

    // Authenticate when credentials present (even in open mode)
    if (bearer) {
      const apiUser = globalAuthStore.resolveApiKey(bearer);
      if (apiUser) {
        c.set("user", apiUser);
        c.set("authMode", "api_key");
        c.set("role", "admin");
        if (!c.get("orgId")) c.set("orgId", apiUser.orgId);
        const orgErr = await bindOrgContext(c);
        if (orgErr) return orgErr;
        return enforceRbac(c, next, path, method);
      }
      // Prefer Keycloak/OIDC JWT (stateless) — no server session store
      try {
        const { isLikelyJwt, resolveUserFromJwtBearer } = await import("../auth/jwt-bearer.js");
        if (isLikelyJwt(bearer)) {
          const jwtUser = await resolveUserFromJwtBearer(bearer);
          if (jwtUser) {
            c.set("user", jwtUser);
            c.set("authMode", "oidc_jwt");
            c.set("role", jwtUser.role);
            if (!c.get("orgId")) c.set("orgId", jwtUser.orgId);
            const orgErr = await bindOrgContext(c);
            if (orgErr) return orgErr;
            return enforceRbac(c, next, path, method);
          }
        }
      } catch {
        /* fall through to session / reject */
      }
      // Legacy Codesteward session token (local identity / older OIDC RP flow)
      const sess = await globalAuthStore.resolveToken(bearer);
      if (sess) {
        c.set("user", sess);
        c.set("authMode", "session");
        c.set("role", sess.role);
        if (!c.get("orgId")) c.set("orgId", sess.orgId);
        const orgErr = await bindOrgContext(c);
        if (orgErr) return orgErr;
        return enforceRbac(c, next, path, method);
      }
      if (status.authRequired || strict) {
        return c.json(
          {
            error: "unauthorized",
            message:
              "Invalid token. Use Keycloak access_token (Bearer JWT), session from local login, or STEW_API_KEY.",
          },
          401,
        );
      }
    }

    if (!status.authRequired && !strict) {
      if (!warnedDev) {
        warnedDev = true;
        console.warn(
          "[api] No users and STEW_API_KEY unset — API auth open (dev). Bootstrap an admin, set STEW_API_KEY, or STEW_AUTH_STRICT=1.",
        );
      }
      c.set("authMode", "dev_open");
      c.set("role", "admin");
      c.set("orgId", orgHeader ?? "local");
      return next();
    }

    return c.json(
      {
        error: "unauthorized",
        message:
          "Authorization: Bearer <access_token|session-token|STEW_API_KEY> required",
      },
      401,
    );
  };
}

async function enforceRbac(
  c: Context,
  next: Next,
  path: string,
  method: string,
): Promise<Response | void> {
  const role = effectiveRole(c);

  if (
    path === "/v1/auth/logout" ||
    path === "/v1/auth/me" ||
    path === "/v1/auth/me/password" ||
    path.startsWith("/v1/auth/oidc/") ||
    path === "/v1/auth/status" ||
    path === "/v1/auth/login" ||
    path === "/v1/auth/bootstrap"
  ) {
    return next();
  }

  if (!isReadMethod(method)) {
    if (role === "viewer") {
      return c.json(
        { error: "forbidden", message: "viewer role is read-only" },
        403,
      );
    }
    // Member management requires admin
    if (
      (path.includes("/members") || path.includes("/invitations")) &&
      role !== "admin" &&
      (c.get("orgRole") as string) !== "owner" &&
      (c.get("orgRole") as string) !== "admin"
    ) {
      return c.json(
        { error: "forbidden", message: "admin role required for member management" },
        403,
      );
    }
    if (isAdminWritePath(path) && role !== "admin") {
      // Self-service org create (SaaS onboarding) — any authenticated non-viewer write role
      // Viewers may also create their first org (new IdP signups default to reviewer, but be open)
      if (path === "/v1/orgs" && method === "POST") {
        return next();
      }
      // Allow renaming own org when org membership is admin/owner
      if (
        method === "PATCH" &&
        /^\/v1\/orgs\/[^/]+$/.test(path) &&
        ((c.get("orgRole") as string) === "admin" ||
          (c.get("orgRole") as string) === "owner")
      ) {
        return next();
      }
      return c.json(
        {
          error: "forbidden",
          message: "admin role required for this resource",
        },
        403,
      );
    }
  }

  return next();
}

declare module "hono" {
  interface ContextVariableMap {
    orgId?: string;
    orgIdRequested?: string;
    orgRole?: OrgRole | string;
    /** True when the user is authenticated but has zero org memberships */
    needsOrg?: boolean;
    user?: PublicAuthUser;
    role?: UserRole | string;
    authMode?: "api_key" | "session" | "dev_open" | "oidc_jwt";
  }
}
