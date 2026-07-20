import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, KpiCard, PageHero } from "../components/ui";
import { api, type AddressRateAnalytics, type Finding, type Session } from "../lib/api";

const SEV_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#38bdf8",
  info: "#94a3b8",
  nit: "#64748b",
};

/** false_positive → False positive; open → Open */
function humanizeStatusLabel(status: string): string {
  const known: Record<string, string> = {
    open: "Open",
    fixed: "Fixed",
    dismissed: "Dismissed",
    false_positive: "False positive",
    wontfix: "Won't fix",
    wont_fix: "Won't fix",
    auto_fixed: "Auto-fixed",
  };
  if (known[status]) return known[status];
  return status
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function sessionTokenTotal(s: Session): number {
  const u = s.tokenUsage;
  if (!u) return 0;
  if (typeof u.totalTokens === "number" && u.totalTokens > 0) return u.totalTokens;
  return (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
}

function sessionCostUsd(s: Session): number {
  const c = s.tokenUsage?.costUsd;
  return typeof c === "number" && Number.isFinite(c) ? c : 0;
}

export function Analytics() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [address, setAddress] = useState<AddressRateAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.sessions(),
      api.findings(),
      api.addressRate().catch(() => null),
    ])
      .then(([s, f, a]) => {
        setSessions(s.sessions);
        setFindings(f.findings);
        setAddress(a);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const metrics = useMemo(() => {
    const completed = sessions.filter((s) => s.status === "completed").length;
    const failed = sessions.filter((s) => s.status === "failed").length;
    const bySev: Record<string, number> = {};
    for (const f of findings) {
      bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
    }
    const byMode: Record<string, number> = {};
    for (const s of sessions) {
      byMode[s.mode] = (byMode[s.mode] ?? 0) + 1;
    }
    const byStatus: Record<string, number> = {};
    for (const f of findings) {
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }

    let totalTokens = 0;
    let totalCost = 0;
    let sessionsWithTokens = 0;
    let sessionsWithCost = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let costEstimated = false;
    for (const s of sessions) {
      const t = sessionTokenTotal(s);
      if (t > 0) {
        totalTokens += t;
        sessionsWithTokens += 1;
        promptTokens += s.tokenUsage?.promptTokens ?? 0;
        completionTokens += s.tokenUsage?.completionTokens ?? 0;
      }
      const c = sessionCostUsd(s);
      if (c > 0) {
        totalCost += c;
        sessionsWithCost += 1;
      }
      if (s.tokenUsage?.costEstimated !== false && c > 0) costEstimated = true;
    }
    const avgTokens =
      sessionsWithTokens > 0 ? totalTokens / sessionsWithTokens : 0;
    const avgCost = sessionsWithCost > 0 ? totalCost / sessionsWithCost : 0;

    return {
      completed,
      failed,
      bySev,
      byMode,
      byStatus,
      totalTokens,
      avgTokens,
      totalCost,
      avgCost,
      sessionsWithTokens,
      sessionsWithCost,
      promptTokens,
      completionTokens,
      costEstimated,
    };
  }, [sessions, findings]);

  const sevEntries = Object.entries(metrics.bySev);
  const maxSev = Math.max(1, ...sevEntries.map(([, n]) => n));
  const totalSev = sevEntries.reduce((a, [, n]) => a + n, 0) || 1;

  let cursor = 0;
  const conicParts = sevEntries.map(([sev, n]) => {
    const start = cursor;
    const pct = (n / totalSev) * 100;
    cursor += pct;
    return `${SEV_COLORS[sev] ?? "#64748b"} ${start}% ${cursor}%`;
  });
  const donutBg =
    sevEntries.length > 0
      ? `conic-gradient(${conicParts.join(", ")})`
      : "conic-gradient(var(--border-strong) 0% 100%)";

  // Real week buckets from API only — never fake illustrative series
  const weekBuckets = address?.weekBuckets ?? [0, 0, 0, 0, 0, 0, 0];
  const isEmpty = address?.empty ?? weekBuckets.every((b) => b === 0);
  const maxWeek = Math.max(1, ...weekBuckets);
  const addressRateLabel =
    address?.addressRate === null || address?.addressRate === undefined
      ? "—"
      : `${address.addressRate}%`;

  return (
    <div>
      <PageHero
        kicker="Insights"
        title="Analytics"
        subtitle="Address rate, severity mix, tokens, estimated cost, and session outcomes — pure CSS charts."
      />

      <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
        <KpiCard
          label="Address rate"
          value={addressRateLabel}
          meta={
            address
              ? `${address.addressed} / ${address.considered} considered`
              : "from /v1/analytics/address-rate"
          }
          loading={loading}
        />
        <KpiCard
          label="Findings"
          value={address?.considered ?? findings.length}
          meta={`${address?.open ?? "—"} open`}
          loading={loading}
        />
        <KpiCard
          label="Sessions completed"
          value={address?.completedSessions ?? metrics.completed}
          meta={`${metrics.failed} failed`}
          loading={loading}
        />
        <KpiCard
          label="Gate vs steward"
          value={`${metrics.byMode.gate ?? 0}/${metrics.byMode.stewardship ?? 0}`}
          meta="gate / stewardship"
          loading={loading}
        />
      </div>

      <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
        <KpiCard
          label="Tokens used"
          value={formatTokens(metrics.totalTokens)}
          meta={
            metrics.sessionsWithTokens
              ? `${metrics.promptTokens.toLocaleString()} in · ${metrics.completionTokens.toLocaleString()} out · ${metrics.sessionsWithTokens} session(s)`
              : "from session tokenUsage"
          }
          loading={loading}
        />
        <KpiCard
          label="Avg tokens / session"
          value={
            metrics.sessionsWithTokens > 0
              ? formatTokens(metrics.avgTokens)
              : "—"
          }
          meta={
            metrics.sessionsWithTokens
              ? `across ${metrics.sessionsWithTokens} session(s) with usage`
              : "no token usage recorded yet"
          }
          loading={loading}
        />
        <KpiCard
          label="Est. cost (total)"
          value={metrics.totalCost > 0 ? formatUsd(metrics.totalCost) : "—"}
          meta={
            metrics.totalCost > 0
              ? metrics.costEstimated
                ? "list-price estimate · not an invoice"
                : "from session costUsd"
              : "costs appear after reviews with priced models"
          }
          loading={loading}
        />
        <KpiCard
          label="Avg cost / session"
          value={
            metrics.sessionsWithCost > 0 ? formatUsd(metrics.avgCost) : "—"
          }
          meta={
            metrics.sessionsWithCost
              ? `across ${metrics.sessionsWithCost} session(s) with cost`
              : "no cost data yet"
          }
          loading={loading}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-header">
            <h3>Address rate trend</h3>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              last 7 days · real data only
            </span>
          </div>
          {loading ? (
            <div className="skeleton block" style={{ height: 140 }} />
          ) : isEmpty ? (
            <EmptyState
              title="No address-rate data yet"
              description="Run a review and react on findings — week buckets stay empty until real activity lands. We never invent demo bars."
              icon="▦"
              action={
                <Link to="/sessions?mode=gate">
                  <button type="button" className="primary sm">
                    Run first review
                  </button>
                </Link>
              }
            />
          ) : (
            <div className="bar-chart">
              {weekBuckets.map((v, i) => (
                <div key={i} className="bar-col">
                  <div className="bar-value">{v}</div>
                  <div className="bar" style={{ height: `${Math.max(6, (v / maxWeek) * 100)}%` }} />
                  <div className="bar-label">D{i + 1}</div>
                </div>
              ))}
            </div>
          )}
          {address?.definition && !isEmpty && (
            <p className="muted" style={{ margin: "0.75rem 0 0", fontSize: "0.72rem" }}>
              {address.definition}
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Severity distribution</h3>
          </div>
          {loading ? (
            <div className="skeleton block" style={{ height: 140 }} />
          ) : sevEntries.length === 0 ? (
            <EmptyState title="No findings yet" description="Severity mix appears after reviews produce issues." icon="▦" />
          ) : (
            <div className="donut-wrap">
              <div className="donut" style={{ background: donutBg }}>
                <div className="donut-hole">
                  <strong>{findings.length}</strong>
                  <span>total</span>
                </div>
              </div>
              <div className="legend">
                {sevEntries.map(([sev, n]) => (
                  <div key={sev} className="legend-row">
                    <span className="legend-swatch" style={{ background: SEV_COLORS[sev] ?? "#64748b" }} />
                    <span style={{ textTransform: "capitalize", minWidth: 64 }}>{sev}</span>
                    <span className="mono">{n}</span>
                    <span className="faint">{Math.round((n / totalSev) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Severity bars</h3>
          {sevEntries.length === 0 ? (
            <EmptyState
              title="No severity data"
              description="Bars stay empty until real findings exist — no placeholder heights."
              icon="▦"
            />
          ) : (
          <div className="bar-chart" style={{ height: 120 }}>
            {(["critical", "high", "medium", "low", "info", "nit"] as const).map((sev) => {
              const n = metrics.bySev[sev] ?? 0;
              return (
                <div key={sev} className="bar-col">
                  <div className="bar-value">{n || ""}</div>
                  <div
                    className="bar"
                    style={{
                      height: n === 0 ? "0%" : `${Math.max(6, (n / maxSev) * 100)}%`,
                      background: SEV_COLORS[sev],
                      boxShadow: n ? `0 0 12px ${SEV_COLORS[sev]}44` : "none",
                      opacity: n ? 1 : 0.15,
                    }}
                  />
                  <div className="bar-label">{sev.slice(0, 4)}</div>
                </div>
              );
            })}
          </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Finding status mix</h3>
          {Object.keys(metrics.byStatus).length === 0 ? (
            <p className="muted">No status data yet.</p>
          ) : (
            <div className="stack">
              {Object.entries(metrics.byStatus).map(([st, n]) => (
                <div key={st}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: "0.85rem" }}>{humanizeStatusLabel(st)}</span>
                    <span className="mono muted">{n}</span>
                  </div>
                  <div className="progress-bar">
                    <span
                      style={{
                        width: `${Math.round((n / Math.max(findings.length, 1)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
