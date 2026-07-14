/**
 * Identity mode — where multi-tenant users/orgs/roles live.
 *
 *   keycloak — Keycloak is SoT; login only via OIDC; Members UI drives KC Admin API
 *   local    — local users.json / Postgres users + optional OIDC JIT (dev / offline)
 *
 * Default: keycloak when OIDC_ISSUER is set, else local.
 */
export type IdentityMode = "keycloak" | "local";

export function getIdentityMode(env: NodeJS.ProcessEnv = process.env): IdentityMode {
  const raw = (env.STEW_IDENTITY_MODE ?? "").trim().toLowerCase();
  if (raw === "keycloak" || raw === "kc" || raw === "oidc") return "keycloak";
  if (raw === "local" || raw === "file" || raw === "native") return "local";
  // Auto: prefer Keycloak when OIDC is configured
  if (env.OIDC_ISSUER?.trim()) return "keycloak";
  return "local";
}

export function isKeycloakIdentityMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getIdentityMode(env) === "keycloak";
}
