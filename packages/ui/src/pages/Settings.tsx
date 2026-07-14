import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHero } from "../components/ui";
import { api, type AuthUser } from "../lib/api";

/**
 * Settings hub — splits user / org / platform surfaces for clearer UX + RBAC.
 */
export function Settings() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<string | undefined>();

  useEffect(() => {
    api
      .authMe()
      .then((r) => {
        setUser(r.user);
        setAuthMode(r.authMode);
      })
      .catch(() => setUser(null));
  }, []);

  const platformOk =
    authMode === "api_key" ||
    authMode === "dev_open" ||
    Boolean(user?.platformAdmin) ||
    user?.id === "api_key" ||
    user?.id === "dev";

  const cards = [
    {
      to: "/settings/account",
      kicker: "You",
      title: "Account",
      body: "Profile, password, theme, and browser-only preferences.",
      audience: "Everyone signed in",
    },
    {
      to: "/settings/organization",
      kicker: "Tenant",
      title: "Organization",
      body: "Rename org, members, models, Langfuse, connectors, prompts, SCIM, and audit.",
      audience: "Org admins manage; members can view links",
    },
    {
      to: "/settings/platform",
      kicker: "Install",
      title: "Platform",
      body: "License, runtime knobs, health, and graph tools for the whole install.",
      audience: platformOk
        ? "You have platform operator access"
        : "Platform operators only (not tenant admin)",
      locked: !platformOk,
    },
  ] as const;

  return (
    <div>
      <PageHero
        kicker="Control plane"
        title="Settings"
        subtitle="Separated by scope: your account, this organization (tenant), and the install (platform)."
      />

      <div className="grid cols-3" style={{ gap: "1rem" }}>
        {cards.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="card stack"
            style={{
              textDecoration: "none",
              color: "inherit",
              opacity: "locked" in c && c.locked ? 0.75 : 1,
              borderColor:
                "locked" in c && c.locked
                  ? "var(--border)"
                  : "rgba(124, 92, 252, 0.25)",
            }}
          >
            <div className="muted" style={{ fontSize: "0.72rem", letterSpacing: "0.06em" }}>
              {c.kicker.toUpperCase()}
            </div>
            <h3 style={{ margin: 0 }}>{c.title}</h3>
            <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.5, margin: 0 }}>
              {c.body}
            </p>
            <p style={{ fontSize: "0.78rem", margin: 0, color: "var(--text-faint)" }}>
              {c.audience}
            </p>
          </Link>
        ))}
      </div>

      <p className="muted" style={{ marginTop: "1.25rem", fontSize: "0.85rem", lineHeight: 1.5 }}>
        <strong>RBAC:</strong> Org admin ≠ platform operator. Tenant admins configure members and
        models for their org. Platform operators install licenses and change install-wide runtime
        config (<span className="mono">users.platform_admin</span> or{" "}
        <span className="mono">STEW_PLATFORM_ADMIN_EMAILS</span>).
      </p>
    </div>
  );
}
