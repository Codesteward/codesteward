import { useEffect, useMemo, useState } from "react";
import { ConnectorBrandIcon } from "../components/ConnectorBrandIcon";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero, SkeletonCards } from "../components/ui";
import { api, type Connector } from "../lib/api";

const META: Record<
  string,
  {
    title: string;
    blurb: string;
    fields: Array<{ key: string; label: string; type?: string; placeholder?: string }>;
  }
> = {
  graph_mcp: {
    title: "Graph MCP",
    blurb: "Deterministic structural graph — call chains, auth guards, blast radius.",
    fields: [
      { key: "baseUrl", label: "MCP URL", placeholder: "http://localhost:3000/mcp" },
    ],
  },
  github: {
    title: "GitHub",
    blurb: "Enterprise: GitHub App (installation tokens). PAT only for local dev.",
    fields: [
      { key: "token", label: "PAT (dev only — not enterprise)", type: "password", placeholder: "ghp_… discouraged" },
      { key: "baseUrl", label: "API base URL (GHE)", placeholder: "https://api.github.com" },
      { key: "webhookSecret", label: "Webhook secret", type: "password" },
    ],
  },
  gitlab: {
    title: "GitLab",
    blurb: "Enterprise preferred: Group Access Token / Project bot. Human PAT = break-glass.",
    fields: [
      {
        key: "authMode",
        label: "Auth mode",
        placeholder: "group_token | project_token | pat_legacy",
      },
      { key: "token", label: "Group / project token (preferred)", type: "password" },
      { key: "baseUrl", label: "GitLab URL", placeholder: "https://gitlab.com" },
      { key: "webhookSecret", label: "Webhook secret", type: "password" },
    ],
  },
  bitbucket: {
    title: "Bitbucket",
    blurb: "Enterprise preferred: OAuth consumer / workspace access token.",
    fields: [
      {
        key: "authMode",
        label: "Auth mode",
        placeholder: "oauth | workspace_token | app_password",
      },
      { key: "token", label: "Access token / app password", type: "password" },
      { key: "username", label: "Username (app password)", placeholder: "bitbucket-user" },
      { key: "clientId", label: "OAuth consumer key (optional)" },
      { key: "clientSecret", label: "OAuth consumer secret", type: "password" },
      { key: "baseUrl", label: "API base URL", placeholder: "https://api.bitbucket.org/2.0" },
    ],
  },
  "azure-devops": {
    title: "Azure DevOps",
    blurb:
      "Auth: PAT (token) or Service Principal (tenantId + clientId + clientSecret → AAD client_credentials). Per-org credentials; not shared via process.env.",
    fields: [
      {
        key: "authMode",
        label: "Auth mode",
        placeholder: "service_principal | pat_legacy",
      },
      { key: "tenantId", label: "Azure AD tenant ID (SP)", placeholder: "xxxxxxxx-xxxx-…" },
      { key: "clientId", label: "App / client ID (SP)" },
      { key: "clientSecret", label: "Client secret (SP)", type: "password" },
      { key: "token", label: "PAT (dev break-glass only)", type: "password" },
      { key: "org", label: "Azure DevOps organization" },
      { key: "project", label: "Project" },
      { key: "baseUrl", label: "Org URL", placeholder: "https://dev.azure.com/org" },
    ],
  },
  gitea: {
    title: "Gitea / Forgejo",
    blurb: "Self-hosted Git forge PRs and reviews.",
    fields: [
      { key: "token", label: "Access token", type: "password" },
      { key: "baseUrl", label: "Base URL", placeholder: "https://gitea.example.com" },
    ],
  },
  jira: {
    title: "Jira",
    blurb: "Ticket linkage and requirements context for specialists.",
    fields: [
      { key: "baseUrl", label: "Jira URL", placeholder: "https://org.atlassian.net" },
      { key: "token", label: "API token", type: "password" },
      { key: "username", label: "Email / username" },
    ],
  },
  confluence: {
    title: "Confluence",
    blurb: "Design docs / ADRs for requirements grounding (Atlassian API token).",
    fields: [
      {
        key: "baseUrl",
        label: "Confluence URL",
        placeholder: "https://org.atlassian.net/wiki",
      },
      { key: "token", label: "API token", type: "password" },
      { key: "username", label: "Email / username" },
      { key: "spaceKey", label: "Default space key", placeholder: "ENG" },
    ],
  },
  mcp: {
    title: "Review MCP",
    blurb: "Expose stew tools to any MCP client (@codesteward/mcp-server).",
    fields: [{ key: "note", label: "Note", placeholder: "Optional note" }],
  },
  linear: {
    title: "Linear",
    blurb: "Issue tracker connector for requirements specialist.",
    fields: [
      { key: "token", label: "API key", type: "password" },
      { key: "baseUrl", label: "API base URL", placeholder: "https://api.linear.app" },
    ],
  },
};

function statusTone(status: string): string {
  if (["configured", "available", "mock", "ok"].includes(status)) return status;
  if (status === "app_pending_install") return "warn";
  if (status.includes("missing") || status.includes("not_")) return status;
  return status;
}

export function Connectors() {
  const toast = useToast();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string>("");
  const [ghStatus, setGhStatus] = useState<Awaited<
    ReturnType<typeof api.githubAppStatus>
  > | null>(null);
  const [showAppAdvanced, setShowAppAdvanced] = useState(false);
  const [showPatBreakGlass, setShowPatBreakGlass] = useState(false);

  /**
   * Platform App enforce (API: orgCanConfigureApp=false when enforce+configured).
   * Tenant UI: Install only — no Create Manifest, no PEM paste.
   */
  const platformEnforced = Boolean(
    ghStatus &&
      (ghStatus.orgCanConfigureApp === false ||
        (ghStatus.platformGithubApp?.enforce && ghStatus.platformGithubApp.configured)),
  );
  const canConfigureOrgApp = !platformEnforced;
  /** API sets patAllowed: !enforce || allowOrgPat */
  const canUsePat = !ghStatus || ghStatus.patAllowed !== false;

  const [appForm, setAppForm] = useState({
    appId: "",
    privateKeyPem: "",
    installationId: "",
    accountLogin: "",
    baseUrl: "https://api.github.com",
    webhookSecret: "",
  });
  const [ghInstallOptions, setGhInstallOptions] = useState<
    Array<{
      installationId: string;
      accountLogin: string;
      accountType?: string;
      htmlUrl?: string;
      source?: string;
    }>
  >([]);
  const [installsLoading, setInstallsLoading] = useState(false);
  const [installSelect, setInstallSelect] = useState<string>(""); // installationId or "__manual__"
  const [manualAccount, setManualAccount] = useState(false);

  const refresh = () =>
    Promise.all([
      api.connectors().then((c) => setConnectors(c.connectors)),
      api.githubAppStatus().then(setGhStatus).catch(() => setGhStatus(null)),
    ])
      .catch(() => setConnectors([]))
      .finally(() => setLoading(false));

  async function loadGitHubInstallations(opts?: { silent?: boolean }) {
    const canQuery =
      (appForm.appId.trim() && appForm.privateKeyPem.trim()) ||
      ghStatus?.githubAppConfigured;
    if (!canQuery) {
      if (!opts?.silent) {
        toast.info("Enter App ID and private key PEM first, then load installations");
      }
      return;
    }
    setInstallsLoading(true);
    try {
      const res = await api.listGitHubAppInstallations({
        appId: appForm.appId.trim() || undefined,
        privateKeyPem: appForm.privateKeyPem.trim() || undefined,
        baseUrl: appForm.baseUrl.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not list installations");
        setGhInstallOptions([]);
        return;
      }
      setGhInstallOptions(res.installations ?? []);
      if ((res.installations?.length ?? 0) === 0) {
        toast.info("No installations yet — install the App on a GitHub org, then refresh");
      } else if (!opts?.silent) {
        toast.success(`Found ${res.installations.length} GitHub account(s)`);
      }
      // Pre-select if only one
      if (res.installations?.length === 1) {
        const only = res.installations[0]!;
        setInstallSelect(only.installationId);
        setAppForm((f) => ({
          ...f,
          installationId: only.installationId,
          accountLogin: only.accountLogin,
        }));
        setManualAccount(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const active = useMemo(
    () => connectors.find((c) => c.type === editing) ?? null,
    [connectors, editing],
  );

  function openConfigure(c: Connector) {
    setEditing(c.type);
    setTestResult("");
    setForm({
      baseUrl: c.baseUrl ?? c.url ?? "",
      username: c.username ?? "",
      org: c.org ?? "",
      project: c.project ?? "",
      token: "",
      webhookSecret: "",
      note: c.note ?? "",
    });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v.trim()) body[k] = v.trim();
      }
      await api.putConnector(editing, body);
      toast.success(`${editing} saved`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!editing) return;
    setBusy(true);
    setTestResult("");
    try {
      const res = await api.testConnector(editing);
      if (res.ok) {
        setTestResult(JSON.stringify(res.result ?? { ok: true }, null, 2));
        toast.success(`${editing} test ok`);
      } else {
        setTestResult(res.error ?? "failed");
        toast.error(res.error ?? "Test failed");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestResult(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (
      !window.confirm(
        `Remove ${editing} connector credentials for this org? This cannot be undone from the UI.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteConnector(editing);
      toast.info(`${editing} cleared`);
      setEditing(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function installGitHubApp() {
    setBusy(true);
    try {
      const res = await api.githubInstall();
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      toast.error(res.message ?? res.error ?? "Install URL unavailable — configure App slug/id first");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Happy path: create App via GitHub Manifest (no PEM paste). */
  async function createGitHubAppFromManifest() {
    if (platformEnforced || !canConfigureOrgApp) {
      toast.error(
        "A platform GitHub App is enforced — install the shared App instead of creating a new one.",
      );
      return;
    }
    setBusy(true);
    try {
      const res = await api.githubManifest();
      if (res.warnings?.length) {
        for (const w of res.warnings) toast.info(w.slice(0, 220));
      }
      const createUrl = res.createUrl || "https://github.com/settings/apps/new";
      const state = res.state || "local";
      // Open GitHub create page with valid manifest POST (name=Codesteward)
      const w = window.open("", "_blank");
      if (w) {
        const warnHtml = (res.warnings ?? [])
          .map(
            (x) =>
              `<li style="margin:0.35rem 0;color:#fbbf24">${x
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")}</li>`,
          )
          .join("");
        w.document.write(`<!doctype html><html><head><title>Create Codesteward GitHub App</title>
          <meta charset="utf-8"/>
          <style>
            body{font-family:system-ui,sans-serif;padding:2rem;max-width:760px;margin:0 auto;background:#0b1220;color:#e2e8f0}
            h1{font-size:1.35rem;margin:0 0 0.5rem}
            .muted{color:#94a3b8;font-size:0.9rem;line-height:1.5}
            button{font-size:1rem;padding:0.65rem 1.1rem;border-radius:8px;border:0;background:#22d3ee;color:#0b1220;font-weight:600;cursor:pointer}
            pre{background:#111827;color:#cbd5e1;padding:1rem;overflow:auto;border-radius:8px;font-size:0.75rem}
            ul{padding-left:1.2rem}
          </style></head>
          <body>
          <h1>Create Codesteward GitHub App</h1>
          <p class="muted">GitHub validates this JSON as a <strong>manifest</strong>. App name is <strong>Codesteward</strong>.
          Installation lifecycle events are enabled in App settings after create (not valid in manifest default_events).
          ${
            res.webhookPublic
              ? "Webhook URL is public and included."
              : "Webhook omitted (localhost is rejected by GitHub). Set <span style='font-family:monospace'>STEW_WEBHOOK_PUBLIC_URL</span> to a tunnel (smee/ngrok) for live hooks."
          }</p>
          ${warnHtml ? `<ul>${warnHtml}</ul>` : ""}
          <form id="gh-manifest-form" action="${createUrl}" method="post" style="margin:1.25rem 0">
            <input type="hidden" name="manifest" id="manifest" />
            <input type="hidden" name="state" value="${String(state).replace(/"/g, "")}" />
            <button type="submit">Create Codesteward App on GitHub</button>
          </form>
          <pre id="preview"></pre>
          <script>
            const m = ${JSON.stringify(JSON.stringify(res.manifest))};
            document.getElementById('manifest').value = m;
            document.getElementById('preview').textContent = JSON.stringify(JSON.parse(m), null, 2);
          </script>
          </body></html>`);
        w.document.close();
      } else {
        toast.info("Manifest ready — allow popups or check console");
        console.log("GitHub App manifest", res.manifest, res.warnings);
      }
      toast.success(
        res.webhookPublic
          ? "Manifest opened — Create on GitHub, then Install"
          : "Manifest opened without webhook (localhost). Create App, then set a public webhook URL",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const meta = editing ? META[editing] : null;

  return (
    <div>
      <PageHero
        kicker="Integrations"
        title="Connectors"
        subtitle="Enterprise Git connectors use Apps / OAuth installs — not long-lived personal tokens."
      />

      <div className="card" style={{ marginBottom: "1rem", borderColor: "rgba(124,92,252,0.35)" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h3 style={{ margin: "0 0 0.35rem" }}>
              GitHub App{" "}
              {platformEnforced && (
                <Badge tone="configured">platform</Badge>
              )}{" "}
              {ghStatus?.githubAppConfigured && (
                <Badge tone={ghStatus.installationReady ? "ok" : "warn"}>
                  {ghStatus.installationReady
                    ? "connected"
                    : platformEnforced
                      ? "install pending"
                      : "app only"}
                </Badge>
              )}
            </h3>
            {platformEnforced ? (
              <>
                <p className="muted" style={{ margin: 0, fontSize: "0.85rem", maxWidth: 640, lineHeight: 1.5 }}>
                  {ghStatus?.enterpriseRecommendation ??
                    "This install uses a shared platform GitHub App. Install that App on your GitHub organization — do not create a new App or paste PEMs."}
                </p>
                {ghStatus?.detail && (
                  <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.82rem" }}>
                    {ghStatus.detail}
                  </p>
                )}
                <p className="mono muted" style={{ marginTop: 8, fontSize: "0.75rem" }}>
                  platform appId={ghStatus?.platformGithubApp?.appId ?? ghStatus?.appId ?? "—"}
                  {ghStatus?.platformGithubApp?.slug
                    ? ` · slug=${ghStatus.platformGithubApp.slug}`
                    : ""}{" "}
                  · installs=
                  {ghStatus?.installations?.filter((i) =>
                    /^\d+$/.test(String(i.installationId ?? "")),
                  ).length ?? 0}
                </p>
                {(ghStatus?.installations?.length ?? 0) > 0 && (
                  <ul
                    className="muted"
                    style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem", fontSize: "0.8rem" }}
                  >
                    {ghStatus!.installations
                      .filter((i) => /^\d+$/.test(String(i.installationId ?? "")))
                      .map((i) => (
                        <li key={String(i.installationId)}>
                          {String(i.accountLogin ?? "—")} · install {String(i.installationId)}
                        </li>
                      ))}
                  </ul>
                )}
              </>
            ) : ghStatus?.githubAppConfigured && !showAppAdvanced ? (
              <>
                <p className="muted" style={{ margin: 0, fontSize: "0.85rem", maxWidth: 640 }}>
                  Connected for this Codesteward org. Setup steps are hidden — reconfigure only if you need to
                  rotate credentials or change installation.
                </p>
                <p className="mono muted" style={{ marginTop: 8, fontSize: "0.75rem" }}>
                  appId={ghStatus.appId ?? "—"} · mode={ghStatus.authMode} · installs=
                  {ghStatus.installations?.filter((i) =>
                    /^\d+$/.test(String(i.installationId ?? "")),
                  ).length ?? 0}
                </p>
                {(ghStatus.installations?.length ?? 0) > 0 && (
                  <ul className="muted" style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem", fontSize: "0.8rem" }}>
                    {ghStatus.installations
                      .filter((i) => /^\d+$/.test(String(i.installationId ?? "")))
                      .map((i) => (
                        <li key={String(i.installationId)}>
                          {String(i.accountLogin ?? "—")} · install {String(i.installationId)}
                        </li>
                      ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem", maxWidth: 640 }}>
                {ghStatus?.enterpriseRecommendation ??
                  "PATs bind to a human seat and break when people leave. Use a GitHub App with short-lived installation tokens."}
              </p>
            )}
          </div>
          {ghStatus?.docs && (
            <a className="muted" href={ghStatus.docs} target="_blank" rel="noreferrer" style={{ fontSize: "0.8rem" }}>
              GitHub docs →
            </a>
          )}
        </div>

        {/* Platform enforce: install-only. Else: compact connected or full create path. */}
        <div className="row" style={{ marginTop: "1rem", gap: 8, flexWrap: "wrap" }}>
          {platformEnforced ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void installGitHubApp()}
              >
                {busy
                  ? "Redirecting…"
                  : ghStatus?.installationReady
                    ? "Re-install / add GitHub org"
                    : "Install platform GitHub App"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api
                    .testGitHubApp()
                    .then((r) => {
                      setTestResult(JSON.stringify(r, null, 2));
                      toast.success(
                        (r as { ok?: boolean }).ok ? "GitHub App token OK" : "Test finished",
                      );
                    })
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Test installation token
              </button>
              {(ghStatus?.installations?.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="ghost sm"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Unlink GitHub App installations for this Codesteward org? The platform App stays configured — re-install to reconnect.",
                      )
                    ) {
                      return;
                    }
                    setBusy(true);
                    api
                      .deleteGitHubApp()
                      .then(() => {
                        toast.info("Installations unlinked for this org");
                        return refresh();
                      })
                      .catch((e: Error) => toast.error(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Unlink installations
                </button>
              )}
            </>
          ) : ghStatus?.githubAppConfigured && !showAppAdvanced ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api
                    .testGitHubApp()
                    .then((r) => {
                      setTestResult(JSON.stringify(r, null, 2));
                      toast.success((r as { ok?: boolean }).ok ? "GitHub App token OK" : "Test finished");
                    })
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Test installation token
              </button>
              {canConfigureOrgApp && (
                <button type="button" className="ghost sm" onClick={() => setShowAppAdvanced(true)}>
                  Reconfigure…
                </button>
              )}
              <button
                type="button"
                className="danger sm"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Remove GitHub App credentials and installations for this Codesteward org? Repo listing will stop until you reconnect.",
                    )
                  ) {
                    return;
                  }
                  setBusy(true);
                  api
                    .deleteGitHubApp()
                    .then(() => {
                      toast.info("GitHub App disconnected");
                      setShowAppAdvanced(false);
                      setAppForm({
                        appId: "",
                        privateKeyPem: "",
                        installationId: "",
                        accountLogin: "",
                        baseUrl: "https://api.github.com",
                        webhookSecret: "",
                      });
                      setGhInstallOptions([]);
                      setInstallSelect("");
                      return refresh();
                    })
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Disconnect App
              </button>
            </>
          ) : (
            <>
              {canConfigureOrgApp && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void createGitHubAppFromManifest()}
                >
                  {busy ? "Working…" : "1. Create App (Manifest — no PEM)"}
                </button>
              )}
              <button type="button" className="primary" disabled={busy} onClick={() => void installGitHubApp()}>
                {busy
                  ? "Redirecting…"
                  : canConfigureOrgApp
                    ? "2. Install GitHub App"
                    : "Install GitHub App"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api
                    .testGitHubApp()
                    .then((r) => {
                      setTestResult(JSON.stringify(r, null, 2));
                      toast.success((r as { ok?: boolean }).ok ? "GitHub App token OK" : "Test finished");
                    })
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Test installation token
              </button>
              {canConfigureOrgApp && (
                <button type="button" className="ghost sm" onClick={() => setShowAppAdvanced((v) => !v)}>
                  {showAppAdvanced ? "Hide advanced config" : "Advanced: paste App credentials"}
                </button>
              )}
              {ghStatus?.githubAppConfigured && canConfigureOrgApp && (
                <button type="button" className="ghost sm" onClick={() => setShowAppAdvanced(false)}>
                  Done
                </button>
              )}
            </>
          )}
        </div>

        {showAppAdvanced && canConfigureOrgApp && (
          <>
            <div className="grid cols-2" style={{ marginTop: "1rem", gap: 12 }}>
              <div className="field">
                <label>App ID</label>
                <input
                  value={appForm.appId}
                  onChange={(e) => setAppForm((f) => ({ ...f, appId: e.target.value }))}
                  placeholder="123456"
                />
              </div>
              <div className="field">
                <label>API base (GHE optional)</label>
                <input
                  value={appForm.baseUrl}
                  onChange={(e) => setAppForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="https://api.github.com"
                />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Private key PEM</label>
                <textarea
                  rows={5}
                  className="mono"
                  value={appForm.privateKeyPem}
                  onChange={(e) => setAppForm((f) => ({ ...f, privateKeyPem: e.target.value }))}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----"
                  style={{ width: "100%" }}
                />
              </div>
              <div className="field">
                <label>Webhook secret</label>
                <input
                  type="password"
                  value={appForm.webhookSecret}
                  onChange={(e) => setAppForm((f) => ({ ...f, webhookSecret: e.target.value }))}
                />
              </div>

              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>GitHub org / account (installation)</label>
                <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", lineHeight: 1.45 }}>
                  This is the <strong>GitHub</strong> organization or user where the App is installed — not the
                  Codesteward product org. Load installations after pasting App ID + PEM (or after a prior save).
                </p>
                <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <button
                    type="button"
                    className="sm"
                    disabled={
                      installsLoading ||
                      !(
                        ghStatus?.githubAppConfigured ||
                        (appForm.appId.trim() && appForm.privateKeyPem.trim())
                      )
                    }
                    onClick={() => void loadGitHubInstallations()}
                  >
                    {installsLoading ? "Loading…" : "Load installations from GitHub"}
                  </button>
                  {(ghStatus?.installations?.length ?? 0) > 0 && ghInstallOptions.length === 0 && (
                    <button
                      type="button"
                      className="ghost sm"
                      onClick={() => {
                        const fromStatus = (ghStatus?.installations ?? [])
                          .filter((i) => /^\d+$/.test(String(i.installationId ?? "")))
                          .map((i) => ({
                            installationId: String(i.installationId),
                            accountLogin: String(i.accountLogin ?? i.installationId),
                            accountType: "Organization",
                            source: "local",
                          }));
                        setGhInstallOptions(fromStatus);
                        if (fromStatus.length === 1) {
                          setInstallSelect(fromStatus[0]!.installationId);
                          setAppForm((f) => ({
                            ...f,
                            installationId: fromStatus[0]!.installationId,
                            accountLogin: fromStatus[0]!.accountLogin,
                          }));
                        }
                      }}
                    >
                      Use saved installations ({ghStatus?.installations?.length})
                    </button>
                  )}
                </div>

                {!manualAccount && ghInstallOptions.length > 0 ? (
                  <select
                    value={installSelect}
                    onChange={(e) => {
                      const v = e.target.value;
                      setInstallSelect(v);
                      if (v === "__manual__") {
                        setManualAccount(true);
                        return;
                      }
                      const hit = ghInstallOptions.find((i) => i.installationId === v);
                      if (hit) {
                        setAppForm((f) => ({
                          ...f,
                          installationId: hit.installationId,
                          accountLogin: hit.accountLogin,
                        }));
                      }
                    }}
                    aria-label="GitHub installation account"
                  >
                    <option value="">Select GitHub org / user…</option>
                    {ghInstallOptions.map((i) => (
                      <option key={i.installationId} value={i.installationId}>
                        {i.accountLogin}
                        {i.accountType ? ` (${i.accountType})` : ""}
                        {` · install ${i.installationId}`}
                      </option>
                    ))}
                    <option value="__manual__">Enter installation manually…</option>
                  </select>
                ) : (
                  <div className="grid cols-2" style={{ gap: 12 }}>
                    <div className="field" style={{ margin: 0 }}>
                      <label>Account login</label>
                      <input
                        value={appForm.accountLogin}
                        onChange={(e) =>
                          setAppForm((f) => ({ ...f, accountLogin: e.target.value }))
                        }
                        placeholder="acme-corp"
                        autoComplete="off"
                      />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label>Installation ID</label>
                      <input
                        value={appForm.installationId}
                        onChange={(e) =>
                          setAppForm((f) => ({ ...f, installationId: e.target.value }))
                        }
                        placeholder="12345678"
                        autoComplete="off"
                      />
                    </div>
                    {ghInstallOptions.length > 0 && (
                      <button
                        type="button"
                        className="ghost sm"
                        style={{ gridColumn: "1 / -1", width: "fit-content" }}
                        onClick={() => setManualAccount(false)}
                      >
                        Back to installation list
                      </button>
                    )}
                  </div>
                )}
                {appForm.installationId && appForm.accountLogin && !manualAccount && (
                  <p className="mono muted" style={{ margin: "0.5rem 0 0", fontSize: "0.75rem" }}>
                    Selected: {appForm.accountLogin} · installation {appForm.installationId}
                  </p>
                )}
              </div>
            </div>
            <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="primary"
                disabled={busy || !appForm.appId.trim() || !appForm.privateKeyPem.trim()}
                onClick={() => {
                  setBusy(true);
                  api
                    .putGitHubApp({
                      appId: appForm.appId.trim(),
                      privateKeyPem: appForm.privateKeyPem.trim(),
                      installationId: appForm.installationId.trim() || undefined,
                      accountLogin: appForm.accountLogin.trim() || undefined,
                      baseUrl: appForm.baseUrl.trim() || undefined,
                      webhookSecret: appForm.webhookSecret.trim() || undefined,
                    })
                    .then((r) => {
                      const ready = (r as { installationReady?: boolean }).installationReady;
                      toast.success(
                        ready
                          ? "GitHub App saved with installation — open PRs to list repos"
                          : "GitHub App credentials saved — select an installation or Install App (step 2)",
                      );
                      setAppForm((f) => ({
                        ...f,
                        privateKeyPem: "",
                        webhookSecret: "",
                      }));
                      setShowAppAdvanced(true);
                      return refresh();
                    })
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Save GitHub App credentials
              </button>
              {!appForm.installationId.trim() && (
                <span className="muted" style={{ fontSize: "0.8rem", alignSelf: "center" }}>
                  Pick a GitHub org/user installation to list repos.
                </span>
              )}
            </div>
          </>
        )}

        {ghStatus?.authMode === "pat_legacy" && (
          <p className="badge warn" style={{ marginTop: 12, display: "inline-block" }}>
            {platformEnforced && !canUsePat
              ? "PAT is ignored while the platform GitHub App is enforced."
              : "PAT mode active — fine for local dev only; switch to GitHub App for enterprise."}
          </p>
        )}

        {canUsePat ? (
          <div style={{ marginTop: "1.25rem", borderTop: "1px solid var(--border)", paddingTop: "0.85rem" }}>
            <button
              type="button"
              className="ghost sm"
              onClick={() => setShowPatBreakGlass((v) => !v)}
              aria-expanded={showPatBreakGlass}
            >
              {showPatBreakGlass ? "▾" : "▸"} Dev break-glass: Personal Access Token
              {ghStatus?.patDevOnly !== false ? " (not for enterprise)" : ""}
            </button>
            {showPatBreakGlass && (
              <div style={{ marginTop: 12 }}>
                <p className="muted" style={{ margin: "0 0 0.75rem", fontSize: "0.82rem", maxWidth: 560 }}>
                  PATs are demoted on purpose. Prefer Install GitHub App. Use a PAT only for local smoke tests.
                </p>
                <button
                  type="button"
                  className="sm"
                  onClick={() => {
                    const gh = connectors.find((c) => c.type === "github");
                    if (gh) openConfigure(gh);
                    else toast.info("GitHub connector not listed — check API connectors response");
                  }}
                >
                  Configure PAT connector
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="muted" style={{ marginTop: "1rem", fontSize: "0.82rem", lineHeight: 1.45 }}>
            Personal Access Tokens are disabled for this install (platform GitHub App enforced). Use{" "}
            <strong>Install platform GitHub App</strong> above.
          </p>
        )}

        {testResult && (
          <pre className="mono" style={{ fontSize: 11, maxHeight: 160, overflow: "auto", marginTop: 12 }}>
            {testResult}
          </pre>
        )}
      </div>

      {loading ? (
        <SkeletonCards count={4} />
      ) : connectors.length === 0 ? (
        <div className="card">
          <EmptyState title="Unable to load connectors" description="Is the API running?" />
        </div>
      ) : (
        <div className="connector-grid">
          {connectors.map((c) => {
            const m = META[c.type] ?? {
              title: c.type,
              blurb: c.note ?? "Custom connector",
              fields: [],
            };
            return (
              <div key={c.type} className="card connector-card interactive">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <ConnectorBrandIcon type={c.type} size={24} />
                  <Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge>
                </div>
                <div>
                  <h4>{m.title}</h4>
                  <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                    {m.blurb}
                  </p>
                </div>
                {c.tokenMasked && (
                  <div className="mono muted" style={{ fontSize: "0.72rem" }}>
                    auth {c.tokenMasked}
                  </div>
                )}
                {c.note && (
                  <div className="muted" style={{ fontSize: "0.75rem", lineHeight: 1.4 }}>
                    {c.note}
                  </div>
                )}
                {c.baseUrl && (
                  <div className="mono muted" style={{ fontSize: "0.72rem" }}>
                    {c.baseUrl}
                  </div>
                )}
                <div className="row" style={{ marginTop: 4, gap: 6, flexWrap: "wrap" }}>
                  <button type="button" className="primary sm" onClick={() => openConfigure(c)}>
                    {c.configured ? "Edit" : "Configure"}
                  </button>
                  {c.configured && c.type !== "mcp" && (
                    <button
                      type="button"
                      className="danger sm"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove ${m.title} credentials for this org?`,
                          )
                        ) {
                          return;
                        }
                        setBusy(true);
                        api
                          .deleteConnector(c.type)
                          .then(() => {
                            toast.info(`${m.title} removed`);
                            return refresh();
                          })
                          .catch((e: Error) => toast.error(e.message))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && meta && (
        <>
          <div className="drawer-backdrop" onClick={() => setEditing(null)} aria-hidden />
          <aside className="drawer" role="dialog" aria-modal>
            <div className="drawer-header">
              <div>
                <h2>Configure {meta.title}</h2>
                <div className="muted" style={{ marginTop: 4, fontSize: "0.8rem" }}>
                  {active?.status?.replace(/_/g, " ")}
                  {active?.tokenMasked ? ` · ${active.tokenMasked}` : ""}
                </div>
              </div>
              <button type="button" className="ghost sm" onClick={() => setEditing(null)}>
                ✕
              </button>
            </div>
            <div className="drawer-body stack">
              {meta.fields.map((f) => (
                <div className="field" key={f.key}>
                  <label>{f.label}</label>
                  <input
                    type={f.type ?? "text"}
                    value={form[f.key] ?? ""}
                    placeholder={
                      f.key === "token" && active?.tokenMasked
                        ? `Leave blank to keep ${active.tokenMasked}`
                        : f.placeholder
                    }
                    onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    autoComplete="off"
                  />
                </div>
              ))}
              {testResult && (
                <pre className="mono" style={{ fontSize: 11, maxHeight: 160, overflow: "auto", margin: 0 }}>
                  {testResult}
                </pre>
              )}
            </div>
            <div className="drawer-footer row" style={{ justifyContent: "space-between" }}>
              <button type="button" className="danger sm" disabled={busy} onClick={() => void remove()}>
                Remove connector
              </button>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void test()}>
                  Test
                </button>
                <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                  Save
                </button>
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
