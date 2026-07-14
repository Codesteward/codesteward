/**
 * Stateless API auth: validate Keycloak (OIDC) access tokens via JWKS.
 * No server-side session store required for browser users.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  getOidcEnvConfig,
  getOidcTrustedIssuers,
  toInternalOidcUrl,
} from "./oidc.js";
import type { OidcClaims } from "../identity/claims.js";
import { resolveOidcUser } from "../identity/sync.js";
import type { PublicAuthUser } from "../auth-store.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUriUsed: string | undefined;

/** sub → { user, exp } short cache so we don't hit DB on every request */
const userCache = new Map<string, { user: PublicAuthUser; exp: number }>();

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

async function getJwks() {
  const cfg = getOidcEnvConfig();
  if (!cfg) return null;
  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OIDC discovery failed ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (!doc.jwks_uri) throw new Error("OIDC discovery missing jwks_uri");
  const jwksUri = toInternalOidcUrl(doc.jwks_uri);
  if (!jwks || jwksUriUsed !== jwksUri) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksUriUsed = jwksUri;
  }
  return { jwks, cfg, discoveryIssuer: doc.issuer };
}

function clientAllowed(payload: JWTPayload, clientId: string): boolean {
  const azp = typeof payload.azp === "string" ? payload.azp : undefined;
  if (azp === clientId) return true;
  const aud = payload.aud;
  if (typeof aud === "string" && aud === clientId) return true;
  if (Array.isArray(aud) && aud.includes(clientId)) return true;
  // Keycloak access tokens often use aud=account and azp=client
  if (azp) return azp === clientId;
  return false;
}

/**
 * Verify a Bearer JWT and map to Codesteward user (JIT shadow).
 * Returns null if token is not a valid OIDC access/id token for our client.
 */
export async function resolveUserFromJwtBearer(
  token: string,
): Promise<PublicAuthUser | null> {
  if (!looksLikeJwt(token)) return null;
  const cfg = getOidcEnvConfig();
  if (!cfg) return null;

  try {
    const ctx = await getJwks();
    if (!ctx) return null;
    const trusted = getOidcTrustedIssuers();
    const { payload } = await jwtVerify(token, ctx.jwks, {
      issuer: trusted.length > 0 ? trusted : cfg.issuer,
      // Don't pass audience — Keycloak access tokens use aud=account
    });

    if (!clientAllowed(payload, cfg.clientId)) {
      // Allow id_token used as bearer (aud = client_id) already covered;
      // reject tokens for other clients
      const azp = payload.azp;
      const aud = payload.aud;
      const ok =
        azp === cfg.clientId ||
        aud === cfg.clientId ||
        (Array.isArray(aud) && aud.includes(cfg.clientId));
      if (!ok) return null;
    }

    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : 0;
    if (exp && exp < Date.now()) return null;

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (sub) {
      const hit = userCache.get(sub);
      if (hit && hit.exp > Date.now()) return hit.user;
    }

    const claims = payload as OidcClaims & JWTPayload;
    // Need email for product identity
    if (!claims.email && typeof payload.preferred_username === "string") {
      const pu = payload.preferred_username;
      if (pu.includes("@")) claims.email = pu;
    }
    if (!claims.email) return null;

    const user = await resolveOidcUser(claims);
    if (sub) {
      // Cache until token exp or 2 minutes, whichever sooner
      const cacheExp = exp ? Math.min(exp, Date.now() + 120_000) : Date.now() + 60_000;
      userCache.set(sub, { user, exp: cacheExp });
    }
    return user;
  } catch {
    return null;
  }
}

export function isLikelyJwt(token: string): boolean {
  return looksLikeJwt(token);
}
