import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { api, getOrgId, setOrgId, type OrgSummary } from "../lib/api";

/**
 * Guided setup: (1) create org → (2) install GitHub App → (3) first review.
 * Users with zero memberships land here (SaaS signup / no IdP org groups).
 */
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
  const [platformEnforced, setPlatformEnforced] = useState(false);
  const [needsOrg, setNeedsOrg] = useState(false);
  const [saasBilling, setSaasBilling] = useState(false);
  const [plans, setPlans] = useState<
    Array<{
      id: string;
      label: string;
      description?: string;
      priceLabel?: string;
      highlights?: string[];
      pricing?: string;
      requiresSeatPurchase?: boolean;
      minSeats?: number;
      maxSeats?: number;
      defaultSeats?: number;
      pricePerSeatCents?: number | null;
    }>
  >([]);
  const [selectedPlan, setSelectedPlan] = useState("free");
  const [purchaseSeats, setPurchaseSeats] = useState(5);

  useEffect(() => {
    void api
      .listOrgs()
      .then((r) => {
        setOrgs(r.orgs);
        setNeedsOrg(r.orgs.length === 0);
        const cur = getOrgId();
        const match = r.orgs.find((o) => o.id === cur) ?? null;
        // Preselect current org for “continue” — do not change step
        if (match) setCreatedOrg(match);
        else if (r.orgs.length === 0) setOrgId(null);
      })
      .catch(() => {
        setNeedsOrg(true);
        setOrgId(null);
      });
    void api
      .billingStatus()
      .then((s) => {
        setSaasBilling(Boolean(s.configured));
        setPlans(s.plans ?? []);
        const pro = (s.plans ?? []).find((p) => p.id === "pro");
        if (pro?.defaultSeats) setPurchaseSeats(pro.defaultSeats);
      })
      .catch(() => setSaasBilling(false));
    void api
      .githubAppStatus()
      .then((s) => {
        setGhConfigured(s.githubAppConfigured);
        setInstallCount(s.installations?.length ?? 0);
        setPlatformEnforced(
          s.orgCanConfigureApp === false ||
            Boolean(s.platformGithubApp?.enforce && s.platformGithubApp?.configured),
        );
        // Never force step 3 here — that skipped “create org” before the form was filled
      })
      .catch(() => setGhConfigured(false));
  }, []);

  const activeOrg = createdOrg ?? null;
  const hasOrg = Boolean(activeOrg) || orgs.length > 0;

  function goToStep(n: number) {
    if (n === 1) {
      setStep(1);
      return;
    }
    // Steps 2–3 require an org context (new or existing)
    if (!hasOrg && !activeOrg) {
      toast.error("Create or select an organization first");
      setStep(1);
      return;
    }
    setStep(n);
  }

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!orgName.trim()) {
      toast.error("Organization name is required");
      return;
    }
    setBusy(true);
    try {
      const planMeta = plans.find((p) => p.id === selectedPlan);
      const seats =
        planMeta?.requiresSeatPurchase || planMeta?.pricing === "per_seat"
          ? purchaseSeats
          : planMeta?.defaultSeats ?? (selectedPlan === "free" ? 5 : 5);
      const res = await api.createOrg({
        name: orgName.trim(),
        slug: orgSlug.trim() || undefined,
        ...(saasBilling
          ? {
              planId: selectedPlan,
              seats,
            }
          : {}),
      });
      setCreatedOrg(res.org);
      // Updates localStorage + notifies Layout OrgSwitcher (cs:org-changed)
      setOrgId(res.org.id);
      setNeedsOrg(false);
      setOrgs((prev) => {
        if (prev.some((o) => o.id === res.org.id)) return prev;
        return [...prev, res.org];
      });
      toast.success(
        res.note
          ? `Org “${res.org.name}” created — ${res.note}`
          : `Org “${res.org.name}” created — now active`,
      );
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

  const displayOrg =
    activeOrg ?? orgs.find((o) => o.id === getOrgId()) ?? orgs[0] ?? null;

  return (
    <div>
      <PageHero
        kicker="Get started"
        title={needsOrg ? "Welcome — set up your organization" : "Onboarding"}
        subtitle={
          needsOrg
            ? "You are signed in but not a member of any organization yet. Create yours below, or wait for an admin invite."
            : "Three steps: create an organization, install the GitHub App, run your first review."
        }
      />

      {needsOrg && (
        <div className="card stack" style={{ maxWidth: 560, marginBottom: "1rem" }}>
          <h3 style={{ margin: 0 }}>Join an existing organization?</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.55 }}>
            You cannot self-join an existing org. Ask an <strong>organization admin</strong> to invite
            your email from <span className="mono">Members</span>. After they invite you, sign out and
            back in (or refresh) — your org will appear in the sidebar switcher.
          </p>
        </div>
      )}

      <div className="onboarding-steps">
        {[1, 2, 3].map((n) => {
          const locked = n > 1 && !hasOrg && !displayOrg;
          return (
            <button
              key={n}
              type="button"
              className={`onboarding-step${step === n ? " active" : ""}${n < step ? " done" : ""}${locked ? " locked" : ""}`}
              onClick={() => goToStep(n)}
              disabled={locked}
              title={locked ? "Complete step 1 first" : undefined}
            >
              <span className="onboarding-step-num">{n < step ? "✓" : n}</span>
              <span>
                {n === 1 ? "Create org" : n === 2 ? "Install GitHub App" : "First review"}
              </span>
            </button>
          );
        })}
      </div>

      {step === 1 && (
        <div className="card stack" style={{ maxWidth: 520 }}>
          <h3 style={{ margin: 0 }}>1 · Create organization</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Orgs isolate members, connectors, policy, and learnings. You become the owner.
            {saasBilling
              ? " Pick a plan below — you can change it anytime from Billing."
              : " Self-host installs do not use cloud plans."}
          </p>
          {saasBilling && plans.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="muted" style={{ fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Plan
              </div>
              <div className="grid cols-3" style={{ gap: 10 }}>
                {plans.map((p) => {
                  const active = selectedPlan === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={active ? "card interactive" : "card"}
                      style={{
                        margin: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        borderColor: active ? "var(--accent, #5b9fd4)" : undefined,
                        boxShadow: active ? "0 0 0 1px var(--accent, #5b9fd4)" : undefined,
                      }}
                      onClick={() => {
                        setSelectedPlan(p.id);
                        if (p.defaultSeats) setPurchaseSeats(p.defaultSeats);
                      }}
                    >
                      <div style={{ fontWeight: 650 }}>{p.label}</div>
                      <div className="muted" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                        {p.priceLabel ?? ""}
                      </div>
                      <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", lineHeight: 1.4 }}>
                        {p.description}
                      </p>
                      {p.highlights && p.highlights.length > 0 && (
                        <ul
                          className="muted"
                          style={{ margin: "0.45rem 0 0", paddingLeft: "1.1rem", fontSize: "0.78rem" }}
                        >
                          {p.highlights.slice(0, 3).map((h) => (
                            <li key={h}>{h}</li>
                          ))}
                        </ul>
                      )}
                    </button>
                  );
                })}
              </div>
              {(() => {
                const p = plans.find((x) => x.id === selectedPlan);
                if (!p?.requiresSeatPurchase && p?.pricing !== "per_seat" && p?.pricing !== "custom") {
                  return null;
                }
                const min = p.minSeats ?? 1;
                const max = p.maxSeats ?? 50;
                const cents = p.pricePerSeatCents;
                return (
                  <div className="field" style={{ marginTop: 4 }}>
                    <label htmlFor="onboarding-seats">
                      Seats to purchase (required before inviting members)
                    </label>
                    <input
                      id="onboarding-seats"
                      type="number"
                      min={min}
                      max={max}
                      value={purchaseSeats}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) return;
                        setPurchaseSeats(Math.max(min, Math.min(max, Math.floor(n))));
                      }}
                    />
                    <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
                      {purchaseSeats} seat{purchaseSeats === 1 ? "" : "s"}
                      {cents
                        ? ` · ~$${((purchaseSeats * cents) / 100).toFixed(0)}/mo demo estimate`
                        : ""}
                      . Invites stop when all seats are used — buy more under Billing.
                    </p>
                  </div>
                );
              })()}
              {selectedPlan !== "free" && (
                <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
                  Demo: paid plans apply immediately without a card. Production will collect payment
                  via the Billing portal (Stripe).
                </p>
              )}
            </div>
          )}
          {displayOrg && (
            <div
              className="row"
              style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}
            >
              <Badge tone="ok">current</Badge>
              <span style={{ fontWeight: 600 }}>{displayOrg.name}</span>
              <span className="mono muted" style={{ fontSize: "0.75rem" }}>
                {displayOrg.id}
              </span>
              <button
                type="button"
                className="sm"
                onClick={() => {
                  setCreatedOrg(displayOrg);
                  setOrgId(displayOrg.id);
                  setStep(2);
                }}
              >
                Continue with this org →
              </button>
            </div>
          )}
          <form className="stack" onSubmit={(e) => void createOrg(e)}>
            <div className="field">
              <label htmlFor="onboarding-org-name">Name</label>
              <input
                id="onboarding-org-name"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Engineering"
                autoComplete="organization"
              />
            </div>
            <div className="field">
              <label htmlFor="onboarding-org-slug">Slug (optional)</label>
              <input
                id="onboarding-org-slug"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="acme"
                className="mono"
              />
            </div>
            <button type="submit" className="primary" disabled={busy || !orgName.trim()}>
              {busy ? "Creating…" : "Create organization"}
            </button>
          </form>
        </div>
      )}

      {step === 2 && (
        <div className="card stack" style={{ maxWidth: 560 }}>
          <h3 style={{ margin: 0 }}>2 · Install GitHub App</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            {platformEnforced
              ? "This install uses a shared platform GitHub App. Install it on your GitHub organization — you do not create or paste your own App credentials."
              : "Enterprise-ready path uses short-lived installation tokens — not personal access tokens."}
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {platformEnforced && <Badge tone="configured">platform app</Badge>}
            <Badge tone={ghConfigured ? "ok" : "warn"}>
              app {ghConfigured ? "configured" : "not configured"}
            </Badge>
            <Badge tone={installCount > 0 ? "ok" : "warn"}>
              {installCount} installation{installCount === 1 ? "" : "s"}
            </Badge>
            {displayOrg && (
              <span className="mono muted" style={{ fontSize: "0.75rem" }}>
                org={displayOrg.id}
              </span>
            )}
          </div>
          <button type="button" className="primary" disabled={busy} onClick={() => void installGitHub()}>
            {busy
              ? "Redirecting…"
              : platformEnforced
                ? "Install platform GitHub App"
                : "Install GitHub App"}
          </button>
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            {platformEnforced ? (
              <>
                Opens GitHub to install the shared App for your org. Manage connection under{" "}
                <Link to="/connectors">Connectors</Link>.
              </>
            ) : (
              <>
                Opens GitHub to authorize the app for your org. Advanced PEM paste lives under{" "}
                <Link to="/connectors">Connectors</Link> (dev break-glass).
              </>
            )}
          </p>
          {ghConfigured && installCount > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
              GitHub App already installed — you can continue to your first review.
            </p>
          )}
          <div className="row">
            <button type="button" className="ghost sm" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button type="button" className="primary sm" onClick={() => setStep(3)}>
              {ghConfigured && installCount > 0 ? "Continue to first review →" : "Skip for now →"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card stack" style={{ maxWidth: 560 }}>
          <h3 style={{ margin: 0 }}>3 · Run your first review</h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
            Gate a PR before merge, or steward a long-lived branch continuously.
            {displayOrg ? (
              <>
                {" "}
                Active org: <strong>{displayOrg.name}</strong>
              </>
            ) : null}
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
