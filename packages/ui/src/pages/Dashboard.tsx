import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, EmptyState, KpiCard, PageHero, formatRelative, shortId } from "../components/ui";
import { api, type AddressRateAnalytics, type Finding, type Session } from "../lib/api";

export function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [address, setAddress] = useState<AddressRateAnalytics | null>(null);
  const [health, setHealth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([
        api.sessions(),
        api.findings(),
        api.health(),
        api.addressRate().catch(() => null),
      ])
        .then(([s, f, h, a]) => {
          if (!alive) return;
          setSessions(s.sessions);
          setFindings(f.findings);
          setHealth(h.ok);
          setAddress(a);
          setErr(null);
        })
        .catch((e: Error) => {
          if (!alive) return;
          setErr(e.message);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });

    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const stats = useMemo(() => {
    const open = findings.filter((f) => f.status === "open").length;
    const fixed = findings.filter((f) => f.status === "fixed").length;
    const highPlus = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
    const running = sessions.filter((s) => s.status === "running").length;
    const agents = new Set(findings.flatMap((f) => f.agents ?? [])).size;
    const addressRate =
      address?.addressRate === null || address?.addressRate === undefined
        ? null
        : address.addressRate;
    return { open, fixed, highPlus, running, agents, addressRate };
  }, [sessions, findings, address]);

  const activity = useMemo(() => {
    const items: { id: string; icon: string; title: string; meta: string; ts: string }[] = [];
    for (const s of sessions.slice(0, 12)) {
      items.push({
        id: `s-${s.id}`,
        icon: s.mode === "gate" ? "◎" : "↻",
        title: `${s.mode} session ${shortId(s.id, 10)} · ${s.status}`,
        meta: `${s.repoId} · stage ${s.stage}`,
        ts: s.updatedAt ?? s.createdAt,
      });
    }
    for (const f of findings.slice(0, 8)) {
      items.push({
        id: `f-${f.id}`,
        icon: "⚑",
        title: f.title,
        meta: `${f.severity} · ${f.path}${f.startLine ? `:${f.startLine}` : ""}`,
        ts: f.updatedAt ?? f.createdAt ?? "",
      });
    }
    return items
      .filter((i) => i.ts)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, 10);
  }, [sessions, findings]);

  return (
    <div>
      <PageHero
        kicker="Code governance"
        title="Govern every merge. Steward every branch."
        subtitle="Dual-mode review control plane — PR gates for merges, continuous stewardship for long-lived branches. Deterministic graphs. Self-hosted."
        hero
        actions={
          <>
            <Link to="/sessions?mode=gate">
              <button type="button" className="primary">
                Gate a PR
              </button>
            </Link>
            <Link to="/sessions?mode=steward">
              <button type="button" className="primary">
                Steward a branch
              </button>
            </Link>
          </>
        }
      />

      {err && (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "rgba(248,113,113,0.3)" }}>
          <span className="badge failed">API offline</span>
          <span className="muted" style={{ marginLeft: 8, fontSize: "0.85rem" }}>
            {err} — start with <span className="mono">GRAPH_MOCK=1 pnpm dev:api</span>
          </span>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: "1rem" }}>
        <KpiCard
          label="Sessions"
          value={sessions.length}
          meta={`${stats.running} running`}
          loading={loading}
        />
        <KpiCard
          label="Open findings"
          value={stats.open}
          meta={`${stats.highPlus} high+`}
          loading={loading}
        />
        <KpiCard
          label="Address rate"
          value={stats.addressRate === null ? "—" : `${stats.addressRate}%`}
          meta={
            address
              ? `${address.addressed} / ${address.considered} considered`
              : "from analytics API"
          }
          loading={loading}
        />
        <KpiCard
          label="Active agents"
          value={stats.agents || (stats.running ? "…" : 0)}
          meta={health ? "API healthy" : "API unknown"}
          loading={loading}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-header">
            <h3>Recent sessions</h3>
            <Link to="/sessions" className="muted" style={{ fontSize: "0.8rem" }}>
              View all →
            </Link>
          </div>
          {loading ? (
            <div className="skeleton block" style={{ height: 160 }} />
          ) : sessions.length === 0 ? (
            <EmptyState
              title="No sessions yet"
              description="Start a gate review or stewardship run — dual primary paths from the hero."
              action={
                <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                  <Link to="/sessions?mode=gate">
                    <button type="button" className="primary sm">
                      Gate a PR
                    </button>
                  </Link>
                  <Link to="/sessions?mode=steward">
                    <button type="button" className="primary sm">
                      Steward a branch
                    </button>
                  </Link>
                </div>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Mode</th>
                    <th>Repo</th>
                    <th>Status</th>
                    <th>Stage</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.slice(0, 8).map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{shortId(s.id, 14)}</td>
                      <td>
                        <Badge tone={s.mode}>{s.mode}</Badge>
                      </td>
                      <td>{s.repoId}</td>
                      <td>
                        <Badge tone={s.status}>{s.status}</Badge>
                      </td>
                      <td className="muted">{s.stage}</td>
                      <td className="muted">{formatRelative(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Live activity</h3>
            <span className="badge running">live</span>
          </div>
          {loading ? (
            <div className="skeleton block" style={{ height: 160 }} />
          ) : activity.length === 0 ? (
            <EmptyState title="Quiet for now" description="Session and finding events will stream here." icon="·" />
          ) : (
            <div>
              {activity.map((a) => (
                <div key={a.id} className="activity-item">
                  <div className="activity-icon">{a.icon}</div>
                  <div className="activity-body">
                    <strong>{a.title}</strong>
                    <div className="activity-meta">
                      {a.meta} · {formatRelative(a.ts)}
                    </div>
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
