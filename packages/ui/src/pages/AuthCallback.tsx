import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { completeOidcLogin } from "../lib/oidc";
import { api, setOrgId } from "../lib/api";
import { useToast } from "../components/Toast";

/**
 * OIDC redirect callback for SPA PKCE (Keycloak → /auth/callback).
 * Stores tokens in browser; API only sees Bearer JWT thereafter.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { returnTo } = await completeOidcLogin();
        // Warm /v1/auth/me so shadow user + org membership exist
        try {
          const me = await api.authMe();
          if (me.user) {
            try {
              localStorage.setItem("cs-user", JSON.stringify(me.user));
            } catch {
              /* ignore */
            }
            if (me.user.orgId) setOrgId(me.user.orgId);
            toast.success(
              `Welcome, ${me.user.displayName || me.user.name || me.user.email}`,
            );
          }
        } catch {
          /* first me may still succeed later */
        }
        if (alive) navigate(returnTo.startsWith("/") ? returnTo : "/dashboard", { replace: true });
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  return (
    <div className="login-shell">
      <div className="login-card" style={{ textAlign: "center" }}>
        <Logo variant="wordmark" size={40} className="login-wordmark" />
        <p className="muted" style={{ marginTop: "1.25rem" }}>
          {error ? "Sign-in failed" : "Completing sign-in…"}
        </p>
        {error && (
          <>
            <p className="muted" style={{ color: "var(--danger)", fontSize: "0.85rem" }}>
              {error}
            </p>
            <button
              type="button"
              className="primary sm"
              style={{ marginTop: "1rem" }}
              onClick={() => navigate("/login", { replace: true })}
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
