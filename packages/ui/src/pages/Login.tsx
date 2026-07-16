import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ThemeToggle } from "../components/Layout";
import { Logo } from "../components/Logo";
import { useToast } from "../components/Toast";
import { api, resolveActiveOrg, setSessionToken, getSessionToken } from "../lib/api";
import { getAccessToken, oidcReady, startOidcLogin } from "../lib/oidc";

/**
 * Login entrypoint.
 *
 * Keycloak mode (STEW_IDENTITY_MODE=keycloak or SPA OIDC configured):
 *   Always redirect to IdP. Local email/password is NOT shown except break-glass
 *   `/login?local=1`.
 *
 * Local / open mode (no Keycloak): email/password or bootstrap form.
 */
export function Login() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("…");
  const [redirectError, setRedirectError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("Checking login…");
  /** IdP shell (no password form). True whenever Keycloak/SPA OIDC is the identity path. */
  const [idpOnly, setIdpOnly] = useState(false);
  const forceLocal = searchParams.get("local") === "1";

  useEffect(() => {
    let alive = true;
    (async () => {
      const oidcErr = searchParams.get("error");
      if (oidcErr) {
        setRedirectError(oidcErr);
        setStatusLine("Sign-in failed");
        setIdpOnly(true);
        setLoading(false);
        const next = new URLSearchParams(searchParams);
        next.delete("error");
        next.delete("code");
        setSearchParams(next, { replace: true });
        return;
      }

      // Explicit break-glass: skip IdP redirect and show local form only.
      if (forceLocal) {
        try {
          const s = await api.authStatus();
          if (!alive) return;
          setMode(s.mode);
          setBootstrapRequired(Boolean(s.bootstrapRequired));
        } catch {
          setMode("unreachable");
        }
        setIdpOnly(false);
        setLoading(false);
        return;
      }

      // Already have Keycloak access token
      try {
        const at = await getAccessToken();
        if (at) {
          try {
            const me = await api.authMe();
            if (me.user && alive) {
              const { needsOrg } = await resolveActiveOrg();
              navigate(needsOrg ? "/onboarding" : "/dashboard", { replace: true });
              return;
            }
          } catch {
            /* token present but API rejected — continue to IdP or error shell */
          }
        }
      } catch {
        /* continue */
      }

      // Legacy session token (local identity) — only useful outside Keycloak
      if (getSessionToken() || localStorage.getItem("cs-api-key")) {
        try {
          const me = await api.authMe();
          if (me.user && alive) {
            const { needsOrg } = await resolveActiveOrg();
            navigate(needsOrg ? "/onboarding" : "/dashboard", { replace: true });
            return;
          }
        } catch {
          /* fall through */
        }
      }

      const spa = await oidcReady().catch(() => false);

      try {
        const s = await api.authStatus();
        if (!alive) return;
        setMode(s.mode);

        const keycloakMode =
          Boolean(s.keycloakIdentity) || s.identityMode === "keycloak";

        // Keycloak (or SPA OIDC ready): never fall through to local password form
        if (keycloakMode || spa) {
          setIdpOnly(true);
          if (!spa) {
            setRedirectError(
              "Platform identity is Keycloak, but OIDC is not configured for the UI (issuer/client).",
            );
            setStatusLine("Sign-in unavailable");
            setLoading(false);
            return;
          }
          setStatusLine("Redirecting to sign-in…");
          const from =
            searchParams.get("returnTo") ||
            (typeof window !== "undefined" &&
              (window.history.state as { from?: string } | null)?.from) ||
            "/dashboard";
          const dest =
            typeof from === "string" && from.startsWith("/") && !from.startsWith("/login")
              ? from
              : "/dashboard";
          try {
            await startOidcLogin(dest);
            return;
          } catch (err) {
            setRedirectError(
              err instanceof Error ? err.message : "Could not start sign-in",
            );
            setLoading(false);
            return;
          }
        }

        // True local / open install (no Keycloak)
        setBootstrapRequired(Boolean(s.bootstrapRequired));
        setIdpOnly(false);
        setLoading(false);
      } catch {
        // API down (e.g. Postgres recovery). If SPA OIDC is baked in, stay on IdP path —
        // never show the local password form just because the API is unreachable.
        if (!alive) return;
        setMode("unreachable");
        if (spa) {
          setIdpOnly(true);
          setRedirectError(
            "API is unreachable (database or API may be restarting). " +
              "This install uses Keycloak for sign-in — local password login is not available. " +
              "Wait for the API to recover, then try again.",
          );
          setStatusLine("Sign-in unavailable");
          setLoading(false);
          return;
        }
        setIdpOnly(false);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, searchParams, setSearchParams, forceLocal]);

  async function submitLocal(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (bootstrapRequired) {
        const res = await api.authBootstrap({
          email,
          password,
          name: name || undefined,
        });
        setSessionToken(res.token);
        try {
          localStorage.setItem("cs-user", JSON.stringify(res.user));
        } catch {
          /* ignore */
        }
        toast.success(`Admin ${res.user.email} created`);
        navigate("/dashboard", { replace: true });
      } else {
        const res = await api.authLogin({ email, password });
        setSessionToken(res.token);
        try {
          localStorage.setItem("cs-user", JSON.stringify(res.user));
        } catch {
          /* ignore */
        }
        toast.success(
          `Welcome, ${res.user.displayName || res.user.name || res.user.email}`,
        );
        const rt = searchParams.get("returnTo");
        navigate(rt && rt.startsWith("/") ? rt : "/dashboard", { replace: true });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function retryIdp() {
    setRedirectError(null);
    setStatusLine("Redirecting to sign-in…");
    setLoading(true);
    try {
      // Re-check API briefly so a recovering DB is noticed
      try {
        await api.authStatus();
      } catch {
        /* still start IdP — browser can reach Keycloak even if API is down */
      }
      const from = searchParams.get("returnTo") || "/dashboard";
      await startOidcLogin(from.startsWith("/") && !from.startsWith("/login") ? from : "/dashboard");
    } catch (err) {
      setRedirectError(err instanceof Error ? err.message : "Could not start sign-in");
      setLoading(false);
    }
  }

  if (idpOnly || loading) {
    return (
      <div className="login-shell">
        <div className="login-theme-bar">
          <ThemeToggle compact />
        </div>
        <div className="login-card" style={{ textAlign: "center" }}>
          <Logo variant="wordmark" size={40} className="login-wordmark" />
          <p className="muted" style={{ marginTop: "1.25rem" }}>
            {redirectError ? "Sign-in unavailable" : statusLine}
          </p>
          {redirectError && (
            <>
              <p
                className="muted"
                style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: "0.5rem" }}
              >
                {redirectError}
              </p>
              <button
                type="button"
                className="primary sm"
                style={{ marginTop: "1rem", width: "100%" }}
                onClick={() => void retryIdp()}
              >
                Try sign-in again
              </button>
              <button
                type="button"
                className="ghost sm"
                style={{ marginTop: "0.5rem", width: "100%" }}
                onClick={() => navigate("/", { replace: true })}
              >
                Back to home
              </button>
            </>
          )}
        </div>
        <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.75rem", textAlign: "center" }}>
          © {new Date().getFullYear()} bitkaio LLC · All rights reserved
        </p>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-theme-bar">
        <ThemeToggle compact />
      </div>
      <div className="login-card">
        <div className="login-brand login-brand-official">
          <Logo variant="wordmark" size={48} className="login-wordmark" />
          <p className="muted login-tagline">Self-hosted review · gate &amp; stewardship</p>
        </div>

        <div className="login-badge mono">
          {forceLocal ? "break-glass local" : bootstrapRequired ? "bootstrap" : "local"}
        </div>

        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.25rem" }}>
          {bootstrapRequired ? "Create admin" : "Sign in"}
        </h2>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
          {forceLocal
            ? "Break-glass local identity (/login?local=1). Prefer Keycloak for normal sign-in."
            : bootstrapRequired
              ? "First-run bootstrap — this account gets the admin role."
              : "Local identity mode (Keycloak is not configured for this deployment)."}
        </p>

        <form className="stack" onSubmit={(e) => void submitLocal(e)}>
          {bootstrapRequired && (
            <div className="field">
              <label>Display name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Admin"
                autoComplete="name"
              />
            </div>
          )}
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoComplete="username"
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={bootstrapRequired ? "new-password" : "current-password"}
            />
          </div>
          <button type="submit" className="primary" disabled={busy} style={{ width: "100%" }}>
            {busy
              ? "Working…"
              : bootstrapRequired
                ? "Create admin & continue"
                : "Sign in"}
          </button>
        </form>

        {mode === "dev_open" && (
          <button
            type="button"
            className="ghost"
            style={{ width: "100%", marginTop: 12 }}
            onClick={() => navigate("/dashboard", { replace: true })}
          >
            Continue without login (dev open)
          </button>
        )}

        <button
          type="button"
          className="ghost"
          style={{ width: "100%", marginTop: 12 }}
          onClick={() => navigate("/", { replace: true })}
        >
          Back to home
        </button>
      </div>
      <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.75rem", textAlign: "center" }}>
        © {new Date().getFullYear()} bitkaio LLC · All rights reserved
      </p>
    </div>
  );
}
