import { useEffect, useMemo, useState } from "react";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero, formatRelative } from "../components/ui";
import { Select } from "../components/Select";
import {
  api,
  downloadJson,
  findingsToSarif,
  reactionOf,
  type Finding,
} from "../lib/api";

const SEVERITIES = ["all", "critical", "high", "medium", "low", "info", "nit"] as const;
const STATUSES = ["all", "open", "acknowledged", "fixed", "wontfix", "false_positive", "dismissed"] as const;
const STATUS_OPTIONS = ["open", "fixed", "wontfix", "false_positive", "dismissed"] as const;

export function Findings() {
  const toast = useToast();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [repoId, setRepoId] = useState<string>("all");
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () =>
    api
      .findings(repoId === "all" ? undefined : { repoId })
      .then((f) => {
        setFindings(f.findings);
        // Keep full repo list: when filtering by repo, API still returns org repos
        if (f.repos?.length) setRepos(f.repos);
        else {
          const fromData = [
            ...new Set(f.findings.map((x) => x.repoId).filter(Boolean) as string[]),
          ].sort();
          if (repoId === "all") setRepos(fromData);
        }
      })
      .catch(() => setFindings([]))
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  const shown = useMemo(() => {
    return findings.filter((f) => {
      if (repoId !== "all" && f.repoId !== repoId) return false;
      if (severity !== "all" && f.severity !== severity) return false;
      if (status !== "all" && f.status !== status) return false;
      if (!q) return true;
      const hay = `${f.title} ${f.path} ${f.category} ${f.body} ${f.repoId ?? ""}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    });
  }, [findings, severity, status, q, repoId]);

  async function react(f: Finding, reaction: "up" | "down") {
    setBusyId(f.id);
    try {
      const current = reactionOf(f);
      const next = current === reaction ? null : reaction;
      const res = await api.reactFinding(f.id, next, f.tags ?? []);
      setFindings((prev) => prev.map((x) => (x.id === f.id ? res.finding : x)));
      toast.success(next ? `Reacted ${next === "up" ? "👍" : "👎"}` : "Reaction cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function setFindingStatus(f: Finding, nextStatus: string) {
    if (f.status === nextStatus) return;
    setBusyId(f.id);
    try {
      const res = await api.patchFinding(f.id, { status: nextStatus });
      setFindings((prev) => prev.map((x) => (x.id === f.id ? res.finding : x)));
      toast.success(`Status → ${nextStatus}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  function downloadSarif() {
    const sarif = findingsToSarif(shown.length ? shown : findings);
    downloadJson(`codesteward-findings-${Date.now()}.sarif.json`, sarif);
    toast.success("SARIF download started");
  }

  return (
    <div data-tour="page-findings">
      <PageHero
        kicker="Issues"
        title="Findings"
        subtitle="Durable issues across gate and stewardship — react to train preference, export SARIF for CI."
        actions={
          <button type="button" className="primary" onClick={downloadSarif} disabled={!findings.length}>
            Download SARIF
          </button>
        }
      />

      <div className="filters" style={{ flexWrap: "wrap", gap: 8 }}>
        <label className="row" style={{ gap: 6, fontSize: "0.85rem" }}>
          <span className="muted">Repo</span>
          <Select
            value={repoId}
            onChange={setRepoId}
            size="sm"
            fullWidth={false}
            style={{ minWidth: 200 }}
            aria-label="Filter by repository"
            options={[
              { value: "all", label: "All repositories" },
              ...repos.map((r) => ({ value: r, label: r })),
            ]}
          />
        </label>
        <span className="faint" style={{ margin: "0 0.15rem" }}>
          |
        </span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip${severity === s ? " active" : ""}`}
            onClick={() => setSeverity(s)}
          >
            {s}
          </button>
        ))}
        <span className="faint" style={{ margin: "0 0.25rem" }}>
          |
        </span>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip${status === s ? " active" : ""}`}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
        <div style={{ minWidth: 200, flex: 1, maxWidth: 320 }}>
          <input
            placeholder="Search title, path, category, repo…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search findings"
          />
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="skeleton block" style={{ height: 220 }} />
        ) : shown.length === 0 ? (
          <EmptyState
            title="No findings match"
            description={
              findings.length
                ? "Try clearing filters."
                : "Findings appear after a gate or stewardship session completes."
            }
            icon="⚑"
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Conf</th>
                  <th>Repo</th>
                  <th>Category</th>
                  <th>Title</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>React</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => {
                  const r = reactionOf(f);
                  return (
                    <tr key={f.id}>
                      <td>
                        <Badge tone={f.severity}>{f.severity}</Badge>
                      </td>
                      <td
                        className="mono muted"
                        style={{ fontSize: "0.72rem", whiteSpace: "nowrap" }}
                        title={[
                          f.confidence != null
                            ? `Product (evidence): ${Math.round(f.confidence * 100)}%`
                            : null,
                          f.modelConfidence != null
                            ? `Model self-report: ${Math.round(f.modelConfidence * 100)}%`
                            : null,
                          f.tokenConfidence != null
                            ? `Token/logprobs: ${Math.round(f.tokenConfidence * 100)}%`
                            : null,
                        ]
                          .filter(Boolean)
                          .join("\n")}
                      >
                        {f.confidence != null ? `${Math.round(f.confidence * 100)}%` : "—"}
                      </td>
                      <td className="mono muted" style={{ fontSize: "0.72rem", maxWidth: 140 }}>
                        {f.repoId ?? "—"}
                      </td>
                      <td className="muted">{f.category}</td>
                      <td>
                        <div style={{ fontWeight: 550 }}>{f.title}</div>
                        {f.body && (
                          <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2, maxWidth: 360 }}>
                            {f.body.slice(0, 120)}
                            {f.body.length > 120 ? "…" : ""}
                          </div>
                        )}
                        {f.suggestion?.trim() && (
                          <div className="muted" style={{ fontSize: "0.75rem", marginTop: 4, maxWidth: 420 }}>
                            <strong style={{ fontWeight: 600 }}>Suggestion:</strong>{" "}
                            {f.suggestion.trim().slice(0, 160)}
                            {f.suggestion.trim().length > 160 ? "…" : ""}
                          </div>
                        )}
                        {f.suggestedFix?.trim() && (
                          <pre
                            className="mono"
                            style={{
                              fontSize: "0.72rem",
                              marginTop: 6,
                              maxWidth: 440,
                              maxHeight: 140,
                              overflow: "auto",
                              padding: "0.45rem 0.55rem",
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              background: "var(--bg-panel, rgba(0,0,0,0.25))",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {f.suggestedFix.trim().slice(0, 1200)}
                            {f.suggestedFix.trim().length > 1200 ? "\n…" : ""}
                          </pre>
                        )}
                        {(f.evidence ?? []).some(
                          (e) => e.type === "graph" || e.type === "tool" || e.summary,
                        ) && (
                          <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {(f.evidence ?? [])
                              .filter((e) => e.type === "graph" || e.type === "tool" || e.summary)
                              .slice(0, 3)
                              .map((e, i) => (
                                <Badge key={i} tone="ok">
                                  {e.type === "graph" ? "graph" : e.type ?? "evidence"}
                                  {e.summary ? `: ${String(e.summary).slice(0, 40)}` : ""}
                                </Badge>
                              ))}
                          </div>
                        )}
                      </td>
                      <td className="mono">
                        {f.path}
                        {f.startLine ? `:${f.startLine}` : ""}
                      </td>
                      <td>
                        <Select
                          value={f.status}
                          disabled={busyId === f.id}
                          onChange={(v) => void setFindingStatus(f, v)}
                          aria-label={`Status for ${f.title}`}
                          size="sm"
                          fullWidth={false}
                          style={{ minWidth: 120 }}
                          options={[
                            ...(!STATUS_OPTIONS.includes(
                              f.status as (typeof STATUS_OPTIONS)[number],
                            )
                              ? [{ value: f.status, label: f.status }]
                              : []),
                            ...STATUS_OPTIONS.map((s) => ({ value: s, label: s })),
                          ]}
                        />
                      </td>
                      <td className="muted">{formatRelative(f.updatedAt ?? f.createdAt)}</td>
                      <td>
                        <div className="react-btns">
                          <button
                            type="button"
                            className={`sm${r === "up" ? " active-up" : ""}`}
                            disabled={busyId === f.id}
                            onClick={() => void react(f, "up")}
                            aria-label="Thumbs up"
                            title="Helpful"
                          >
                            👍
                          </button>
                          <button
                            type="button"
                            className={`sm${r === "down" ? " active-down" : ""}`}
                            disabled={busyId === f.id}
                            onClick={() => void react(f, "down")}
                            aria-label="Thumbs down"
                            title="Not useful"
                          >
                            👎
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
