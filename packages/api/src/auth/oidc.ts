/**
 * Real OIDC relying party (Keycloak / any OIDC IdP).
 * - Discovery + JWKS
 * - Authorization code + PKCE
 * - ID token verification
 * Status is only: ready | misconfigured | optional_not_configured
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { mapProductRole, type OidcClaims } from "../identity/claims.js";

export type OidcStatus =
  | { status: "optional_not_configured" }
  | { status: "misconfigured"; issuer?: string; error: string }
  | {
      status: "ready";
      issuer: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      jwksUri: string;
      endSessionEndpoint?: string;
      clientId: string;
      scopes: string[];
      /** SPA should use browser OIDC (PKCE); API only validates JWT */
      spaAuth: true;
    };

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

let cachedDiscovery: { at: number; doc: Discovery; issuer: string } | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export function getOidcEnvConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) return null;
  const publicBase = (process.env.STEW_PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const redir =
    process.env.OIDC_REDIRECT_URI ?? `${publicBase}/login/oidc/callback`;
  return {
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    redirectUri: redir,
    scopes: (process.env.OIDC_SCOPES ?? "openid profile email").split(/\s+/).filter(Boolean),
  };
}

/**
 * Browser-facing issuer. OIDC_ISSUER is often Docker-internal (http://keycloak:8083/…)
 * for API→IdP network; browsers need OIDC_PUBLIC_ISSUER (http://localhost:8083/…).
 */
export function getOidcPublicIssuer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.OIDC_PUBLIC_ISSUER?.replace(/\/$/, "") ||
    env.OIDC_ISSUER?.replace(/\/$/, "") ||
    undefined
  );
}

/**
 * Issuers accepted on ID token `iss` verification.
 *
 * Keycloak (and most IdPs) set `iss` from the hostname the browser used for login
 * (OIDC_PUBLIC_ISSUER), while server-side discovery uses OIDC_ISSUER (Docker DNS).
 * Accept both so jwtVerify does not throw `unexpected "iss" claim value`.
 */
export function getOidcTrustedIssuers(env: NodeJS.ProcessEnv = process.env): string[] {
  const internal = env.OIDC_ISSUER?.replace(/\/$/, "");
  const pub = env.OIDC_PUBLIC_ISSUER?.replace(/\/$/, "");
  const out: string[] = [];
  for (const v of [internal, pub]) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Rewrite discovery URLs that use the internal issuer host to the public issuer. */
export function toPublicOidcUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const internal = env.OIDC_ISSUER?.replace(/\/$/, "");
  const pub = env.OIDC_PUBLIC_ISSUER?.replace(/\/$/, "");
  if (!url || !internal || !pub || internal === pub) return url;
  if (url.startsWith(internal)) return pub + url.slice(internal.length);
  // Also rewrite bare host mismatches (e.g. discovery returns keycloak hostname only)
  try {
    const u = new URL(url);
    const i = new URL(internal);
    const p = new URL(pub);
    if (u.host === i.host) {
      u.protocol = p.protocol;
      u.host = p.host;
      return u.toString().replace(/\/$/, "") === url.replace(/\/$/, "")
        ? u.toString()
        : u.toString();
    }
  } catch {
    /* ignore */
  }
  return url;
}

/**
 * Server-side fetch URL: rewrite public issuer host → internal when they differ
 * (browser discovery may advertise localhost; API must call keycloak:8083).
 */
export function toInternalOidcUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const internal = env.OIDC_ISSUER?.replace(/\/$/, "");
  const pub = env.OIDC_PUBLIC_ISSUER?.replace(/\/$/, "");
  if (!url || !internal || !pub || internal === pub) return url;
  if (url.startsWith(pub)) return internal + url.slice(pub.length);
  try {
    const u = new URL(url);
    const i = new URL(internal);
    const p = new URL(pub);
    if (u.host === p.host) {
      u.protocol = i.protocol;
      u.host = i.host;
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return url;
}

async function discover(issuer: string): Promise<Discovery> {
  if (cachedDiscovery && cachedDiscovery.issuer === issuer && Date.now() - cachedDiscovery.at < 300_000) {
    return cachedDiscovery.doc;
  }
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OIDC discovery failed ${res.status} for ${url}`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("OIDC discovery missing endpoints");
  }
  // Normalize server-side endpoints to internal host when dual-issuer is configured
  doc.token_endpoint = toInternalOidcUrl(doc.token_endpoint);
  doc.jwks_uri = toInternalOidcUrl(doc.jwks_uri);
  cachedDiscovery = { at: Date.now(), doc, issuer };
  jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  return doc;
}

export async function getOidcStatus(): Promise<OidcStatus> {
  const cfg = getOidcEnvConfig();
  if (!cfg) return { status: "optional_not_configured" };
  try {
    const doc = await discover(cfg.issuer);
    // Never expose Docker-internal hostnames to the browser/UI
    const publicIssuer = getOidcPublicIssuer() ?? cfg.issuer;
    return {
      status: "ready",
      issuer: publicIssuer,
      authorizationEndpoint: toPublicOidcUrl(doc.authorization_endpoint),
      tokenEndpoint: toPublicOidcUrl(doc.token_endpoint),
      jwksUri: toPublicOidcUrl(doc.jwks_uri),
      endSessionEndpoint: doc.end_session_endpoint
        ? toPublicOidcUrl(doc.end_session_endpoint)
        : undefined,
      clientId: cfg.clientId,
      scopes: cfg.scopes,
      spaAuth: true,
    };
  } catch (err) {
    return {
      status: "misconfigured",
      issuer: getOidcPublicIssuer() ?? cfg.issuer,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createOidcState(): string {
  return b64url(randomBytes(24));
}

/** In-memory OIDC login state (dev/self-host). Production can swap to Redis. */
const pendingLogins = new Map<
  string,
  { verifier: string; nonce: string; createdAt: number; returnTo?: string }
>();

export function storeOidcLogin(state: string, data: { verifier: string; nonce: string; returnTo?: string }) {
  pendingLogins.set(state, { ...data, createdAt: Date.now() });
  // prune old
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of pendingLogins) {
    if (v.createdAt < cutoff) pendingLogins.delete(k);
  }
}

export function takeOidcLogin(state: string) {
  const v = pendingLogins.get(state);
  pendingLogins.delete(state);
  return v;
}

export async function buildAuthorizationUrl(opts?: { returnTo?: string }): Promise<{
  url: string;
  state: string;
}> {
  const cfg = getOidcEnvConfig();
  if (!cfg) throw new Error("OIDC not configured");
  const doc = await discover(cfg.issuer);
  const { verifier, challenge } = createPkcePair();
  const state = createOidcState();
  const nonce = createOidcState();
  storeOidcLogin(state, { verifier, nonce, returnTo: opts?.returnTo });
  // Always send the browser to the public host (never http://keycloak:…)
  const authEndpoint = toPublicOidcUrl(doc.authorization_endpoint);
  const u = new URL(authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return { url: u.toString(), state };
}

export type { OidcClaims as OidcUserClaims } from "../identity/claims.js";

export async function exchangeCode(code: string, state: string): Promise<{
  claims: OidcClaims;
  idToken: string;
  accessToken?: string;
  returnTo?: string;
}> {
  const cfg = getOidcEnvConfig();
  if (!cfg) throw new Error("OIDC not configured");
  const pending = takeOidcLogin(state);
  if (!pending) throw Object.assign(new Error("invalid or expired OIDC state"), { status: 400 });
  const doc = await discover(cfg.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: pending.verifier,
  });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  // Token + JWKS must hit the internal host when OIDC_ISSUER ≠ public issuer
  const tokenEndpoint = toInternalOidcUrl(doc.token_endpoint);
  const jwksUri = toInternalOidcUrl(doc.jwks_uri);
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw Object.assign(new Error(`token exchange failed: ${res.status} ${t.slice(0, 200)}`), {
      status: 401,
    });
  }
  const tokens = (await res.json()) as {
    id_token?: string;
    access_token?: string;
  };
  if (!tokens.id_token) throw new Error("no id_token in token response");
  // Always bind JWKS to the internal URL used for this exchange (not a stale public one)
  jwks = createRemoteJWKSet(new URL(jwksUri));
  const trustedIssuers = getOidcTrustedIssuers();
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    // Browser login stamps iss=OIDC_PUBLIC_ISSUER; discovery may use OIDC_ISSUER
    issuer: trustedIssuers.length > 0 ? trustedIssuers : cfg.issuer,
    audience: cfg.clientId,
  });
  if (!payload.nonce || payload.nonce !== pending.nonce) {
    throw new Error("OIDC nonce missing or mismatch");
  }
  return {
    claims: payload as OidcClaims & JWTPayload,
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    returnTo: pending.returnTo,
  };
}

/** Map IdP roles/groups to product role hint (never auto-owner). */
export function mapOidcRoleHint(
  claims: OidcClaims,
): "admin" | "reviewer" | "viewer" {
  return mapProductRole(claims);
}

export function safeReturnTo(r?: string): string {
  // Prefer app shell after IdP; public "/" is the marketing home (no session needed).
  if (!r || !r.startsWith("/") || r.startsWith("//") || r.includes("://")) return "/dashboard";
  if (r === "/") return "/dashboard";
  return r;
}

/** Session-token → id_token for RP-initiated logout (id_token_hint). */
const oidcIdTokensBySession = new Map<string, { idToken: string; at: number }>();

export function storeOidcIdTokenForSession(sessionToken: string, idToken: string): void {
  if (!sessionToken || !idToken) return;
  oidcIdTokensBySession.set(sessionToken, { idToken, at: Date.now() });
  // prune > 24h
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [k, v] of oidcIdTokensBySession) {
    if (v.at < cutoff) oidcIdTokensBySession.delete(k);
  }
}

export function takeOidcIdTokenForSession(sessionToken: string): string | undefined {
  const v = oidcIdTokensBySession.get(sessionToken);
  oidcIdTokensBySession.delete(sessionToken);
  return v?.idToken;
}

/**
 * Browser URL that ends the Keycloak (IdP) SSO session, then returns to the app home.
 * Without this, local logout leaves the IdP cookie and Sign-in silently re-authenticates.
 */
export async function buildOidcLogoutUrl(opts?: {
  idTokenHint?: string;
  postLogoutRedirectUri?: string;
}): Promise<string | null> {
  const cfg = getOidcEnvConfig();
  if (!cfg) return null;
  try {
    const doc = await discover(cfg.issuer);
    const endSession = doc.end_session_endpoint;
    if (!endSession) return null;
    const publicEnd = toPublicOidcUrl(endSession);
    const uiBase = (
      opts?.postLogoutRedirectUri ||
      process.env.STEW_PUBLIC_URL ||
      "http://localhost:8080"
    ).replace(/\/$/, "");
    const postLogout = uiBase.endsWith("/") ? uiBase : `${uiBase}/`;
    const u = new URL(publicEnd);
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("post_logout_redirect_uri", postLogout);
    if (opts?.idTokenHint) {
      u.searchParams.set("id_token_hint", opts.idTokenHint);
    }
    return u.toString();
  } catch {
    return null;
  }
}
