import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero } from "../components/ui";
import { Select } from "../components/Select";
import { RepoPicker } from "../components/RepoPicker";
import { api, type Finding, type ScmPr, type Session } from "../lib/api";

export function DiffPage() {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [provider, setProvider] = useState(() => searchParams.get("provider") ?? "github");
  const [owner, setOwner] = useState(() => searchParams.get("owner") ?? "");
  const [repo, setRepo] = useState(() => searchParams.get("repo") ?? "");
  const [prNumber, setPrNumber] = useState(() => searchParams.get("number") ?? "");
  const [diffText, setDiffText] = useState<string | null>(null);
  const [pr, setPr] = useState<ScmPr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [autoLoaded, setAutoLoaded] = useState(false);
  const [viewType, setViewType] = useState<"split" | "unified">("unified");

  useEffect(() => {
    api
      .sessions()
      .then((r) => setSessions(r.sessions.filter((s) => s.prNumber)))
      .catch(() => setSessions([]));
  }, []);

  function applySession(id: string) {
    setSessionId(id);
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    if (s.scmFullName?.includes("/")) {
      const [o, r] = s.scmFullName.split("/");
      setOwner(o ?? "");
      setRepo(r ?? "");
    } else if (s.repoId?.includes("/")) {
      const [o, r] = s.repoId.split("/");
      setOwner(o ?? "");
      setRepo(r ?? "");
    }
    if (s.prNumber) setPrNumber(String(s.prNumber));
    if (s.scmProvider) setProvider(s.scmProvider);
    api
      .sessionFindings(id)
      .then((res) => setFindings(res.findings))
      .catch(() => setFindings([]));
  }

  async function loadDiff() {
    if (!owner.trim() || !repo.trim() || !prNumber.trim()) {
      toast.error("Owner, repo, and PR number required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.getPrDiff(provider, owner.trim(), repo.trim(), Number(prNumber));
      // Prefer raw unified patch when available
      const raw =
        (res as { diff?: string; patch?: string }).diff ??
        (res as { patch?: string }).patch ??
        (res.files ?? [])
          .map((f) => f.patch ?? "")
          .filter(Boolean)
          .join("\n");
      setDiffText(raw || "");
      setPr(res.pr);
      toast.success(`Loaded PR #${prNumber} · ${res.files?.length ?? 0} files`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoLoaded) return;
    const o = searchParams.get("owner");
    const r = searchParams.get("repo");
    const n = searchParams.get("number");
    if (o && r && n) {
      setAutoLoaded(true);
      void loadDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, autoLoaded, owner, repo, prNumber]);

  const files = useMemo(() => {
    if (!diffText) return [];
    try {
      // react-diff-view expects proper unified diffs; tolerate multi-file
      return parseDiff(diffText, { nearbySequences: "zip" });
    } catch {
      return [];
    }
  }, [diffText]);

  const active = findings.find((f) => f.id === activeId);
  const filteredFindings = findings;

  return (
    <div>
      <PageHero
        kicker="Code review"
        title="PR Diff"
        subtitle="Unified diffs rendered with react-diff-view (not a custom wheel)."
        actions={
          pr ? (
            <div className="row">
              <Badge>PR #{pr.number}</Badge>
              <span className="mono muted">
                {pr.baseBranch}…{pr.headBranch}
              </span>
            </div>
          ) : null
        }
      />

      <div className="card stack" style={{ marginBottom: "1rem" }}>
        <div className="grid cols-3">
          <div className="field" style={{ margin: 0 }}>
            <label>Provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="github">github</option>
              <option value="gitlab">gitlab</option>
              <option value="bitbucket">bitbucket</option>
              <option value="azure-devops">azure-devops</option>
              <option value="gitea">gitea</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Repository</label>
            <RepoPicker
              value={owner && repo ? `${owner}/${repo}` : ""}
              onChange={(p) => {
                if ("fullName" in p && p.fullName) {
                  const [o, r] = p.fullName.split("/");
                  setOwner(o ?? "");
                  setRepo(r ?? "");
                  if ("provider" in p && p.provider) setProvider(p.provider);
                } else if (p.repoId.includes("/")) {
                  const [o, r] = p.repoId.split("/");
                  setOwner(o ?? "");
                  setRepo(r ?? "");
                }
              }}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>PR number</label>
            <input
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="42"
              inputMode="numeric"
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Session (findings)</label>
            <select value={sessionId} onChange={(e) => applySession(e.target.value)}>
              <option value="">— optional —</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.repoId} · PR #{s.prNumber} · {s.id.slice(0, 10)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>View</label>
            <select
              value={viewType}
              onChange={(e) => setViewType(e.target.value as "split" | "unified")}
            >
              <option value="unified">unified</option>
              <option value="split">split</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0, display: "flex", alignItems: "flex-end" }}>
            <button type="button" className="primary" disabled={busy} onClick={() => void loadDiff()}>
              {busy ? "Loading…" : "Load PR diff"}
            </button>
          </div>
        </div>
        {error && (
          <div className="banner warn" role="alert">
            <strong>Could not load diff</strong>
            <span>{error}</span>
          </div>
        )}
      </div>

      {!diffText && !error ? (
        <div className="card">
          <EmptyState
            title="Load a PR"
            description="Pick a connected repository and PR number, or open from the PRs page."
            icon="⇄"
          />
        </div>
      ) : diffText !== null ? (
        <div className="diff-layout">
          <div className="diff-panel" style={{ overflow: "auto" }}>
            {files.length === 0 ? (
              <div className="muted" style={{ padding: 16 }}>
                {diffText
                  ? "Could not parse as unified multi-file diff — raw length " + diffText.length
                  : "Empty diff"}
                {diffText && (
                  <pre className="mono" style={{ fontSize: 11, maxHeight: 400, overflow: "auto" }}>
                    {diffText.slice(0, 8000)}
                  </pre>
                )}
              </div>
            ) : (
              files.map((file) => (
                <div key={file.oldRevision + file.newRevision + file.newPath} style={{ marginBottom: 16 }}>
                  <div className="diff-file-header">
                    {file.type} · {file.oldPath === file.newPath ? file.newPath : `${file.oldPath} → ${file.newPath}`}
                    {active?.path &&
                    (file.newPath?.includes(active.path) || file.oldPath?.includes(active.path))
                      ? " · finding focus"
                      : ""}
                  </div>
                  <Diff viewType={viewType} diffType={file.type} hunks={file.hunks}>
                    {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                  </Diff>
                </div>
              ))
            )}
          </div>

          <div className="card" style={{ position: "sticky", top: 12 }}>
            <div className="card-header">
              <h3>Findings on diff</h3>
              <Badge tone="running">{filteredFindings.length}</Badge>
            </div>
            {!sessionId ? (
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Select a session to show findings beside the diff.
              </p>
            ) : filteredFindings.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                No findings for this session yet.
              </p>
            ) : (
              filteredFindings.map((f) => (
                <div
                  key={f.id}
                  className={`finding-side-card${activeId === f.id ? " active" : ""}`}
                  onClick={() => setActiveId(f.id)}
                  onKeyDown={(e) => e.key === "Enter" && setActiveId(f.id)}
                  role="button"
                  tabIndex={0}
                >
                  <Badge tone={f.severity}>{f.severity}</Badge>
                  <h4>{f.title}</h4>
                  <div className="mono muted" style={{ fontSize: "0.72rem" }}>
                    {f.path}
                    {f.startLine ? `:${f.startLine}` : ""}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Keep export name used by App.tsx
export { DiffPage as Diff };
