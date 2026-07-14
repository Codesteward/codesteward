import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { api, getOrgId, type AuthUser } from "../lib/api";
import { OrgAuditLog, OrgLangfusePanel, OrgScimPanel } from "./settings/panels";

export function OrgSettings() {
  const toast = useToast();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgBusy, setOrgBusy] = useState(false);
  const oid = getOrgId() ?? "local";

  const canAdmin =
    !user ||
    user.id === "api_key" ||
    user.role === "admin" ||
    user.role === "owner";

  useEffect(() => {
    api
      .authMe()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
    api
      .listOrgs()
      .then((r) => {
        const o = r.orgs.find((x) => x.id === oid) ?? r.orgs[0];
        if (o) {
          setOrgName(o.name ?? "");
          setOrgSlug(o.slug ?? "");
        }
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

        <div style={{ gridColumn: "1 / -1" }}>
          <OrgLangfusePanel />
        </div>
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
