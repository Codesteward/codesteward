import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  api,
  getOrgId,
  setOrgId,
  setSessionToken,
  type AuthUser,
  type OrgSummary,
} from "../lib/api";
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from "../lib/theme";
import { Logo } from "./Logo";
import { NavIcon } from "./NavIcons";
import { useToast } from "./Toast";

type NavItem = {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  /** When set, active only if pathname matches and ?mode= equals this value */
  mode?: string;
};

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: "dashboard", end: true },
      { to: "/analytics", label: "Analytics", icon: "analytics" },
    ],
  },
  {
    label: "Review",
    items: [
      { to: "/sessions?mode=gate", label: "Gate", icon: "gate", mode: "gate" },
      { to: "/sessions?mode=steward", label: "Steward", icon: "steward", mode: "steward" },
      { to: "/findings", label: "Findings", icon: "findings" },
      { to: "/reports", label: "Reports", icon: "reports" },
      { to: "/prs", label: "PRs", icon: "prs" },
      { to: "/cross-repo", label: "Cross-Repo", icon: "crossRepo" },
    ],
  },
  {
    label: "Trust",
    items: [{ to: "/learnings", label: "Learnings", icon: "learnings" }],
  },
  {
    label: "Tenant",
    items: [
      { to: "/connectors", label: "Connectors", icon: "connectors" },
      { to: "/members", label: "Members", icon: "members" },
      { to: "/models", label: "Models", icon: "models" },
      { to: "/prompts", label: "Prompts", icon: "prompts" },
      { to: "/policy", label: "Policy", icon: "policy" },
      { to: "/settings/organization", label: "Organization", icon: "org" },
    ],
  },
  {
    label: "You & install",
    items: [
      { to: "/settings/account", label: "Account", icon: "account" },
      { to: "/settings/platform", label: "Platform", icon: "platform" },
      // end: true — otherwise /settings is a prefix match and stays active on
      // /settings/platform, /settings/account, /settings/organization
      { to: "/settings", label: "Settings hub", icon: "settings", end: true },
    ],
  },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const modeParam = new URLSearchParams(location.search).get("mode");

  return (
    <>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="nav-section">{g.label}</div>
          <nav className="nav" style={{ flex: "unset", overflow: "visible" }}>
            {g.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) => {
                  if (item.mode) {
                    const pathOk = location.pathname === "/sessions";
                    return pathOk && modeParam === item.mode ? "active" : undefined;
                  }
                  // Avoid both Gate/Steward and plain /sessions lighting up
                  if (item.to === "/sessions" || item.to.startsWith("/sessions?")) {
                    return undefined;
                  }
                  return isActive ? "active" : undefined;
                }}
              >
                <span className="nav-icon" aria-hidden>
                  <NavIcon name={item.icon} size={22} />
                </span>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      ))}
    </>
  );
}

function OrgSwitcher() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [current, setCurrent] = useState<string>(() => getOrgId() ?? "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .listOrgs()
      .then((r) => {
        setOrgs(r.orgs);
        const stored = getOrgId();
        if (stored && r.orgs.some((o) => o.id === stored)) {
          setCurrent(stored);
        } else if (r.orgs.length > 0) {
          const first = r.orgs[0]!.id;
          setCurrent(first);
          if (!stored) setOrgId(first);
        }
      })
      .catch(() => setOrgs([]));
  }, []);

  function select(orgId: string) {
    if (orgId === current) {
      setOpen(false);
      return;
    }
    setOrgId(orgId);
    setCurrent(orgId);
    setOpen(false);
    window.location.reload();
  }

  const active = orgs.find((o) => o.id === current);
  const label = active?.name ?? (current || "Select org");

  return (
    <div className="org-switcher">
      <button
        type="button"
        className="org-switcher-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch organization"
      >
        <span className="org-switcher-mark" aria-hidden>
          ◈
        </span>
        <span className="org-switcher-meta">
          <span className="org-switcher-kicker">Organization</span>
          <span className="org-switcher-name">{label}</span>
        </span>
        <span className="org-switcher-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="org-switcher-backdrop" onClick={() => setOpen(false)} />
          <div className="org-switcher-pop" role="listbox">
            {orgs.length === 0 ? (
              <div className="muted" style={{ padding: "0.5rem 0.65rem", fontSize: "0.78rem" }}>
                No orgs yet — create one in Onboarding
              </div>
            ) : (
              orgs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={o.id === current}
                  className={`org-switcher-option${o.id === current ? " active" : ""}`}
                  onClick={() => select(o.id)}
                >
                  <span>{o.name}</span>
                  <span className="mono muted" style={{ fontSize: "0.68rem" }}>
                    {o.slug || o.id}
                  </span>
                </button>
              ))
            )}
            <NavLink
              to="/onboarding"
              className="org-switcher-option"
              onClick={() => setOpen(false)}
              style={{ borderTop: "1px solid var(--border)", marginTop: 4 }}
            >
              <span>+ Create org</span>
            </NavLink>
          </div>
        </>
      )}
    </div>
  );
}

/** Compact Dark / Light / System control — preference is local to this browser. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [pref, setPref] = useState<ThemePreference>(() => getThemePreference());

  useEffect(() => subscribeTheme((p) => setPref(p)), []);

  const options: Array<{
    id: ThemePreference;
    label: string;
    icon: typeof Sun;
    title: string;
  }> = [
    { id: "light", label: "Light", icon: Sun, title: "Light theme" },
    { id: "dark", label: "Dark", icon: Moon, title: "Dark theme" },
    { id: "system", label: "Auto", icon: Monitor, title: "Match system appearance" },
  ];

  return (
    <div
      className={`theme-toggle${compact ? " theme-toggle--compact" : ""}`}
      role="group"
      aria-label="Color theme"
    >
      {options.map((o) => {
        const Icon = o.icon;
        const active = pref === o.id;
        return (
          <button
            key={o.id}
            type="button"
            className={active ? "theme-toggle-btn active" : "theme-toggle-btn"}
            aria-pressed={active}
            title={o.title}
            onClick={() => setThemePreference(o.id)}
          >
            <Icon size={compact ? 15 : 16} strokeWidth={2.1} aria-hidden />
            {!compact && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ApiStatus() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const ping = () => {
      api
        .health()
        .then(() => alive && setOk(true))
        .catch(() => alive && setOk(false));
    };
    ping();
    const t = window.setInterval(ping, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <div className="status-pill" title="API health">
      <span className={`status-dot ${ok === true ? "ok" : ok === false ? "err" : "warn"}`} />
      {ok === true ? "API online" : ok === false ? "API offline" : "Checking…"}
    </div>
  );
}

function UserMenu() {
  const toast = useToast();
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .authMe()
      .then((r) => setUser(r.user))
      .catch(() => {
        try {
          const raw = localStorage.getItem("cs-user");
          if (raw) setUser(JSON.parse(raw) as AuthUser);
        } catch {
          setUser(null);
        }
      });
  }, []);

  async function logout() {
    let idToken: string | undefined;
    try {
      idToken = sessionStorage.getItem("cs-oidc-id-token") ?? undefined;
    } catch {
      /* ignore */
    }
    let idpLogoutUrl: string | undefined;
    try {
      const res = await api.authLogout({
        idToken,
        postLogoutRedirectUri:
          typeof window !== "undefined" ? `${window.location.origin}/` : undefined,
      });
      idpLogoutUrl = res.idpLogoutUrl;
    } catch {
      /* ignore */
    }
    setSessionToken(null);
    try {
      localStorage.removeItem("cs-user");
      sessionStorage.removeItem("cs-oidc-id-token");
    } catch {
      /* ignore */
    }
    // End Keycloak SSO cookie — otherwise Sign-in silently re-authenticates
    if (idpLogoutUrl) {
      toast.info("Signed out");
      window.location.replace(idpLogoutUrl);
      return;
    }
    toast.info("Signed out");
    navigate("/", { replace: true });
  }

  const label = user?.displayName || user?.name || user?.email || "Guest";
  const role = user?.role ?? "open";

  return (
    <div className="user-menu">
      <button type="button" className="user-menu-btn" onClick={() => setOpen((v) => !v)}>
        <span className="user-avatar" aria-hidden>
          {(label[0] ?? "?").toUpperCase()}
        </span>
        <span className="user-meta">
          <span className="user-name">{label}</span>
          <span className="user-role mono">{role}</span>
        </span>
      </button>
      {open && (
        <>
          <div className="user-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="user-menu-pop">
            <div className="muted" style={{ fontSize: "0.75rem", padding: "0.35rem 0.6rem" }}>
              {user?.email ?? "Not signed in"}
            </div>
            <button type="button" className="ghost" style={{ width: "100%", textAlign: "left" }} onClick={() => { setOpen(false); navigate("/settings"); }}>
              Settings
            </button>
            <button type="button" className="ghost" style={{ width: "100%", textAlign: "left" }} onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <NavLink to="/dashboard" className="brand" style={compact ? { paddingBottom: 0, margin: 0 } : undefined}>
      {compact ? (
        <Logo size={28} variant="icon" />
      ) : (
        <>
          <Logo size={36} variant="icon" />
          <div className="brand-text">
            <h1>Codesteward</h1>
            <p>Govern · Verify · Evolve</p>
          </div>
        </>
      )}
    </NavLink>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <OrgSwitcher />
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <NavItems />
        </div>
        <div className="sidebar-footer">
          <UserMenu />
          <ApiStatus />
          <ThemeToggle />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row">
            <button type="button" className="icon" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              ☰
            </button>
            <Brand compact />
          </div>
          <div className="row">
            <OrgSwitcher />
            <ApiStatus />
            <UserMenu />
            <ThemeToggle compact />
          </div>
        </header>

        {mobileOpen && (
          <div className="mobile-nav open">
            <div className="mobile-nav-backdrop" onClick={() => setMobileOpen(false)} />
            <div className="mobile-nav-panel">
              <Brand />
              <OrgSwitcher />
              <NavItems onNavigate={() => setMobileOpen(false)} />
              <div className="sidebar-footer">
                <UserMenu />
                <ThemeToggle />
              </div>
            </div>
          </div>
        )}

        <div className="content wide">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
