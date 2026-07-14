/**
 * Platform operator RBAC — install-wide settings (license, runtime knobs, health tools).
 * Distinct from tenant org admin (members, models, org rename, connectors).
 *
 * Grant via:
 * - users.platform_admin = true
 * - STEW_PLATFORM_ADMIN_EMAILS=a@x.com,b@y.com
 * - auth modes api_key / dev_open (ops break-glass)
 */
import type { PublicAuthUser } from "./auth-store.js";

export function isPlatformAdmin(
  user: PublicAuthUser | null | undefined,
  authMode?: string | null,
): boolean {
  if (authMode === "api_key" || authMode === "dev_open") return true;
  if (!user?.id || user.id === "api_key") {
    // bare API key is treated as platform operator
    return authMode === "api_key";
  }
  if (user.platformAdmin === true) return true;
  const emails = (process.env.STEW_PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length && emails.includes(user.email.toLowerCase())) return true;
  return false;
}

export function requirePlatformAdmin(
  user: PublicAuthUser | null | undefined,
  authMode?: string | null,
): void {
  if (!isPlatformAdmin(user, authMode)) {
    throw Object.assign(
      new Error(
        "platform operator required — tenant org admins cannot change install-wide settings",
      ),
      { status: 403 },
    );
  }
}
