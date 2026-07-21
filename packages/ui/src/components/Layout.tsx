import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  api,
  getOrgId,
  isPlatformOperator,
  ORG_CHANGED_EVENT,
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
import { FirstReviewTour } from "./FirstReviewTour";
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

function buildNavGroups(opts: {
  saasBilling: boolean;
  platformOk: boolean;
  /** Product ClickHouse traces enabled — show org-wide deep-dive for any tenant user */
  tracesEnabled: boolean;
}): { label: string; items: NavItem[] }[] {
  const tenantItems: NavItem[] = [
    { to: "/connectors", label: "Connectors", icon: "connectors" },
    { to: "/members", label: "Members", icon: "members" },
    { to: "/models", label: "Models", icon: "models" },
    { to: "/prompts", label: "Prompts", icon: "prompts" },
    { to: "/policy", label: "Policy", icon: "policy" },
    { to: "/settings/organization", label: "Organization", icon: "org" },
  ];
  if (opts.saasBilling) {
    // External portal — handled specially in NavItems (not a router path)
    tenantItems.push({ to: "__billing_portal__", label: "Billing", icon: "billing" });
  }
  const youItems: NavItem[] = [
    { to: "/settings/account", label: "Account", icon: "account" },
  ];
  // Hide Platform from non-operators (do not show a locked/warning entry)
  if (opts.platformOk) {
    // end: true — otherwise /settings/platform is a prefix match and stays active on /settings/platform/ops
    youItems.push({
      to: "/settings/platform",
      label: "Platform",
      icon: "platform",
      end: true,
    });
    youItems.push({
      to: "/settings/platform/ops",
      label: "Platform ops",
      icon: "analytics",
    });
  }
  youItems.push({
    // end: true — otherwise /settings is a prefix match and stays active on
    // /settings/platform, /settings/account, /settings/organization
    to: "/settings",
    label: "Settings hub",
    icon: "settings",
    end: true,
  });
  const reviewItems: NavItem[] = [
    { to: "/sessions?mode=gate", label: "Gate", icon: "gate", mode: "gate" },
    { to: "/sessions?mode=steward", label: "Steward", icon: "steward", mode: "steward" },
    { to: "/findings", label: "Findings", icon: "findings" },
    { to: "/reports", label: "Reports", icon: "reports" },
  ];
  // Org users + platform operators: deep-dive only when product ClickHouse is on
  if (opts.tracesEnabled) {
    reviewItems.push({ to: "/traces", label: "Traces", icon: "traces" });
  }
  reviewItems.push(
    { to: "/prs", label: "PRs", icon: "prs" },
    { to: "/cross-repo", label: "Cross-Repo", icon: "crossRepo" },
  );
  return [
    {
      label: "Overview",
      items: [
        { to: "/dashboard", label: "Dashboard", icon: "dashboard", end: true },
        { to: "/analytics", label: "Analytics", icon: "analytics" },
      ],
    },
    {
      label: "Review",
      items: reviewItems,
    },
    {
      label: "Trust",
      items: [{ to: "/learnings", label: "Learnings", icon: "learnings" }],
    },
    {
      label: "Tenant",
      items: tenantItems,
    },
    {
      label: "You & install",
      items: youItems,
    },
  ];
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const modeParam = new URLSearchParams(location.search).get("mode");
  const toast = useToast();
  const [saasBilling, setSaasBilling] = useState(false);
  const [platformOk, setPlatformOk] = useState(false);
  /** Any org member can open Traces when platform ClickHouse is enabled */
  const [tracesEnabled, setTracesEnabled] = useState(false);

  useEffect(() => {
    void api
      .billingStatus()
      .then((s) => setSaasBilling(Boolean(s.configured)))
      .catch(() => setSaasBilling(false));
    void api
      .authMe()
      .then((r) => setPlatformOk(isPlatformOperator(r.user, r.authMode)))
      .catch(() => setPlatformOk(false));
    const refreshTracesNav = () => {
      void api
        .traceStorageStatus()
        .then((s) => setTracesEnabled(Boolean(s.enabled)))
        .catch(() => setTracesEnabled(false));
    };
    refreshTracesNav();
    // Re-check when active org changes (install-wide flag, but keep status fresh)
    window.addEventListener(ORG_CHANGED_EVENT, refreshTracesNav);
    return () => window.removeEventListener(ORG_CHANGED_EVENT, refreshTracesNav);
  }, []);

  async function openBillingPortal() {
    onNavigate?.();
    try {
      // Same tab so “Back to app” returns here instead of stacking another platform tab
      const returnTo =
        typeof window !== "undefined"
          ? `${window.location.origin}${window.location.pathname}${window.location.search || ""}` ||
            `${window.location.origin}/settings/organization`
          : undefined;
      const res = await api.openBillingPortal({ returnTo });
      if (res.url) {
        window.location.assign(res.url);
        return;
      }
      toast.error("Billing portal URL unavailable");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const groups = buildNavGroups({ saasBilling, platformOk, tracesEnabled });

  return (
    <>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="nav-section">{g.label}</div>
          <nav className="nav" style={{ flex: "unset", overflow: "visible" }}>
            {g.items.map((item) =>
              item.to === "__billing_portal__" ? (
                <button
                  key={item.to}
                  type="button"
                  className="nav-item"
                  onClick={() => void openBillingPortal()}
                  title="Open cloud billing portal"
                >
                  <span className="nav-icon" aria-hidden>
                    <NavIcon name={item.icon} size={22} />
                  </span>
                  {item.label}
                </button>
              ) : (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  data-tour={
                    item.mode === "gate"
                      ? "nav-gate"
                      : item.icon === "models"
                        ? "nav-models"
                        : item.icon === "connectors"
                          ? "nav-connectors"
                          : item.icon === "findings"
                            ? "nav-findings"
                            : item.icon === "dashboard"
                              ? "nav-dashboard"
                              : undefined
                  }
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
              ),
            )}
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

  function applyOrgList(list: OrgSummary[], preferId?: string | null) {
    setOrgs(list);
    const stored = preferId ?? getOrgId();
    if (list.length === 0) {
      setCurrent("");
      if (stored) setOrgId(null);
      return;
    }
    if (stored && list.some((o) => o.id === stored)) {
      setCurrent(stored);
      return;
    }
    // Stale cache (e.g. "local") — switch to first real membership
    const first = list[0]!.id;
    setCurrent(first);
    setOrgId(first);
  }

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      api
        .listOrgs()
        .then((r) => {
          if (!alive) return;
          applyOrgList(r.orgs, getOrgId());
        })
        .catch(() => {
          if (alive) setOrgs([]);
        });
    };
    refresh();
    // Onboarding / other pages call setOrgId — keep switcher in sync without hard refresh
    const onOrgChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ orgId?: string | null }>).detail;
      const next = detail?.orgId ?? getOrgId();
      if (next) setCurrent(next);
      refresh();
    };
    window.addEventListener(ORG_CHANGED_EVENT, onOrgChanged);
    return () => {
      alive = false;
      window.removeEventListener(ORG_CHANGED_EVENT, onOrgChanged);
    };
  }, []);

  function select(orgId: string) {
    if (orgId === current) {
      setOpen(false);
      return;
    }
    setOrgId(orgId);
    setCurrent(orgId);
    setOpen(false);
    // Reload so org-scoped pages refetch under the new X-Org-Id
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
    setSessionToken(null);
    try {
      localStorage.removeItem("cs-user");
      sessionStorage.removeItem("cs-oidc-id-token");
    } catch {
      /* ignore */
    }
    // SPA OIDC: end Keycloak session in the browser (no API session store)
    try {
      const { getOidcUser, startOidcLogout } = await import("../lib/oidc.js");
      const u = await getOidcUser();
      if (u) {
        toast.info("Signed out");
        await startOidcLogout();
        return;
      }
    } catch {
      /* fall through to local logout */
    }
    try {
      await api.authLogout({});
    } catch {
      /* ignore */
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
  /** Increment to force-replay the first-review product tour (Account settings). */
  const [tourForceToken, setTourForceToken] = useState(0);

  useEffect(() => {
    const onReplay = () => setTourForceToken((n) => n + 1);
    window.addEventListener("cs:replay-product-tour", onReplay);
    return () => window.removeEventListener("cs:replay-product-tour", onReplay);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <OrgSwitcher />
        <div data-tour="nav-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
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
      <FirstReviewTour forceToken={tourForceToken} />
    </div>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
