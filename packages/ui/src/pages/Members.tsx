import { useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, KpiCard, PageHero, SkeletonLines, formatRelative } from "../components/ui";
import { Select } from "../components/Select";
import { api, getOrgId, type OrgMember } from "../lib/api";

const ROLES = ["viewer", "reviewer", "admin", "owner"] as const;

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export function Members() {
  const toast = useToast();
  const orgId = getOrgId() ?? "local";
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [keycloakIdentity, setKeycloakIdentity] = useState(false);
  const [kcAdminOk, setKcAdminOk] = useState<boolean | null>(null);

  // Invite form
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("reviewer");
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null);

  // Create user shortcut
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "reviewer" | "viewer">("reviewer");

  const refresh = async () => {
    try {
      const [m, inv, idStatus] = await Promise.all([
        api.listMembers(orgId),
        api.listInvitations(orgId).catch(() => ({ invitations: [] as PendingInvitation[] })),
        api.identityStatus().catch(() => null),
      ]);
      setMembers(m.members);
      setInvitations(inv.invitations ?? []);
      if (idStatus) {
        setKeycloakIdentity(idStatus.keycloak || idStatus.mode === "keycloak");
        setKcAdminOk(idStatus.admin ? idStatus.admin.ok : idStatus.adminConfigured);
      }
    } catch (e) {
      setMembers([]);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setLastInviteToken(null);
    try {
      const res = await api.inviteMember(orgId, { email: email.trim(), role });
      setLastInviteToken(res.invitation.token);
      toast.success(`Invitation sent to ${res.invitation.email}`);
      setEmail("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createUser({
        email: newEmail.trim(),
        password: newPassword,
        displayName: newName.trim() || undefined,
        role: newRole,
        orgId,
      });
      toast.success(`User ${newEmail} created`);
      setNewEmail("");
      setNewPassword("");
      setNewName("");
      setShowCreateUser(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(userId: string, nextRole: string) {
    setBusy(true);
    try {
      await api.updateMember(orgId, userId, { role: nextRole });
      toast.success("Role updated");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string, label: string) {
    if (!window.confirm(`Remove ${label} from this org?`)) return;
    setBusy(true);
    try {
      await api.removeMember(orgId, userId);
      toast.info("Member removed");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHero
        kicker="Tenant"
        title="Members"
        subtitle={
          keycloakIdentity
            ? "Users and roles are managed in the platform identity service. This page provisions accounts into the organization. MFA and federated SSO (Microsoft, Google, Okta, …) are configured on that service — not in Codesteward."
            : "Invite teammates, manage org roles, or create local users for self-hosted setups."
        }
      />
      {keycloakIdentity && (
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 1rem", lineHeight: 1.5 }}>
          Identity: <Badge tone="ok">managed directory</Badge>{" "}
          {kcAdminOk === true && <Badge tone="ok">provisioning ready</Badge>}
          {kcAdminOk === false && (
            <Badge tone="warn">provisioning API unavailable</Badge>
          )}{" "}
          · Users sign in with <strong>Sign in</strong> on the login page.
        </p>
      )}

      <div className="grid cols-3" style={{ marginBottom: "1rem" }}>
        <KpiCard label="Members" value={members.length} meta={`org ${orgId}`} loading={loading} />
        <KpiCard
          label="Admins"
          value={members.filter((m) => m.role === "admin" || m.role === "owner").length}
          meta="owner + admin"
          loading={loading}
        />
        <KpiCard
          label="Pending invites"
          value={invitations.length}
          meta={
            invitations.length
              ? invitations.slice(0, 2).map((i) => i.email).join(", ")
              : "none outstanding"
          }
          loading={loading}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-header">
            <h3>Team</h3>
            <Badge tone="configured">{orgId}</Badge>
          </div>
          {loading ? (
            <SkeletonLines lines={5} />
          ) : members.length === 0 ? (
            <EmptyState
              title="No members yet"
              description="Invite someone by email or create a local user account."
              icon="◎"
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const label = m.displayName || m.email || m.userId;
                    return (
                      <tr key={`${m.orgId}:${m.userId}`}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{label}</div>
                          {m.email && (
                            <div className="muted mono" style={{ fontSize: "0.72rem" }}>
                              {m.email}
                            </div>
                          )}
                        </td>
                        <td>
                          <Select
                            value={m.role}
                            disabled={busy}
                            onChange={(v) => void changeRole(m.userId, v)}
                            size="sm"
                            fullWidth={false}
                            style={{ minWidth: 110 }}
                            aria-label={`Role for ${label}`}
                            options={ROLES.map((r) => ({ value: r, label: r }))}
                          />
                        </td>
                        <td className="muted">{formatRelative(m.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="ghost sm danger"
                            disabled={busy}
                            onClick={() => void remove(m.userId, label)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card stack">
            <h3 style={{ margin: 0 }}>
              {keycloakIdentity ? "Add organization member" : "Invite member"}
            </h3>
            <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
              {keycloakIdentity
                ? "Creates the user in the platform identity directory (org membership + role) and links them here. Prefer Sign in on the login page; a temporary password is only shown if you set one."
                : "Creates an invitation token you can share (self-host does not send email)."}
            </p>
            <form className="stack" onSubmit={(e) => void invite(e)}>
              <div className="field">
                <label>Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label>Role</label>
                <Select
                  value={role}
                  onChange={setRole}
                  aria-label="Invitation role"
                  options={ROLES.filter((r) => r !== "owner").map((r) => ({ value: r, label: r }))}
                />
              </div>
              <button type="submit" className="primary" disabled={busy || !email.trim()}>
                {busy
                  ? "Working…"
                  : keycloakIdentity
                    ? "Provision user"
                    : "Send invitation"}
              </button>
            </form>
            {lastInviteToken && (
              <div className="card" style={{ background: "var(--bg-deep)", margin: 0 }}>
                <div className="muted" style={{ fontSize: "0.75rem", marginBottom: 6 }}>
                  One-time invite token (share securely)
                </div>
                <code className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all" }}>
                  {lastInviteToken}
                </code>
              </div>
            )}
            {invitations.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div className="card-header" style={{ marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Pending invitations</h3>
                  <Badge tone="warn">{invitations.length}</Badge>
                </div>
                <div className="stack" style={{ gap: 8 }}>
                  {invitations.map((inv) => (
                    <div
                      key={inv.id}
                      className="card"
                      style={{ margin: 0, background: "var(--bg-deep)", padding: "0.65rem 0.85rem" }}
                    >
                      <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{inv.email}</div>
                          <div className="muted mono" style={{ fontSize: "0.72rem" }}>
                            role · {inv.role}
                          </div>
                        </div>
                        <div className="muted" style={{ fontSize: "0.75rem", textAlign: "right" }}>
                          <div>sent {formatRelative(inv.createdAt)}</div>
                          <div>expires {formatRelative(inv.expiresAt)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>Create user</h3>
              <button
                type="button"
                className="ghost sm"
                onClick={() => setShowCreateUser((v) => !v)}
              >
                {showCreateUser ? "Hide" : "Show"}
              </button>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
              Local account shortcut — adds the user and org membership in one step.
            </p>
            {showCreateUser && (
              <form className="stack" onSubmit={(e) => void createUser(e)}>
                <div className="field">
                  <label>Display name</label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ada" />
                </div>
                <div className="field">
                  <label>Email</label>
                  <input
                    type="email"
                    required
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="ada@example.com"
                  />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div className="field">
                  <label>Role</label>
                  <Select
                    value={newRole}
                    onChange={(v) => setNewRole(v as "admin" | "reviewer" | "viewer")}
                    aria-label="New user role"
                    options={[
                      { value: "viewer", label: "viewer" },
                      { value: "reviewer", label: "reviewer" },
                      { value: "admin", label: "admin" },
                    ]}
                  />
                </div>
                <button type="submit" className="primary" disabled={busy}>
                  Create user
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
