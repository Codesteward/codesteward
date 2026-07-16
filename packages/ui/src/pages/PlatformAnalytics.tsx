import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Select } from "../components/Select";
import { EmptyState, KpiCard, PageHero, Badge } from "../components/ui";
import { api, isPlatformOperator, type PlatformAnalytics } from "../lib/api";

const WINDOW_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function PlatformAnalyticsPage() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<PlatformAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const me = await api.authMe();
        if (!alive) return;
        const ok = isPlatformOperator(me.user, me.authMode);
        setAllowed(ok);
        if (!ok) {
          setLoading(false);
          return;
        }
        const a = await api.platformAnalytics(days);
        if (!alive) return;
        setData(a);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [days]);

  if (!allowed && !loading) {
    return (
      <div>
        <PageHero
          kicker="Install"
          title="Platform ops"
          subtitle="Install-wide performance metrics for operators."
        />
        <div className="banner warn" role="alert">
          Platform operator access required. Tenant admins use{" "}
          <Link to="/analytics">org Analytics</Link> instead.
        </div>
      </div>
    );
  }

  const s = data?.sessions;
  const lat = data?.latency;
  const sp = data?.specialists;
  const w = data?.workers;
  const tok = data?.tokens;

  return (
    <div>
      <PageHero
        kicker="Install · operators"
        title="Platform ops"
        subtitle="Sessions, specialist latency, worker queue depth, and tokens across all orgs — for SRE and platform owners, not end-user product analytics."
      />

      <div className="row" style={{ gap: 12, marginBottom: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        <label className="muted" style={{ fontSize: "0.85rem", display: "flex", alignItems: "center", gap: 8 }}>
          Window
          <Select
            aria-label="Analytics time window"
            size="sm"
            fullWidth={false}
            value={String(days)}
            options={WINDOW_OPTIONS}
            onChange={(v) => {
              setLoading(true);
              setDays(Number(v));
            }}
            style={{ minWidth: 120 }}
          />
        </label>
        {data && (
          <span className="muted mono" style={{ fontSize: "0.75rem" }}>
            Generated {new Date(data.generatedAt).toLocaleString()}
          </span>
        )}
        <Link to="/settings/platform" className="muted" style={{ fontSize: "0.85rem" }}>
          Platform settings →
        </Link>
      </div>

      {error && (
        <div className="banner warn" role="alert" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
        <KpiCard
          label="Sessions"
          value={s?.total ?? "—"}
          meta={`${s?.completed ?? 0} ok · ${s?.failed ?? 0} failed · ${s?.running ?? 0} live`}
          loading={loading}
        />
        <KpiCard
          label="Success rate"
          value={s?.successRate != null ? `${s.successRate}%` : "—"}
          meta="completed (+ half credit completed_with_errors)"
          loading={loading}
        />
        <KpiCard
          label="p50 / p95 latency"
          value={`${fmtMs(lat?.p50Ms)} / ${fmtMs(lat?.p95Ms)}`}
          meta={`avg ${fmtMs(lat?.avgMs)} · n=${lat?.sampleSize ?? 0}`}
          loading={loading}
        />
        <KpiCard
          label="Jobs queue"
          value={`${w?.jobsPending ?? 0} / ${w?.jobsRunning ?? 0}`}
          meta={`pending / running · ${w?.distinctWorkers ?? 0} worker(s) · ${w?.jobsDead ?? 0} dead`}
          loading={loading}
        />
      </div>

      <div className="grid cols-2" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <div className="card-header">
            <strong>Stage latency (avg)</strong>
            <span className="muted">from session.audit.timings</span>
          </div>
          {!lat?.longestStages?.length ? (
            <EmptyState
              title="No stage timings yet"
              description="Complete reviews on a worker with the timing ledger to populate this chart."
            />
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {lat.longestStages.map((row) => {
                const max = lat.longestStages[0]?.avgMs || 1;
                const pct = Math.min(100, (row.avgMs / max) * 100);
                return (
                  <div key={row.stage}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="mono">{row.stage}</span>
                      <span className="muted">
                        {fmtMs(row.avgMs)} · n={row.samples}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 4,
                        background: "var(--border)",
                        overflow: "hidden",
                        marginTop: 4,
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: "var(--accent, #38bdf8)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <strong>Specialists by role</strong>
            <span className="muted">{sp?.runs ?? 0} runs</span>
          </div>
          {!sp?.byRole?.length ? (
            <EmptyState
              title="No specialist runs"
              description="Audit specialistRuns[] drive this table."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Runs</th>
                    <th>Avg</th>
                    <th>Max</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {sp.byRole.map((r) => (
                    <tr key={r.role}>
                      <td className="mono">{r.role}</td>
                      <td>{r.runs}</td>
                      <td>{fmtMs(r.avgMs)}</td>
                      <td>{fmtMs(r.maxMs)}</td>
                      <td>{r.errorRate != null ? `${r.errorRate}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <div className="card-header">
            <strong>Workers</strong>
          </div>
          <div className="stack" style={{ gap: 6, fontSize: "0.9rem" }}>
            <div>
              Mode:{" "}
              <Badge tone="info">{w?.inlineWorker?.mode ?? "—"}</Badge>
              {w?.inlineWorker?.hint ? (
                <span className="muted" style={{ marginLeft: 8, fontSize: "0.8rem" }}>
                  {w.inlineWorker.hint}
                </span>
              ) : null}
            </div>
            <div className="muted">
              Pending <strong>{w?.jobsPending ?? 0}</strong> · Running{" "}
              <strong>{w?.jobsRunning ?? 0}</strong> · Dead <strong>{w?.jobsDead ?? 0}</strong>
            </div>
            {w?.workerIds?.length ? (
              <div className="mono" style={{ fontSize: "0.75rem" }}>
                Active locks: {w.workerIds.join(", ")}
              </div>
            ) : (
              <div className="muted">No active job locks in sample</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <strong>Tokens / cost</strong>
          </div>
          <div className="stack" style={{ gap: 6, fontSize: "0.9rem" }}>
            <div>
              Total tokens: <strong className="mono">{tok?.total?.toLocaleString() ?? "—"}</strong>
            </div>
            <div className="muted">
              Prompt {tok?.totalPrompt?.toLocaleString() ?? 0} · Completion{" "}
              {tok?.totalCompletion?.toLocaleString() ?? 0}
            </div>
            <div>
              Est. cost:{" "}
              <strong>
                {tok?.estimatedCostUsd != null ? `$${tok.estimatedCostUsd.toFixed(4)}` : "—"}
              </strong>
              <span className="muted"> (list-price estimate)</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <strong>Slowest sessions</strong>
          <span className="muted">last {days}d</span>
        </div>
        {!data?.recentSlow?.length ? (
          <EmptyState
            title="No completed timings"
            description="Wall-clock from timings or createdAt→completedAt."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Repo</th>
                  <th>Mode</th>
                  <th>Duration</th>
                  <th>Bottleneck</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSlow.map((row) => (
                  <tr key={row.sessionId}>
                    <td>
                      <Link
                        className="mono"
                        to={`/sessions?sessionId=${encodeURIComponent(row.sessionId)}`}
                      >
                        {row.sessionId.slice(0, 18)}…
                      </Link>
                    </td>
                    <td className="muted">{row.repoId}</td>
                    <td>
                      <Badge tone={row.mode}>{row.mode}</Badge>
                    </td>
                    <td className="mono">{fmtMs(row.totalDurationMs)}</td>
                    <td className="mono muted">{row.longestStage ?? "—"}</td>
                    <td>
                      <Badge tone={row.status}>{row.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
