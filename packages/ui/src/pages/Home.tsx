import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  GitBranch,
  GitPullRequest,
  Network,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { ThemeToggle } from "../components/Layout";
import { Logo } from "../components/Logo";
import { api, getSessionToken } from "../lib/api";

const FEATURES = [
  {
    icon: GitPullRequest,
    title: "PR gate",
    body: "Block risky merges with graph-backed findings, policy checks, and a clear pass/fail signal on every PR.",
  },
  {
    icon: GitBranch,
    title: "Branch stewardship",
    body: "Continuous review on long-lived branches — drift, debt, and regressions before they become incidents.",
  },
  {
    icon: Network,
    title: "Graph-aware agents",
    body: "Specialists follow call chains, auth guards, and dependencies — not a blind line-by-line diff.",
  },
  {
    icon: Sparkles,
    title: "Learning loop",
    body: "👍 / 👎 reactions and org memory quiet noise so teams keep high-signal findings over time.",
  },
] as const;

const STEPS = [
  { n: "01", title: "Connect", body: "Link GitHub, GitLab, or your SCM. Install once; review every repo you choose." },
  { n: "02", title: "Review", body: "Gate PRs and steward branches with multi-agent depth and structural context." },
  { n: "03", title: "Govern", body: "Policy, models, and learning stay under your control — self-hosted, multi-tenant ready." },
] as const;

const STATS = [
  { value: "Dual mode", label: "Gate + stewardship" },
  { value: "Graph-first", label: "Call chains & deps" },
  { value: "Self-hosted", label: "Your cloud, your keys" },
  { value: "IdP-ready", label: "OIDC · MFA · SCIM" },
] as const;

/**
 * Public landing page — no auth required.
 * Authenticated visitors are sent to the app dashboard.
 */
export function Home() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const token = getSessionToken() || localStorage.getItem("cs-api-key");
      if (!token) {
        if (alive) setChecking(false);
        return;
      }
      try {
        const me = await api.authMe();
        if (!alive) return;
        if (me.user) {
          navigate("/dashboard", { replace: true });
          return;
        }
      } catch {
        /* stay on public home */
      }
      if (alive) setChecking(false);
    })();
    return () => {
      alive = false;
    };
  }, [navigate]);

  if (checking) {
    return (
      <div className="home-shell">
        <div className="home-checking muted">Loading…</div>
      </div>
    );
  }

  return (
    <div className="home-shell">
      <div className="home-bg" aria-hidden>
        <div className="home-bg-orb home-bg-orb-a" />
        <div className="home-bg-orb home-bg-orb-b" />
        <div className="home-bg-orb home-bg-orb-c" />
        <div className="home-bg-grid" />
      </div>

      <header className="home-top">
        <div className="home-top-brand">
          <Logo variant="icon" size={34} />
          <span className="home-top-name">Codesteward</span>
        </div>
        <nav className="home-top-nav" aria-label="Page">
          <a href="#capabilities">Capabilities</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="home-top-actions">
          <ThemeToggle compact />
          <Link className="primary home-cta-sm" to="/login?returnTo=%2Fdashboard">
            Sign in
          </Link>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero-grid">
          <div className="home-hero">
            <p className="home-kicker mono">
              <ShieldCheck size={14} strokeWidth={2.2} aria-hidden />
              Self-hosted review platform
            </p>
            <h1 className="home-title">
              Code review agents
              <br />
              <span className="home-title-accent">that understand structure</span>
            </h1>
            <p className="home-lead muted">
              Codesteward runs PR gates and branch stewardship on a structural code graph —
              findings, policy, and learning on infrastructure you control.
            </p>
            <div className="home-hero-actions">
              <Link className="primary home-cta" to="/login?returnTo=%2Fdashboard">
                Sign in to continue
              </Link>
              <a className="home-cta-secondary" href="#capabilities">
                See capabilities
              </a>
            </div>
            <p className="home-hint muted">
              Sign-in uses your platform identity provider. MFA and federated SSO are configured there — not in this app.
            </p>
          </div>

          <div className="home-preview" aria-hidden>
            <div className="home-preview-chrome">
              <span className="home-preview-dot" />
              <span className="home-preview-dot" />
              <span className="home-preview-dot" />
              <span className="home-preview-path mono">session · gate · pr-1842</span>
            </div>
            <div className="home-preview-body">
              <div className="home-preview-side">
                <div className="home-preview-nav-item active">
                  <Activity size={14} /> Gate
                </div>
                <div className="home-preview-nav-item">
                  <Workflow size={14} /> Steward
                </div>
                <div className="home-preview-nav-item">
                  <Network size={14} /> Graph
                </div>
              </div>
              <div className="home-preview-main">
                <div className="home-preview-kpi-row">
                  <div className="home-preview-kpi">
                    <span className="muted">Findings</span>
                    <strong>12</strong>
                  </div>
                  <div className="home-preview-kpi">
                    <span className="muted">Critical</span>
                    <strong className="home-kpi-crit">2</strong>
                  </div>
                  <div className="home-preview-kpi">
                    <span className="muted">Verdict</span>
                    <strong className="home-kpi-warn">Review</strong>
                  </div>
                </div>
                <div className="home-preview-findings">
                  <div className="home-preview-finding high">
                    <span className="home-sev">HIGH</span>
                    <span>Auth bypass on admin route via shared middleware skip</span>
                  </div>
                  <div className="home-preview-finding crit">
                    <span className="home-sev">CRIT</span>
                    <span>Unsanitized input reaches SQL builder in order service</span>
                  </div>
                  <div className="home-preview-finding med">
                    <span className="home-sev">MED</span>
                    <span>Missing rate limit on public webhook endpoint</span>
                  </div>
                </div>
                <div className="home-preview-graph">
                  <svg viewBox="0 0 280 90" className="home-graph-svg">
                    <defs>
                      <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#7c5cfc" />
                        <stop offset="100%" stopColor="#22d3ee" />
                      </linearGradient>
                    </defs>
                    <line x1="40" y1="45" x2="100" y2="25" stroke="url(#hg)" strokeWidth="1.5" opacity="0.7" />
                    <line x1="40" y1="45" x2="100" y2="65" stroke="url(#hg)" strokeWidth="1.5" opacity="0.5" />
                    <line x1="100" y1="25" x2="170" y2="35" stroke="url(#hg)" strokeWidth="1.5" opacity="0.75" />
                    <line x1="100" y1="65" x2="170" y2="55" stroke="url(#hg)" strokeWidth="1.5" opacity="0.55" />
                    <line x1="170" y1="35" x2="240" y2="45" stroke="url(#hg)" strokeWidth="1.5" opacity="0.8" />
                    <line x1="170" y1="55" x2="240" y2="45" stroke="url(#hg)" strokeWidth="1.5" opacity="0.6" />
                    <circle cx="40" cy="45" r="8" fill="#12141c" stroke="#7c5cfc" strokeWidth="2" />
                    <circle cx="100" cy="25" r="7" fill="#12141c" stroke="#a78bfa" strokeWidth="2" />
                    <circle cx="100" cy="65" r="7" fill="#12141c" stroke="#6366f1" strokeWidth="2" />
                    <circle cx="170" cy="35" r="7" fill="#12141c" stroke="#22d3ee" strokeWidth="2" />
                    <circle cx="170" cy="55" r="7" fill="#12141c" stroke="#2563eb" strokeWidth="2" />
                    <circle cx="240" cy="45" r="9" fill="#12141c" stroke="#22d3ee" strokeWidth="2.2" />
                  </svg>
                  <span className="mono home-graph-label">taint path · source → sink</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="home-stats" aria-label="Highlights">
          {STATS.map((s) => (
            <div key={s.label} className="home-stat">
              <div className="home-stat-value">{s.value}</div>
              <div className="home-stat-label muted">{s.label}</div>
            </div>
          ))}
        </section>

        <section id="capabilities" className="home-section">
          <div className="home-section-head">
            <h2>Built for serious review programs</h2>
            <p className="muted">
              Not another chat box on a diff — a dual-mode platform with graph intelligence and governance.
            </p>
          </div>
          <div className="home-features">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <article key={f.title} className="home-feature-card">
                  <div className="home-feature-icon">
                    <Icon size={20} strokeWidth={2} aria-hidden />
                  </div>
                  <h3>{f.title}</h3>
                  <p className="muted">{f.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section id="how" className="home-section">
          <div className="home-section-head">
            <h2>How it works</h2>
            <p className="muted">From empty cluster to gated merges in three steps.</p>
          </div>
          <div className="home-steps">
            {STEPS.map((s) => (
              <article key={s.n} className="home-step">
                <span className="home-step-n mono">{s.n}</span>
                <h3>{s.title}</h3>
                <p className="muted">{s.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="home-banner">
          <div className="home-banner-copy">
            <h2>Ready when your IdP is</h2>
            <p className="muted">
              Platform identity, multi-tenant orgs, SCIM, and audit — configured once, used every review.
            </p>
          </div>
          <Link className="primary home-cta" to="/login?returnTo=%2Fdashboard">
            Sign in
          </Link>
        </section>
      </main>

      <footer className="home-footer muted">
        <span>© {new Date().getFullYear()} bitkaio LLC</span>
        <span className="home-footer-sep">·</span>
        <span>Codesteward Review</span>
        <span className="home-footer-sep">·</span>
        <span>All rights reserved</span>
        <span className="home-footer-sep">·</span>
        <a href="https://codesteward.ai" target="_blank" rel="noreferrer">
          codesteward.ai
        </a>
      </footer>
    </div>
  );
}
