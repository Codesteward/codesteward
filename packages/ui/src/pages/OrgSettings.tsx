import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { api, getOrgId, type AuthUser } from "../lib/api";
import {
  OrgAuditLog,
  OrgLangfusePanel,
  OrgPublishSarifPanel,
  OrgScimPanel,
  OrgSuggestedCodeFixesPanel,
  OrgTraceTtlPanel,
} from "./settings/panels";

export function OrgSettings() {
  const toast = useToast();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orgRole, setOrgRole] = useState<string | null>(null);
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgBusy, setOrgBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [planStatus, setPlanStatus] = useState<string | null>(null);
  const [planSeats, setPlanSeats] = useState<number | null>(null);
  const [billingConfigured, setBillingConfigured] = useState(false);
  const [planFeatures, setPlanFeatures] = useState<
    Array<{ id: string; label: string; enabled: boolean }>
  >([]);
  const oid = getOrgId() ?? "local";

  // Prefer org membership role (owner/admin) over global product role (often "reviewer" via OIDC)
  const canAdmin = (() => {
    if (!user || user.id === "api_key") return true;
    const r = (orgRole ?? user.role ?? "").toLowerCase();
    return r === "owner" || r === "admin" || r === "steward-admin";
  })();

  useEffect(() => {
    api
      .authMe()
      .then((r) => {
        setUser(r.user);
        const fromMe = r.orgs?.find((o) => o.id === oid);
        if (fromMe?.role) setOrgRole(fromMe.role);
      })
      .catch(() => setUser(null));
    api
      .listOrgs()
      .then((r) => {
        const o = r.orgs.find((x) => x.id === oid) ?? r.orgs[0];
        if (o) {
          setOrgName(o.name ?? "");
          setOrgSlug(o.slug ?? "");
          if (o.role) setOrgRole(o.role);
        }
      })
      .catch(() => undefined);
    api
      .license()
      .then((r) => {
        setBillingConfigured(Boolean(r.billingConfigured));
        setPlanId(r.plan?.id ?? r.license?.tier ?? null);
        setPlanStatus(r.plan?.status ?? r.license?.status ?? null);
        setPlanSeats(r.plan?.seats ?? r.license?.maxSeats ?? null);
        setPlanFeatures(
          (r.features ?? []).map((f) => ({
            id: f.id,
            label: f.label,
            enabled: f.enabled,
          })),
        );
      })
      .catch(() => undefined);
  }, [oid]);

  async function saveOrgName() {
    if (!orgName.trim()) {
      toast.error("Organization name required");
      return;
    }
    setOrgBusy(true);
    try {
      const res = await api.updateOrg(oid, {
        name: orgName.trim(),
        slug: orgSlug.trim() || undefined,
      });
      setOrgName(res.org.name);
      setOrgSlug(res.org.slug ?? orgSlug);
      toast.success(`Organization renamed to “${res.org.name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setOrgBusy(false);
    }
  }

  return (
    <div>
      <PageHero
        kicker="Tenant"
        title="Organization"
        subtitle="Tenant-scoped settings for the active org. Platform-wide knobs live under Platform (operators only)."
        actions={
          <Link to="/settings" className="ghost sm" style={{ textDecoration: "none" }}>
            All settings
          </Link>
        }
      />

      <div className="grid cols-2">
        <div className="card stack">
          <h3>Identity</h3>
          <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
            Active org <span className="mono">{oid}</span>
            {user?.role ? (
              <>
                {" "}
                · your role <Badge tone="running">{user.role}</Badge>
              </>
            ) : null}
          </p>
          <div className="field">
            <label>Organization name</label>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Engineering"
              disabled={!canAdmin}
            />
          </div>
          <div className="field">
            <label>Slug (optional)</label>
            <input
              value={orgSlug}
              onChange={(e) => setOrgSlug(e.target.value)}
              placeholder="acme"
              className="mono"
              disabled={!canAdmin}
            />
          </div>
          <button
            type="button"
            className="primary sm"
            disabled={orgBusy || !orgName.trim() || !canAdmin}
            onClick={() => void saveOrgName()}
          >
            {orgBusy ? "Saving…" : "Save organization"}
          </button>
          {!canAdmin && (
            <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
              Only org admin / owner can rename this organization.
            </p>
          )}
        </div>

        <div className="card stack">
          <h3>Tenant configuration</h3>
          <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
            These stay org-scoped (each tenant has its own):
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.7, fontSize: "0.9rem" }}>
            <li>
              <Link to="/members">Members &amp; roles</Link>
            </li>
            <li>
              <Link to="/models">Models, provider keys &amp; Langfuse</Link>
            </li>
            <li>
              <Link to="/connectors">SCM connectors</Link>
            </li>
            <li>
              <Link to="/prompts">Prompt pack</Link>
            </li>
            <li>
              <Link to="/policy">Policy / STEWARD</Link>
            </li>
            <li>
              <Link to="/learnings">Learnings</Link>
            </li>
          </ul>
        </div>

        <div className="card stack" style={{ gridColumn: "1 / -1" }}>
          <h3>Plan &amp; billing</h3>
          {billingConfigured ? (
            <>
              <p className="muted" style={{ fontSize: "0.88rem", margin: 0, lineHeight: 1.55 }}>
                Your organization plan controls paid features (thorough reviews, Prove, SCIM, and
                more). Manage plan, seats, and billing contact in the cloud Billing portal.
              </p>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Badge tone="ok">{planId ?? "free"}</Badge>
                {planStatus && (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {planStatus}
                  </span>
                )}
                {planSeats != null && (
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {planSeats} seats
                  </span>
                )}
              </div>
              {planFeatures.length > 0 && (
                <div
                  className="row"
                  style={{ gap: 6, flexWrap: "wrap", maxHeight: 120, overflow: "auto" }}
                >
                  {planFeatures
                    .filter((f) => f.enabled)
                    .slice(0, 16)
                    .map((f) => (
                      <Badge key={f.id} tone="running">
                        {f.label}
                      </Badge>
                    ))}
                </div>
              )}
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="primary sm"
                  disabled={portalBusy || !oid}
                  onClick={() => {
                    void (async () => {
                      setPortalBusy(true);
                      try {
                        // Same tab: “Back to app” returns here (no extra platform tab)
                        const res = await api.openBillingPortal({
                          returnTo:
                            typeof window !== "undefined"
                              ? `${window.location.origin}/settings/organization`
                              : undefined,
                        });
                        if (res.url) window.location.assign(res.url);
                        else toast.error("Portal URL unavailable");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : String(e));
                      } finally {
                        setPortalBusy(false);
                      }
                    })();
                  }}
                >
                  {portalBusy ? "Opening…" : "Open billing portal"}
                </button>
                <p className="muted" style={{ fontSize: "0.8rem", margin: 0, flex: 1 }}>
                  Opens the Codesteward Cloud billing portal in this tab (same as the Billing menu).
                  Use “Back to app” to return here.
                </p>
              </div>
            </>
          ) : (
            <p className="muted" style={{ fontSize: "0.88rem", margin: 0, lineHeight: 1.55 }}>
              This install is not connected to cloud billing. Feature access follows the install-wide
              license (Platform settings) or community defaults.
            </p>
          )}
        </div>

        {canAdmin && (
          <div style={{ gridColumn: "1 / -1" }}>
            <OrgSuggestedCodeFixesPanel />
          </div>
        )}
        {canAdmin && (
          <div style={{ gridColumn: "1 / -1" }}>
            <OrgPublishSarifPanel />
          </div>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <OrgLangfusePanel />
        </div>
        {canAdmin && (
          <div style={{ gridColumn: "1 / -1" }}>
            <OrgTraceTtlPanel />
          </div>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <OrgScimPanel />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <OrgAuditLog />
        </div>
      </div>
    </div>
  );
}
