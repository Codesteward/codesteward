import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { api, isPlatformOperator, type AuthUser } from "../lib/api";
import { AppearancePicker } from "./settings/panels";

export function AccountSettings() {
  const toast = useToast();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<string | undefined>();
  const [profileName, setProfileName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [flags, setFlags] = useState({
    graphMock: true,
    deepAgents: false,
    crossRepo: true,
    prove: true,
    webhooks: true,
  });

  useEffect(() => {
    api
      .authMe()
      .then((r) => {
        setUser(r.user);
        setAuthMode(r.authMode);
        if (r.user) {
          setProfileName(r.user.displayName || r.user.name || "");
          setProfileEmail(r.user.email || "");
        }
      })
      .catch(() => setUser(null));
    const saved = localStorage.getItem("cs-feature-flags");
    if (saved) {
      try {
        setFlags((f) => ({ ...f, ...JSON.parse(saved) }));
      } catch {
        /* ignore */
      }
    }
  }, []);

  async function saveProfile() {
    setProfileBusy(true);
    try {
      const res = await api.updateProfile({
        displayName: profileName.trim() || undefined,
        email: profileEmail.trim() || undefined,
      });
      setUser(res.user);
      setProfileName(res.user.displayName || res.user.name || "");
      setProfileEmail(res.user.email || "");
      toast.success("Profile updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setProfileBusy(false);
    }
  }

  async function savePassword() {
    if (newPw.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPw !== newPw2) {
      toast.error("New passwords do not match");
      return;
    }
    setPwBusy(true);
    try {
      await api.changePassword({ currentPassword: curPw, newPassword: newPw });
      setCurPw("");
      setNewPw("");
      setNewPw2("");
      toast.success("Password updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPwBusy(false);
    }
  }

  function saveFlags() {
    localStorage.setItem("cs-feature-flags", JSON.stringify(flags));
    toast.success("Local UI preferences saved (browser only)");
  }

  return (
    <div>
      <PageHero
        kicker="You"
        title="Account"
        subtitle="Your profile, password, theme, and browser-only preferences — not org or install settings."
        actions={
          <Link to="/settings" className="ghost sm" style={{ textDecoration: "none" }}>
            All settings
          </Link>
        }
      />

      <div className="grid cols-2">
        <div className="card stack">
          <h3>Profile</h3>
          {!user || user.id === "api_key" ? (
            <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
              Sign in with email/password or OIDC to edit your account. API-key-only access has no
              personal profile.
            </p>
          ) : (
            <>
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="running">{user.role}</Badge>
                {user.platformAdmin && <Badge tone="warn">platform operator</Badge>}
              </div>
              <div className="field">
                <label>Display name</label>
                <input
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
              <div className="field">
                <label>Email</label>
                <input
                  type="email"
                  value={profileEmail}
                  onChange={(e) => setProfileEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <button
                type="button"
                className="primary sm"
                disabled={profileBusy}
                onClick={() => void saveProfile()}
              >
                {profileBusy ? "Saving…" : "Save profile"}
              </button>
            </>
          )}
        </div>

        <div className="card stack">
          <h3>Password</h3>
          {!user || user.id === "api_key" ? (
            <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
              Sign in with a user account to change your password.
            </p>
          ) : (
            <>
              <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.45 }}>
                Password and email are stored in the platform identity directory (Keycloak). Changes
                here update the credentials you use on Sign in.
              </p>
              <div className="field">
                <label>Current password</label>
                <input
                  type="password"
                  value={curPw}
                  onChange={(e) => setCurPw(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="field">
                <label>New password</label>
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="field">
                <label>Confirm new password</label>
                <input
                  type="password"
                  value={newPw2}
                  onChange={(e) => setNewPw2(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <button
                type="button"
                className="sm"
                disabled={pwBusy || !curPw || !newPw}
                onClick={() => void savePassword()}
              >
                {pwBusy ? "Updating…" : "Update password"}
              </button>
            </>
          )}
        </div>

        <div className="card stack">
          <h3>Appearance</h3>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
            Light, dark, or system. Saved in this browser only.
          </p>
          <AppearancePicker />
        </div>

        <div className="card stack">
          <h3>Browser preferences</h3>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
            Local reminders only — they do <strong>not</strong> change the API or worker.
            {isPlatformOperator(user, authMode) ? (
              <>
                {" "}
                Use <Link to="/settings/platform">Platform</Link> for real runtime knobs.
              </>
            ) : null}
          </p>
          {(
            [
              ["graphMock", "Remember graph mock preference"],
              ["deepAgents", "Remember DeepAgents preference"],
              ["crossRepo", "Remember cross-repo preference"],
              ["prove", "Remember prove preference"],
              ["webhooks", "Remember webhooks preference"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="row" style={{ cursor: "pointer", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={flags[key]}
                onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
          <button type="button" className="ghost sm" onClick={saveFlags}>
            Save browser preferences
          </button>
        </div>
      </div>
    </div>
  );
}
