/**
 * Browser OIDC (SPA) against Keycloak — Authorization Code + PKCE.
 * Access token is sent as Bearer to the API; API validates JWT via JWKS (no server session).
 */
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

export type SpaOidcConfig = {
  issuer: string;
  clientId: string;
  scopes?: string[];
};

let manager: UserManager | null = null;
let initPromise: Promise<UserManager | null> | null = null;

function isLoopbackUrl(url: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
}

function pageIsLoopback(): boolean {
  if (typeof window === "undefined") return true;
  return /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
}

/**
 * Prefer runtime page origin for cloud / non-local deploys.
 * Build-time Vite defaults often bake localhost (Docker UI image) — never use those
 * when the SPA is served from a public host.
 */
function redirectUri(): string {
  const env = import.meta.env.VITE_OIDC_REDIRECT_URI as string | undefined;
  if (env?.trim() && !(isLoopbackUrl(env) && !pageIsLoopback())) {
    return env.replace(/\/$/, "");
  }
  return `${window.location.origin}/auth/callback`;
}

function postLogoutRedirectUri(): string {
  const env = import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI as string | undefined;
  if (env?.trim() && !(isLoopbackUrl(env) && !pageIsLoopback())) {
    return env;
  }
  return `${window.location.origin}/`;
}

function fromEnv(): SpaOidcConfig | null {
  const issuer = (import.meta.env.VITE_OIDC_ISSUER as string | undefined)?.replace(/\/$/, "");
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;
  if (issuer && clientId) {
    // Ignore bake-time localhost issuer when the page is not on localhost (cloud VM, etc.)
    if (isLoopbackUrl(issuer) && !pageIsLoopback()) {
      return null;
    }
    return {
      issuer,
      clientId,
      scopes: ((import.meta.env.VITE_OIDC_SCOPES as string | undefined) ?? "openid profile email")
        .split(/\s+/)
        .filter(Boolean),
    };
  }
  return null;
}

function parseOidcReady(j: {
  status?: string;
  issuer?: string;
  clientId?: string;
  scopes?: string[];
}): SpaOidcConfig | null {
  if (j.status === "ready" && j.issuer && j.clientId) {
    return {
      issuer: j.issuer.replace(/\/$/, ""),
      clientId: j.clientId,
      scopes: j.scopes?.length ? j.scopes : ["openid", "profile", "email"],
    };
  }
  return null;
}

/**
 * SPA OIDC config: build-time Vite env, then runtime API.
 * Prefer same-origin `/v1/...` (nginx proxy) so Docker UI works without VITE_API_URL.
 */
export async function loadSpaOidcConfig(): Promise<SpaOidcConfig | null> {
  const env = fromEnv();
  if (env) return env;

  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  const paths = [`${base}/v1/auth/oidc/status`, `${base}/v1/auth/status`];

  for (const path of paths) {
    try {
      const res = await fetch(path, { credentials: "same-origin" });
      if (!res.ok) continue;
      const j = (await res.json()) as {
        status?: string;
        issuer?: string;
        clientId?: string;
        scopes?: string[];
        oidc?: {
          status?: string;
          issuer?: string;
          clientId?: string;
          scopes?: string[];
        };
      };
      // /v1/auth/oidc/status is flat; /v1/auth/status nests under oidc
      const cfg = parseOidcReady(j.oidc ? { ...j.oidc, status: j.oidc.status } : j);
      if (cfg) return cfg;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function getOidcManager(): Promise<UserManager | null> {
  if (manager) return manager;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = await loadSpaOidcConfig();
    if (!cfg) return null;
    manager = new UserManager({
      authority: cfg.issuer,
      client_id: cfg.clientId,
      redirect_uri: redirectUri(),
      post_logout_redirect_uri: postLogoutRedirectUri(),
      response_type: "code",
      scope: (cfg.scopes ?? ["openid", "profile", "email"]).join(" "),
      automaticSilentRenew: true,
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      // Keycloak: include id_token in logout
      loadUserInfo: false,
    });
    manager.events.addAccessTokenExpired(() => {
      void manager?.signinSilent().catch(() => {
        void manager?.removeUser();
      });
    });
    return manager;
  })();
  return initPromise;
}

export async function getOidcUser(): Promise<User | null> {
  const m = await getOidcManager();
  if (!m) return null;
  try {
    return await m.getUser();
  } catch {
    return null;
  }
}

/** Access token for Authorization: Bearer (preferred over app session tokens). */
export async function getAccessToken(): Promise<string | null> {
  const user = await getOidcUser();
  if (!user || user.expired) {
    if (user?.expired) {
      const m = await getOidcManager();
      try {
        const renewed = await m?.signinSilent();
        return renewed?.access_token ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
  return user.access_token ?? null;
}

export async function isOidcAuthenticated(): Promise<boolean> {
  const t = await getAccessToken();
  return Boolean(t);
}

export async function startOidcLogin(returnTo?: string): Promise<void> {
  const m = await getOidcManager();
  if (!m) throw new Error("OIDC is not configured");
  const state = returnTo && returnTo.startsWith("/") ? returnTo : "/dashboard";
  await m.signinRedirect({ state });
}

export async function completeOidcLogin(): Promise<{ returnTo: string }> {
  const m = await getOidcManager();
  if (!m) throw new Error("OIDC is not configured");
  const user = await m.signinRedirectCallback();
  const returnTo =
    typeof user.state === "string" && user.state.startsWith("/") ? user.state : "/dashboard";
  return { returnTo };
}

export async function startOidcLogout(): Promise<void> {
  const m = await getOidcManager();
  // Always clear local OIDC user
  try {
    await m?.removeUser();
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem("cs-session-token");
    sessionStorage.removeItem("cs-oidc-id-token");
  } catch {
    /* ignore */
  }
  if (m) {
    await m.signoutRedirect();
    return;
  }
  window.location.replace("/");
}

export async function oidcReady(): Promise<boolean> {
  const m = await getOidcManager();
  return Boolean(m);
}
