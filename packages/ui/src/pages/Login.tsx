import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ThemeToggle } from "../components/Layout";
import { Logo } from "../components/Logo";
import { useToast } from "../components/Toast";
import { api, setOrgId, setSessionToken, getSessionToken } from "../lib/api";

/**
 * Login entrypoint.
 *
 * When identity mode is Keycloak (platform IdP / OIDC):
 *   Always redirect to the themed Keycloak login. MFA, password policy, and
 *   federated SSO are configured only there — no local password form.
 *
 * Local email/password UI remains only for non-Keycloak deployments
 * (STEW_IDENTITY_MODE=local or OIDC not configured), including first-run bootstrap.
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
  /** True when platform uses Keycloak/OIDC as the sole browser login. */
  const [idpOnly, setIdpOnly] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // ── OIDC error bounce from API callback ────────────────────────────
      const oidcErr = searchParams.get("error");
      if (oidcErr && !searchParams.get("oidc_token")) {
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

      // ── OIDC return: session token in hash/query ───────────────────────
      let oidcToken = searchParams.get("oidc_token");
      let returnTo = searchParams.get("returnTo") || "/dashboard";
      let orgFromOidc: string | null = null;
      const hashRaw =
        typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
      let oidcIdToken: string | null = null;
      if (!oidcToken && hashRaw) {
        const hashParams = new URLSearchParams(hashRaw);
        oidcToken = hashParams.get("oidc_token");
        oidcIdToken = hashParams.get("id_token");
        const hashReturn = hashParams.get("returnTo");
        if (hashReturn) returnTo = hashReturn;
        orgFromOidc = hashParams.get("orgId");
      }
      if (!orgFromOidc) orgFromOidc = searchParams.get("orgId");
      if (!oidcIdToken) oidcIdToken = searchParams.get("id_token");

      if (oidcToken) {
        setSessionToken(oidcToken);
        // Persist IdP id_token for RP-initiated logout (ends Keycloak SSO session)
        if (oidcIdToken) {
          try {
            sessionStorage.setItem("cs-oidc-id-token", oidcIdToken);
          } catch {
            /* ignore */
          }
        }
        if (orgFromOidc) setOrgId(orgFromOidc);
        const next = new URLSearchParams(searchParams);
        next.delete("oidc_token");
        next.delete("returnTo");
        next.delete("orgId");
        setSearchParams(next, { replace: true });
        if (typeof window !== "undefined" && window.location.hash) {
          const qs = next.toString();
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${qs ? `?${qs}` : ""}`,
          );
        }
        try {
          const me = await api.authMe();
          if (me.user) {
            try {
              localStorage.setItem("cs-user", JSON.stringify(me.user));
            } catch {
              /* ignore */
            }
            toast.success(
              `Welcome, ${me.user.displayName || me.user.name || me.user.email}`,
            );
          }
        } catch {
          /* token may still work for later calls */
        }
        if (alive) navigate(returnTo.startsWith("/") ? returnTo : "/dashboard", { replace: true });
        return;
      }

      // Already have a session
      if (getSessionToken() || localStorage.getItem("cs-api-key")) {
        try {
          const me = await api.authMe();
          if (me.user && alive) {
            navigate("/dashboard", { replace: true });
            return;
          }
        } catch {
          /* fall through */
        }
      }

      try {
        const s = await api.authStatus();
        if (!alive) return;
        setMode(s.mode);

        const keycloakMode =
          Boolean(s.keycloakIdentity) || s.identityMode === "keycloak";
        let oidcReady = s.oidc?.status === "ready";
        if (!oidcReady) {
          try {
            const oidc = await api.oidcStatus();
            oidcReady = oidc.status === "ready";
          } catch {
            oidcReady = false;
          }
        }

        // Platform IdP is the only browser login when Keycloak + OIDC are on.
        if (keycloakMode && oidcReady) {
          setIdpOnly(true);
          setStatusLine("Redirecting to sign-in…");
          const from =
            (typeof window !== "undefined" &&
              (window.history.state as { from?: string } | null)?.from) ||
            searchParams.get("returnTo") ||
            "/dashboard";
          try {
            const res = await api.oidcLogin(from.startsWith("/") ? from : "/dashboard");
            if (!alive) return;
            if (res.url) {
              window.location.replace(res.url);
              return;
            }
            setRedirectError("Login service did not return a redirect URL.");
          } catch (err) {
            setRedirectError(
              err instanceof Error ? err.message : "Could not start sign-in",
            );
          }
          setLoading(false);
          return;
        }

        if (keycloakMode && !oidcReady) {
          setIdpOnly(true);
          setRedirectError(
            "Platform identity is Keycloak, but OIDC is not ready. Check OIDC_ISSUER and Keycloak.",
          );
          setStatusLine("Sign-in unavailable");
          setLoading(false);
          return;
        }

        // Non-Keycloak / local identity only
        setBootstrapRequired(Boolean(s.bootstrapRequired));
        setIdpOnly(false);
        setLoading(false);
      } catch {
        setMode("unreachable");
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, searchParams, setSearchParams]);

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
      const from = searchParams.get("returnTo") || "/dashboard";
      const res = await api.oidcLogin(from.startsWith("/") ? from : "/dashboard");
      if (res.url) {
        window.location.replace(res.url);
        return;
      }
      setRedirectError("Login service did not return a redirect URL.");
    } catch (err) {
      setRedirectError(err instanceof Error ? err.message : "Could not start sign-in");
    } finally {
      setLoading(false);
    }
  }

  // IdP redirect chrome or IdP error (no local password form)
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

  // Local identity mode only (not used when Keycloak is the platform IdP)
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

        <div className="login-badge mono">{bootstrapRequired ? "bootstrap" : "local"}</div>

        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.25rem" }}>
          {bootstrapRequired ? "Create admin" : "Sign in"}
        </h2>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
          {bootstrapRequired
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
