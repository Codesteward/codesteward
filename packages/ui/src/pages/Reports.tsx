import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero, formatRelative } from "../components/ui";
import { Select } from "../components/Select";
import {
  api,
  downloadJson,
  type SessionReportIndexItem,
} from "../lib/api";

function normalizeBrand(text: string): string {
  return text.replace(/CodeSteward/g, "Codesteward");
}

export function Reports() {
  const toast = useToast();
  const [reports, setReports] = useState<SessionReportIndexItem[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [repoId, setRepoId] = useState<string>("all");
  const [mode, setMode] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);

  const load = () =>
    api
      .reports({
        repoId: repoId === "all" ? undefined : repoId,
        mode: mode === "all" ? undefined : mode,
        limit: 150,
      })
      .then((r) => {
        setReports(r.reports);
        setRepos(r.repos ?? []);
        if (selectedId && !r.reports.some((x) => x.sessionId === selectedId)) {
          setSelectedId(r.reports[0]?.sessionId ?? null);
        } else if (!selectedId && r.reports[0]) {
          setSelectedId(r.reports[0].sessionId);
        }
      })
      .catch(() => {
        setReports([]);
        setRepos([]);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, mode]);

  const selected = useMemo(
    () => reports.find((r) => r.sessionId === selectedId) ?? null,
    [reports, selectedId],
  );
  const compare = useMemo(
    () => reports.find((r) => r.sessionId === compareId) ?? null,
    [reports, compareId],
  );

  /** Same-repo history for re-run timeline */
  const repoHistory = useMemo(() => {
    if (!selected) return [];
    return reports
      .filter((r) => r.repoId === selected.repoId && (mode === "all" || r.mode === selected.mode))
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(a.completedAt ?? a.createdAt);
        const tb = Date.parse(b.completedAt ?? b.createdAt);
        return ta - tb;
      });
  }, [reports, selected, mode]);

  async function downloadAudit(sessionId: string) {
    try {
      const r = await api.sessionAudit(sessionId);
      if (!r.audit) {
        toast.error(
          r.hint ??
            "No review audit for this session. Open the session and re-run if needed.",
        );
        return;
      }
      downloadJson(`codesteward-audit-${sessionId}.json`, {
        exportedAt: new Date().toISOString(),
        sessionId,
        audit: r.audit,
      });
      toast.success("Audit JSON download started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function downloadMd(r: SessionReportIndexItem) {
    if (!r.markdown) {
      toast.error("No markdown on this report");
      return;
    }
    const blob = new Blob([normalizeBrand(r.markdown)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codesteward-report-${r.sessionId}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Download started");
  }

  return (
    <div>
      <PageHero
        kicker="Artifacts"
        title="Reports"
        subtitle="Human-readable session reports across gate and stewardship — filter by repo and compare re-runs over time."
      />

      <div className="filters" style={{ marginBottom: "1rem", flexWrap: "wrap", gap: 8 }}>
        <label className="row" style={{ gap: 6, fontSize: "0.85rem" }}>
          <span className="muted">Repo</span>
          <Select
            value={repoId}
            onChange={setRepoId}
            size="sm"
            fullWidth={false}
            style={{ minWidth: 220 }}
            aria-label="Filter reports by repository"
            options={[
              { value: "all", label: "All repositories" },
              ...repos.map((r) => ({ value: r, label: r })),
            ]}
          />
        </label>
        <label className="row" style={{ gap: 6, fontSize: "0.85rem" }}>
          <span className="muted">Mode</span>
          <Select
            value={mode}
            onChange={setMode}
            size="sm"
            fullWidth={false}
            aria-label="Filter by mode"
            options={[
              { value: "all", label: "all" },
              { value: "gate", label: "gate" },
              { value: "stewardship", label: "stewardship" },
            ]}
          />
        </label>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {loading ? "Loading…" : `${reports.length} report${reports.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {loading ? (
        <div className="skeleton block" style={{ height: 280 }} />
      ) : reports.length === 0 ? (
        <EmptyState
          title="No session reports yet"
          description="Complete a gate or stewardship review to generate a markdown report. Older sessions without the report feature need a re-run."
          action={
            <Link to="/sessions?mode=steward" className="primary sm">
              Start stewardship
            </Link>
          }
        />
      ) : (
        <div className="grid cols-2" style={{ alignItems: "start", gap: "1rem" }}>
          <div className="card" style={{ margin: 0, padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Repo</th>
                    <th>Mode</th>
                    <th>Verdict</th>
                    <th>Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => {
                    const active = r.sessionId === selectedId;
                    return (
                      <tr
                        key={r.sessionId}
                        onClick={() => setSelectedId(r.sessionId)}
                        style={{
                          cursor: "pointer",
                          background: active ? "var(--bg-elevated, rgba(124,108,240,0.08))" : undefined,
                        }}
                      >
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          {formatRelative(r.completedAt ?? r.createdAt)}
                        </td>
                        <td className="mono" style={{ fontSize: "0.75rem", maxWidth: 160 }}>
                          {r.repoId}
                        </td>
                        <td>
                          <Badge tone={r.mode}>{r.mode}</Badge>
                        </td>
                        <td>
                          {r.verdict ? (
                            <Badge tone={r.verdict}>{r.verdict}</Badge>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="mono">{r.findingCount ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="stack" style={{ gap: "1rem" }}>
            {selected && (
              <>
                <div className="card stack" style={{ margin: 0 }}>
                  <div className="card-header">
                    <h3 className="card-title" style={{ margin: 0 }}>
                      Report detail
                    </h3>
                    <div className="row" style={{ gap: 8 }}>
                      <Link
                        to={`/sessions?sessionId=${encodeURIComponent(selected.sessionId)}&mode=${selected.mode === "stewardship" ? "steward" : "gate"}`}
                        className="ghost sm"
                        state={{ openSessionId: selected.sessionId }}
                      >
                        Open session
                      </Link>
                      <button
                        type="button"
                        className="ghost sm"
                        onClick={() => downloadMd(selected)}
                      >
                        Download .md
                      </button>
                      <button
                        type="button"
                        className="ghost sm"
                        onClick={() => void downloadAudit(selected.sessionId)}
                      >
                        Download audit JSON
                      </button>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap", fontSize: "0.85rem" }}>
                    <span className="mono muted">{selected.sessionId}</span>
                    <Badge tone={selected.mode}>{selected.mode}</Badge>
                    {selected.verdict && <Badge tone={selected.verdict}>{selected.verdict}</Badge>}
                    {selected.llmNarrative && <Badge tone="ok">narrative</Badge>}
                    {selected.codeSource && (
                      <Badge tone={selected.codeSource === "clone" ? "ok" : "nit"}>
                        {String(selected.codeSource)}
                      </Badge>
                    )}
                  </div>
                  {selected.headline && (
                    <p style={{ margin: 0, fontSize: "0.92rem", lineHeight: 1.45 }}>
                      {normalizeBrand(selected.headline)}
                    </p>
                  )}
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    <strong className="mono">{selected.repoId}</strong>
                    {selected.baseBranch || selected.headBranch
                      ? ` · ${selected.baseBranch ?? "?"} → ${selected.headBranch ?? selected.baseBranch ?? "?"}`
                      : null}
                    {selected.prNumber != null ? ` · PR #${selected.prNumber}` : null}
                    {selected.findingCount != null
                      ? ` · ${selected.findingCount} finding(s)`
                      : null}
                  </div>

                  {repoHistory.length > 1 && (
                    <div>
                      <div className="muted" style={{ fontSize: "0.75rem", marginBottom: 6 }}>
                        Re-runs for this repo ({repoHistory.length}) — click to open; use Compare to
                        stack two reports
                      </div>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {repoHistory.map((h, i) => (
                          <button
                            key={h.sessionId}
                            type="button"
                            className={`chip${h.sessionId === selectedId ? " active" : ""}`}
                            onClick={() => setSelectedId(h.sessionId)}
                            title={h.headline ?? h.sessionId}
                          >
                            #{i + 1}{" "}
                            {h.verdict ?? "—"} · {h.findingCount ?? "?"}f ·{" "}
                            {formatRelative(h.completedAt ?? h.createdAt)}
                          </button>
                        ))}
                      </div>
                      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <label className="muted" style={{ fontSize: "0.8rem" }}>
                          Compare with
                          <Select
                            value={compareId ?? ""}
                            onChange={(v) => setCompareId(v || null)}
                            size="sm"
                            fullWidth={false}
                            style={{ marginLeft: 6, minWidth: 180 }}
                            aria-label="Compare with report"
                            options={[
                              { value: "", label: "— none —" },
                              ...repoHistory
                                .filter((h) => h.sessionId !== selectedId)
                                .map((h) => ({
                                  value: h.sessionId,
                                  label: `${formatRelative(h.completedAt ?? h.createdAt)} · ${h.verdict ?? "?"} · ${h.findingCount ?? "?"} findings`,
                                })),
                            ]}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                {compare && selected && (
                  <div className="card" style={{ margin: 0 }}>
                    <h4 style={{ margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
                      Re-run delta (summary)
                    </h4>
                    <div className="grid cols-2" style={{ gap: "0.75rem", fontSize: "0.85rem" }}>
                      <div>
                        <div className="muted" style={{ fontSize: "0.72rem" }}>
                          Selected
                        </div>
                        <div>
                          Verdict <Badge tone={selected.verdict}>{selected.verdict ?? "—"}</Badge>
                        </div>
                        <div className="mono">Findings: {selected.findingCount ?? "—"}</div>
                        {selected.severityCounts && (
                          <div className="muted mono" style={{ fontSize: "0.75rem" }}>
                            {Object.entries(selected.severityCounts)
                              .map(([k, v]) => `${v} ${k}`)
                              .join(", ")}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="muted" style={{ fontSize: "0.72rem" }}>
                          Compare
                        </div>
                        <div>
                          Verdict <Badge tone={compare.verdict}>{compare.verdict ?? "—"}</Badge>
                        </div>
                        <div className="mono">Findings: {compare.findingCount ?? "—"}</div>
                        {compare.severityCounts && (
                          <div className="muted mono" style={{ fontSize: "0.75rem" }}>
                            {Object.entries(compare.severityCounts)
                              .map(([k, v]) => `${v} ${k}`)
                              .join(", ")}
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="muted" style={{ fontSize: "0.8rem", margin: "0.75rem 0 0" }}>
                      Full markdown for both runs is below (selected first). Use Download for offline
                      diff tools if you need a line-level compare.
                    </p>
                  </div>
                )}

                <div
                  className="card report-md"
                  style={{
                    margin: 0,
                    background: "var(--bg-deep)",
                    padding: "0.85rem 1.1rem",
                    maxHeight: compare ? 320 : 520,
                    overflow: "auto",
                  }}
                >
                  {selected.markdown ? (
                    <ReactMarkdown
                      components={{
                        h1: ({ children }) => <h1 className="report-md-h1">{children}</h1>,
                        h2: ({ children }) => <h2 className="report-md-h2">{children}</h2>,
                        h3: ({ children }) => <h3 className="report-md-h3">{children}</h3>,
                        p: ({ children }) => <p className="report-md-p">{children}</p>,
                        ul: ({ children }) => <ul className="report-md-ul">{children}</ul>,
                        ol: ({ children }) => <ol className="report-md-ol">{children}</ol>,
                        li: ({ children }) => <li className="report-md-li">{children}</li>,
                        strong: ({ children }) => (
                          <strong className="report-md-strong">{children}</strong>
                        ),
                        code: ({ children, className }) =>
                          className ? (
                            <code className={`report-md-code-block ${className}`}>{children}</code>
                          ) : (
                            <code className="report-md-code-inline">{children}</code>
                          ),
                        pre: ({ children }) => <pre className="report-md-pre">{children}</pre>,
                        hr: () => <hr className="report-md-hr" />,
                      }}
                    >
                      {normalizeBrand(selected.markdown)}
                    </ReactMarkdown>
                  ) : (
                    <p className="muted">No markdown body stored.</p>
                  )}
                </div>

                {compare?.markdown && (
                  <div
                    className="card report-md"
                    style={{
                      margin: 0,
                      background: "var(--bg-deep)",
                      padding: "0.85rem 1.1rem",
                      maxHeight: 320,
                      overflow: "auto",
                      opacity: 0.95,
                    }}
                  >
                    <div className="muted" style={{ fontSize: "0.75rem", marginBottom: 8 }}>
                      Compare report · {compare.sessionId}
                    </div>
                    <ReactMarkdown
                      components={{
                        h1: ({ children }) => <h1 className="report-md-h1">{children}</h1>,
                        h2: ({ children }) => <h2 className="report-md-h2">{children}</h2>,
                        h3: ({ children }) => <h3 className="report-md-h3">{children}</h3>,
                        p: ({ children }) => <p className="report-md-p">{children}</p>,
                        ul: ({ children }) => <ul className="report-md-ul">{children}</ul>,
                        ol: ({ children }) => <ol className="report-md-ol">{children}</ol>,
                        li: ({ children }) => <li className="report-md-li">{children}</li>,
                        strong: ({ children }) => (
                          <strong className="report-md-strong">{children}</strong>
                        ),
                        code: ({ children, className }) =>
                          className ? (
                            <code className={`report-md-code-block ${className}`}>{children}</code>
                          ) : (
                            <code className="report-md-code-inline">{children}</code>
                          ),
                        pre: ({ children }) => <pre className="report-md-pre">{children}</pre>,
                        hr: () => <hr className="report-md-hr" />,
                      }}
                    >
                      {normalizeBrand(compare.markdown)}
                    </ReactMarkdown>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
