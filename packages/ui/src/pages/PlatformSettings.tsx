import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import {
  api,
  isPlatformOperator,
  type AuthUser,
  type GraphStatus,
  type LicenseInfo,
} from "../lib/api";
import {
  PlatformGithubAppPanel,
  PlatformLangfusePanel,
  RuntimeConfigPanel,
} from "./settings/panels";

export function PlatformSettings() {
  const toast = useToast();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<string | undefined>();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [health, setHealth] = useState<boolean | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [graph, setGraph] = useState<GraphStatus | null>(null);
  const [repoId, setRepoId] = useState("codesteward");
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [hideLicenseUi, setHideLicenseUi] = useState(false);
  const [licenseFeatures, setLicenseFeatures] = useState<
    Array<{ id: string; label: string; description: string; enabled: boolean }>
  >([]);
  const [licenseKeyInput, setLicenseKeyInput] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseHint, setLicenseHint] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<{
    mode?: string;
    hint?: string;
    oidc?: { status?: string; issuer?: string };
  } | null>(null);
  const [identity, setIdentity] = useState<{
    mode?: string;
    keycloak?: boolean;
    adminConfigured?: boolean;
    admin?: { ok: boolean; realm?: string; error?: string } | null;
    note?: string;
  } | null>(null);

  useEffect(() => {
    api
      .authMe()
      .then((r) => {
        setUser(r.user);
        setAuthMode(r.authMode);
        setAllowed(isPlatformOperator(r.user, r.authMode));
      })
      .catch(() => {
        setUser(null);
        setAllowed(false);
      });
    api
      .health()
      .then((h) => setHealth(h.ok))
      .catch(() => setHealth(false));
    api
      .readyz()
      .then((r) => setReady(r.ready))
      .catch(() => setReady(false));
    api
      .authStatus()
      .then(setAuthStatus)
      .catch(() => setAuthStatus(null));
    api
      .identityStatus()
      .then(setIdentity)
      .catch(() => setIdentity(null));
    api
      .license()
      .then((r) => {
        setLicense(r.license);
        setLicenseFeatures(r.features ?? []);
        setLicenseHint(r.upload?.note ?? null);
        setHideLicenseUi(
          Boolean(r.hideLicenseUi || r.openMode || r.license?.openMode || r.license?.hideLicenseUi),
        );
      })
      .catch(() => {
        setLicense(null);
        setLicenseFeatures([]);
        setHideLicenseUi(false);
      });
  }, []);

  useEffect(() => {
    if (!allowed) return;
    api
      .graphStatus(repoId)
      .then(setGraph)
      .catch(() => setGraph(null));
  }, [repoId, allowed]);

  async function rebuildGraph() {
    try {
      await api.graphRebuild(repoId);
      const s = await api.graphStatus(repoId);
      setGraph(s);
      toast.success("Graph rebuild requested");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadLicense() {
    setLicenseBusy(true);
    try {
      // API accepts body.licenseKey or body.key depending on version
      const r = await api.installLicense(licenseKeyInput.trim());
      setLicense(r.license);
      setLicenseFeatures(r.features ?? []);
      setLicenseKeyInput("");
      toast.success("License installed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLicenseBusy(false);
    }
  }

  // No access: hide the surface entirely (nav already omits the link)
  if (allowed === false) {
    return <Navigate to="/settings" replace />;
  }

  if (allowed === null) {
    return (
      <div>
        <PageHero kicker="Install" title="Platform" subtitle="Checking access…" />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <PageHero
        kicker="Install"
        title="Platform"
        subtitle="Install-wide health, license, and runtime knobs. Separated from tenant org admin."
        actions={
          <Link to="/settings" className="ghost sm" style={{ textDecoration: "none" }}>
            All settings
          </Link>
        }
      />

      <div className="banner ok" style={{ marginBottom: "1rem" }}>
        Platform operator access
        {user?.email ? (
          <>
            {" "}
            · <span className="mono">{user.email}</span>
          </>
        ) : null}
        {authMode ? ` · auth ${authMode}` : ""}
      </div>

      <div className="grid cols-2">
        <div className="card stack">
          <h3>Runtime health</h3>
          <div className="field">
            <label>API URL</label>
            <input
              readOnly
              value={import.meta.env.VITE_API_URL || "(same-origin / Vite proxy → :8081)"}
            />
          </div>
          <div className="row">
            <span className="muted">Health</span>
            <Badge tone={health ? "ok" : "failed"}>
              {health === null ? "…" : health ? "ok" : "down"}
            </Badge>
            <span className="muted">Ready</span>
            <Badge tone={ready ? "ok" : "failed"}>
              {ready === null ? "…" : ready ? "ready" : "not ready"}
            </Badge>
          </div>
          <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.55 }}>
            Auth: <Badge tone="nit">{authStatus?.mode ?? "…"}</Badge>
            {" · "}
            Identity:{" "}
            <Badge tone={identity?.keycloak ? "ok" : "nit"}>
              {identity?.keycloak ? "managed IdP" : identity?.mode ?? "local"}
            </Badge>
            {identity?.keycloak && (
              <>
                {" · "}
                Directory API:{" "}
                <Badge
                  tone={
                    identity.admin?.ok
                      ? "ok"
                      : identity.adminConfigured
                        ? "warn"
                        : "nit"
                  }
                >
                  {identity.admin?.ok
                    ? "ok"
                    : identity.admin?.error ??
                      (identity.adminConfigured ? "error" : "not configured")}
                </Badge>
              </>
            )}
            {authStatus?.oidc?.status
              ? ` · OIDC ${authStatus.oidc.status}`
              : ""}
          </p>
          <div className="field">
            <label>UI API key (localStorage Bearer)</label>
            <input
              type="password"
              placeholder="STEW_API_KEY"
              defaultValue={localStorage.getItem("cs-api-key") ?? ""}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v) localStorage.setItem("cs-api-key", v);
                else localStorage.removeItem("cs-api-key");
                toast.success(v ? "API key saved locally" : "API key cleared");
              }}
            />
          </div>
        </div>

        <div className="card stack">
          <div className="card-header">
            <h3>Graph</h3>
            <button type="button" className="sm" onClick={() => void rebuildGraph()}>
              Rebuild graph
            </button>
          </div>
          <div className="field">
            <label>Repo ID</label>
            <input value={repoId} onChange={(e) => setRepoId(e.target.value)} />
          </div>
          <table className="table">
            <tbody>
              <tr>
                <td>Backend</td>
                <td className="mono">{graph?.graph_backend ?? "—"}</td>
              </tr>
              <tr>
                <td>Connected</td>
                <td>
                  <Badge tone={graph?.backend_connected ? "ok" : "nit"}>
                    {graph?.backend_connected ? "yes" : "no / mock"}
                  </Badge>
                </td>
              </tr>
              <tr>
                <td>Nodes</td>
                <td className="mono">{graph?.nodes?.total ?? "—"}</td>
              </tr>
              <tr>
                <td>Last build</td>
                <td className="mono muted">{graph?.last_build ?? "never"}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {!hideLicenseUi && (
          <div className="card stack" style={{ gridColumn: "1 / -1" }}>
            <h3>License & features</h3>
            <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.55, margin: 0 }}>
              Install-wide license (not <span className="mono">STEW_API_KEY</span>). Only platform
              operators can upload. Tenant admins cannot install licenses.
            </p>
            {licenseHint && (
              <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
                {licenseHint}
              </p>
            )}
            {license && (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Badge tone="ok">{license.tier ?? license.status ?? "active"}</Badge>
                {license.customer && <span className="muted">{license.customer}</span>}
              </div>
            )}
            {licenseFeatures.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem", lineHeight: 1.55 }}>
                {licenseFeatures.map((f) => (
                  <li key={f.id} title={f.description}>
                    <Badge tone={f.enabled ? "ok" : "nit"}>{f.enabled ? "on" : "off"}</Badge>{" "}
                    <strong>{f.label}</strong>
                    {f.description && (
                      <span className="muted" style={{ fontWeight: 400 }}>
                        {" "}
                        — {f.description}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="field">
              <label>License key</label>
              <textarea
                value={licenseKeyInput}
                onChange={(e) => setLicenseKeyInput(e.target.value)}
                rows={3}
                placeholder="Paste license key…"
                className="mono"
              />
            </div>
            <button
              type="button"
              className="primary sm"
              disabled={licenseBusy || !licenseKeyInput.trim()}
              onClick={() => void uploadLicense()}
            >
              {licenseBusy ? "Installing…" : "Install license"}
            </button>
          </div>
        )}

        <div style={{ gridColumn: "1 / -1" }}>
          <PlatformGithubAppPanel />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <PlatformLangfusePanel />
        </div>
        <RuntimeConfigPanel />
      </div>
    </div>
  );
}
