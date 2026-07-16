import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHero } from "../components/ui";
import { api, isPlatformOperator, type AuthUser } from "../lib/api";

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

  const platformOk = isPlatformOperator(user, authMode);

  const cards: Array<{
    to: string;
    kicker: string;
    title: string;
    body: string;
    audience: string;
  }> = [
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
      body:
        "Rename org, members, models, suggested code fixes (when platform allows), Langfuse, SCIM, and audit.",
      audience: "Org admins manage; members can view links",
    },
  ];
  if (platformOk) {
    cards.push({
      to: "/settings/platform",
      kicker: "Install",
      title: "Platform",
      body: "License, install-wide runtime (clone, DeepAgents, graph, workers), GitHub App enforce, and health.",
      audience: "Platform operator",
    });
  }

  return (
    <div>
      <PageHero
        kicker="Control plane"
        title="Settings"
        subtitle={
          platformOk
            ? "Separated by scope: your account, this organization (tenant), and the install (platform)."
            : "Your account and this organization. Install-wide platform tools are only shown to operators."
        }
      />

      <div
        className={`grid cols-${Math.min(3, cards.length)}`}
        style={{ gap: "1rem" }}
      >
        {cards.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="card stack"
            style={{
              textDecoration: "none",
              color: "inherit",
              borderColor: "rgba(124, 92, 252, 0.25)",
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
    </div>
  );
}
