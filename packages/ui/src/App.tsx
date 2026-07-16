import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Analytics } from "./pages/Analytics";
import { Connectors } from "./pages/Connectors";
import { CrossRepo } from "./pages/CrossRepo";
import { Dashboard } from "./pages/Dashboard";
import { Diff } from "./pages/Diff";
import { Findings } from "./pages/Findings";
import { Home } from "./pages/Home";
import { Learnings } from "./pages/Learnings";
import { AuthCallback } from "./pages/AuthCallback";
import { Login } from "./pages/Login";
import { Members } from "./pages/Members";
import { Models } from "./pages/Models";
import { Onboarding } from "./pages/Onboarding";
import { Policy } from "./pages/Policy";
import { Prompts } from "./pages/Prompts";
import { PullRequests } from "./pages/PullRequests";
import { Reports } from "./pages/Reports";
import { Sessions } from "./pages/Sessions";
import { AccountSettings } from "./pages/AccountSettings";
import { OrgSettings } from "./pages/OrgSettings";
import { PlatformSettings } from "./pages/PlatformSettings";
import { PlatformAnalyticsPage } from "./pages/PlatformAnalytics";
import { Settings } from "./pages/Settings";
import { api, getSessionToken, resolveActiveOrg, setSessionToken } from "./lib/api";
import { getAccessToken } from "./lib/oidc";

/** Default post-login destination inside the authenticated app shell. */
export const APP_HOME = "/dashboard";
export const APP_ONBOARDING = "/onboarding";

function RequireAuth({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await api.authStatus();
        if (!alive) return;
        const returnTo = `${location.pathname}${location.search || ""}` || APP_HOME;
        const loginPath = `/login?returnTo=${encodeURIComponent(returnTo)}`;
        if (status.bootstrapRequired) {
          navigate(loginPath, { replace: true });
          return;
        }
        if (!status.authRequired) {
          setAllowed(true);
          return;
        }
        // Auth required — Keycloak JWT, legacy session, or API key
        let token = getSessionToken() || localStorage.getItem("cs-api-key");
        if (!token) {
          try {
            token = await getAccessToken();
          } catch {
            token = null;
          }
        }
        if (!token) {
          navigate(loginPath, { replace: true });
          return;
        }
        const me = await api.authMe();
        if (!alive) return;
        if (!me.user && status.authRequired) {
          navigate(loginPath, { replace: true });
          return;
        }
        // Resolve org memberships; clear stale "local" and force onboarding when empty
        const { needsOrg } = await resolveActiveOrg();
        if (!alive) return;
        const onOnboarding = location.pathname.startsWith("/onboarding");
        if (needsOrg && !onOnboarding) {
          setAllowed(true);
          navigate(APP_ONBOARDING, { replace: true });
          return;
        }
        setAllowed(true);
      } catch {
        // API down — still allow shell so health shows offline
        setAllowed(true);
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [navigate, location.pathname]);

  useEffect(() => {
    const onUnauthorized = () => {
      setSessionToken(null);
      const returnTo =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search || ""}`
          : APP_HOME;
      // Prefer IdP logout/re-login path when using SPA OIDC
      void (async () => {
        try {
          const { getOidcUser } = await import("./lib/oidc.js");
          const u = await getOidcUser();
          if (u) {
            navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
            return;
          }
        } catch {
          /* fall through */
        }
        navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      })();
    };
    const onOrgRequired = () => {
      if (!location.pathname.startsWith("/onboarding")) {
        navigate(APP_ONBOARDING, { replace: true });
      }
    };
    window.addEventListener("cs:unauthorized", onUnauthorized);
    window.addEventListener("cs:org-required", onOrgRequired);
    return () => {
      window.removeEventListener("cs:unauthorized", onUnauthorized);
      window.removeEventListener("cs:org-required", onOrgRequired);
    };
  }, [navigate, location.pathname]);

  if (checking) {
    return (
      <div className="login-shell">
        <div className="muted">Checking session…</div>
      </div>
    );
  }
  if (!allowed) return null;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      {/* Public — no session, no Keycloak redirect */}
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      {/* Authenticated app shell */}
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="reports" element={<Reports />} />
        <Route path="findings" element={<Findings />} />
        <Route path="prs" element={<PullRequests />} />
        <Route path="diff" element={<Diff />} />
        <Route path="cross-repo" element={<CrossRepo />} />
        <Route path="learnings" element={<Learnings />} />
        <Route path="connectors" element={<Connectors />} />
        <Route path="members" element={<Members />} />
        <Route path="models" element={<Models />} />
        <Route path="prompts" element={<Prompts />} />
        <Route path="policy" element={<Policy />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/account" element={<AccountSettings />} />
        <Route path="settings/organization" element={<OrgSettings />} />
        <Route path="settings/platform" element={<PlatformSettings />} />
        <Route path="settings/platform/ops" element={<PlatformAnalyticsPage />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="onboarding" element={<Onboarding />} />
        <Route path="*" element={<Navigate to={APP_HOME} replace />} />
      </Route>
    </Routes>
  );
}
