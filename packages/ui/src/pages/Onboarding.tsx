import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { api, getOrgId, setOrgId, type OrgSummary } from "../lib/api";

export function Onboarding() {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [createdOrg, setCreatedOrg] = useState<OrgSummary | null>(null);
  const [ghConfigured, setGhConfigured] = useState<boolean | null>(null);
  const [installCount, setInstallCount] = useState(0);

  useEffect(() => {
    void api
      .listOrgs()
      .then((r) => {
        setOrgs(r.orgs);
        const cur = getOrgId();
        const match = r.orgs.find((o) => o.id === cur) ?? r.orgs[0] ?? null;
        if (match) setCreatedOrg(match);
      })
      .catch(() => undefined);
    void api
      .githubAppStatus()
      .then((s) => {
        setGhConfigured(s.githubAppConfigured);
        setInstallCount(s.installations?.length ?? 0);
        if (s.githubAppConfigured && (s.installations?.length ?? 0) > 0) {
          setStep((s0) => Math.max(s0, 3));
        }
      })
      .catch(() => setGhConfigured(false));
  }, []);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!orgName.trim()) return;
    setBusy(true);
    try {
      const res = await api.createOrg({
        name: orgName.trim(),
        slug: orgSlug.trim() || undefined,
      });
      setCreatedOrg(res.org);
      setOrgId(res.org.id);
      setOrgs((prev) => [...prev, res.org]);
      toast.success(`Org “${res.org.name}” created`);
      setStep(2);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function installGitHub() {
    setBusy(true);
    try {
      const orgId = createdOrg?.id ?? getOrgId() ?? "local";
      const res = await api.githubInstall(orgId);
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      toast.error(res.message ?? res.error ?? "Install URL unavailable");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const activeOrg = createdOrg ?? orgs[0] ?? null;

  return (
    <div>
      <PageHero
        kicker="Get started"
        title="Onboarding"
        subtitle="Three steps: create an organization, install the GitHub App, run your first review."
      />

      <div className="onboarding-steps">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            type="button"
            className={`onboarding-step${step === n ? " active" : ""}${n < step ? " done" : ""}`}
            onClick={() => setStep(n)}
          >
            <span className="onboarding-step-num">{n < step ? "✓" : n}</span>
            <span>
              {n === 1 ? "Create org" : n === 2 ? "Install GitHub App" : "First review"}
            </span>
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="card stack" style={{ maxWidth: 520 }}>
          <h3 style={{ margin: 0 }}>1 · Create organization</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Orgs isolate members, connectors, policy, and learnings. You can switch orgs anytime from the sidebar.
          </p>
          {activeOrg && (
            <div className="row" style={{ gap: 8 }}>
              <Badge tone="ok">current</Badge>
              <span style={{ fontWeight: 600 }}>{activeOrg.name}</span>
              <span className="mono muted" style={{ fontSize: "0.75rem" }}>
                {activeOrg.id}
              </span>
              <button type="button" className="primary sm" onClick={() => setStep(2)}>
                Continue with this org →
              </button>
            </div>
          )}
          <form className="stack" onSubmit={(e) => void createOrg(e)}>
            <div className="field">
              <label>Name</label>
              <input
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Engineering"
              />
            </div>
            <div className="field">
              <label>Slug (optional)</label>
              <input
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="acme"
                className="mono"
              />
            </div>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Creating…" : "Create organization"}
            </button>
          </form>
        </div>
      )}

      {step === 2 && (
        <div className="card stack" style={{ maxWidth: 560 }}>
          <h3 style={{ margin: 0 }}>2 · Install GitHub App</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Enterprise-ready path uses short-lived installation tokens — not personal access tokens.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge tone={ghConfigured ? "ok" : "warn"}>
              app {ghConfigured ? "configured" : "not configured"}
            </Badge>
            <Badge tone={installCount > 0 ? "ok" : "warn"}>
              {installCount} installation{installCount === 1 ? "" : "s"}
            </Badge>
            {activeOrg && (
              <span className="mono muted" style={{ fontSize: "0.75rem" }}>
                org={activeOrg.id}
              </span>
            )}
          </div>
          <button type="button" className="primary" disabled={busy} onClick={() => void installGitHub()}>
            {busy ? "Redirecting…" : "Install GitHub App"}
          </button>
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            Opens GitHub to authorize the app for your org. Advanced PEM paste lives under{" "}
            <Link to="/connectors">Connectors</Link> (dev break-glass).
          </p>
          <div className="row">
            <button type="button" className="ghost sm" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button type="button" className="sm" onClick={() => setStep(3)}>
              Skip for now →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card stack" style={{ maxWidth: 560 }}>
          <h3 style={{ margin: 0 }}>3 · Run your first review</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Gate a PR before merge, or steward a long-lived branch continuously.
          </p>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <Link to="/sessions?mode=gate" style={{ textDecoration: "none" }}>
              <div className="card interactive" style={{ margin: 0, height: "100%" }}>
                <div className="page-hero-kicker">Gate</div>
                <h4 style={{ margin: "0.25rem 0" }}>Gate a PR</h4>
                <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  Blocking review for pull requests with verdict + findings.
                </p>
              </div>
            </Link>
            <Link to="/sessions?mode=steward" style={{ textDecoration: "none" }}>
              <div className="card interactive" style={{ margin: 0, height: "100%" }}>
                <div className="page-hero-kicker">Steward</div>
                <h4 style={{ margin: "0.25rem 0" }}>Steward a branch</h4>
                <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  Continuous governance for main and long-lived branches.
                </p>
              </div>
            </Link>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Link to="/prs">
              <button type="button" className="sm">
                Browse PRs
              </button>
            </Link>
            <Link to="/dashboard">
              <button type="button" className="ghost sm">
                Go to dashboard
              </button>
            </Link>
          </div>
          <button type="button" className="ghost sm" onClick={() => setStep(2)}>
            ← Back
          </button>
        </div>
      )}
    </div>
  );
}
