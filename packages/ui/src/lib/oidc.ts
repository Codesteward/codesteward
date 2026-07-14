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

function redirectUri(): string {
  const env = import.meta.env.VITE_OIDC_REDIRECT_URI as string | undefined;
  if (env?.trim()) return env.replace(/\/$/, "");
  return `${window.location.origin}/auth/callback`;
}

function postLogoutRedirectUri(): string {
  const env = import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI as string | undefined;
  if (env?.trim()) return env;
  return `${window.location.origin}/`;
}

function fromEnv(): SpaOidcConfig | null {
  const issuer = (import.meta.env.VITE_OIDC_ISSUER as string | undefined)?.replace(/\/$/, "");
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;
  if (issuer && clientId) {
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

export async function loadSpaOidcConfig(): Promise<SpaOidcConfig | null> {
  const env = fromEnv();
  if (env) return env;
  try {
    const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
    const res = await fetch(`${base}/v1/auth/oidc/status`);
    if (!res.ok) return null;
    const j = (await res.json()) as {
      status?: string;
      issuer?: string;
      clientId?: string;
      scopes?: string[];
    };
    if (j.status === "ready" && j.issuer && j.clientId) {
      return {
        issuer: j.issuer.replace(/\/$/, ""),
        clientId: j.clientId,
        scopes: j.scopes?.length ? j.scopes : ["openid", "profile", "email"],
      };
    }
  } catch {
    /* ignore */
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
