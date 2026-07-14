import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, KpiCard, PageHero, SkeletonLines, formatRelative } from "../components/ui";
import { Select } from "../components/Select";
import { api, downloadJson, type LearningScope, type OrgMemory } from "../lib/api";

function memoryScope(m: OrgMemory): LearningScope {
  if (m.scope === "org" || m.scope === "repo" || m.scope === "pr") return m.scope;
  if (m.prKey) return "pr";
  if (m.repoId) return "repo";
  return "org";
}

const SCOPE_LABEL: Record<LearningScope, string> = {
  org: "Org-wide",
  repo: "Repo",
  pr: "PR",
};

export function Learnings() {
  const toast = useToast();
  const [memories, setMemories] = useState<OrgMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [polarity, setPolarity] = useState<"all" | "positive" | "negative">("all");
  const [scopeFilter, setScopeFilter] = useState<"all" | LearningScope>("all");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [formPolarity, setFormPolarity] = useState<"positive" | "negative">("positive");
  const [formScope, setFormScope] = useState<LearningScope>("org");
  const [formRepoId, setFormRepoId] = useState("");
  const [formPrKey, setFormPrKey] = useState("");
  /** Memory id currently showing the move panel */
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveScope, setMoveScope] = useState<LearningScope>("org");
  const [moveRepoId, setMoveRepoId] = useState("");
  const [movePrKey, setMovePrKey] = useState("");

  const refresh = () =>
    api
      .listMemories({
        ...(polarity === "all" ? {} : { polarity }),
        ...(scopeFilter === "all" ? {} : { scope: scopeFilter }),
      })
      .then((r) => {
        setMemories(r.memories);
        setErr(null);
      })
      .catch((e: Error) => {
        setMemories([]);
        setErr(e.message);
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polarity, scopeFilter]);

  const stats = useMemo(() => {
    const positive = memories.filter((m) => m.polarity === "positive").length;
    const negative = memories.filter((m) => m.polarity === "negative").length;
    const byScope = {
      org: memories.filter((m) => memoryScope(m) === "org").length,
      repo: memories.filter((m) => memoryScope(m) === "repo").length,
      pr: memories.filter((m) => memoryScope(m) === "pr").length,
    };
    return { positive, negative, byScope };
  }, [memories]);

  async function createMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (formScope === "repo" && !formRepoId.trim()) {
      toast.error("Repo id is required for repo scope (e.g. owner/name)");
      return;
    }
    if (formScope === "pr" && (!formRepoId.trim() || !formPrKey.trim())) {
      toast.error("Repo id and PR key are required for PR scope (PR key like owner/name#42)");
      return;
    }
    setBusy(true);
    try {
      await api.createMemory({
        title: title.trim(),
        body: body.trim() || undefined,
        polarity: formPolarity,
        kind: "preference",
        source: "ui",
        scope: formScope,
        repoId: formScope === "org" ? undefined : formRepoId.trim() || undefined,
        prKey: formScope === "pr" ? formPrKey.trim() || undefined : undefined,
      });
      toast.success("Memory created");
      setTitle("");
      setBody("");
      setFormPolarity("positive");
      setFormScope("org");
      setFormRepoId("");
      setFormPrKey("");
      setLoading(true);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMemory(id: string, label: string) {
    if (!window.confirm(`Delete memory “${label}”?`)) return;
    setBusy(true);
    try {
      await api.deleteMemory(id);
      toast.info("Memory deleted");
      setMemories((prev) => prev.filter((m) => m.id !== id));
      if (movingId === id) setMovingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function openMove(m: OrgMemory) {
    const s = memoryScope(m);
    setMovingId(m.id);
    setMoveScope(s);
    setMoveRepoId(m.repoId ?? "");
    setMovePrKey(m.prKey ?? (m.repoId ? `${m.repoId}#` : ""));
  }

  async function submitMove(id: string) {
    if (moveScope === "repo" && !moveRepoId.trim()) {
      toast.error("Repo id required");
      return;
    }
    if (moveScope === "pr" && (!moveRepoId.trim() || !movePrKey.trim())) {
      toast.error("Repo id and PR key required (e.g. owner/name#42)");
      return;
    }
    setBusy(true);
    try {
      const { memory } = await api.moveMemoryScope(id, {
        scope: moveScope,
        repoId: moveScope === "org" ? undefined : moveRepoId.trim() || undefined,
        prKey: moveScope === "pr" ? movePrKey.trim() || undefined : undefined,
      });
      toast.success(`Moved to ${SCOPE_LABEL[memoryScope(memory)]}`);
      setMovingId(null);
      setMemories((prev) => prev.map((m) => (m.id === id ? memory : m)));
      // If filtered by scope and moved away, drop from list
      if (scopeFilter !== "all" && memoryScope(memory) !== scopeFilter) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    downloadJson(`codesteward-learnings-${Date.now()}.json`, {
      exportedAt: new Date().toISOString(),
      polarityFilter: polarity,
      scopeFilter,
      count: memories.length,
      memories,
    });
    toast.success("JSON export started");
  }

  return (
    <div>
      <PageHero
        kicker="Trust"
        title="Learnings"
        subtitle="Memories from 👍 / 👎, PR comments, and explicit feedback — scoped org-wide, per-repo, or per-PR. Injected into specialist prompts and post-judge suppress."
        actions={
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {(["all", "positive", "negative"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={polarity === p ? "primary sm" : "ghost sm"}
                onClick={() => setPolarity(p)}
              >
                {p}
              </button>
            ))}
            <span className="muted" style={{ fontSize: "0.75rem", marginLeft: 4 }}>
              scope
            </span>
            {(["all", "org", "repo", "pr"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={scopeFilter === s ? "primary sm" : "ghost sm"}
                onClick={() => setScopeFilter(s)}
              >
                {s === "all" ? "all scopes" : SCOPE_LABEL[s]}
              </button>
            ))}
            <button
              type="button"
              className="sm"
              disabled={!memories.length}
              onClick={exportJson}
            >
              Export JSON
            </button>
          </div>
        }
      />

      <div className="grid cols-3" style={{ marginBottom: "1rem" }}>
        <KpiCard label="Memories" value={memories.length} meta="in current filter" loading={loading} />
        <KpiCard label="Positive" value={stats.positive} meta="reinforce patterns" loading={loading} />
        <KpiCard label="Negative" value={stats.negative} meta="suppress noise" loading={loading} />
      </div>
      <div className="grid cols-3" style={{ marginBottom: "1rem" }}>
        <KpiCard label="Org-wide" value={stats.byScope.org} meta="all projects" loading={loading} />
        <KpiCard label="Repo" value={stats.byScope.repo} meta="one repository" loading={loading} />
        <KpiCard label="PR" value={stats.byScope.pr} meta="one pull request" loading={loading} />
      </div>

      {err && (
        <div className="card" style={{ marginBottom: "1rem", borderColor: "rgba(248,113,113,0.3)" }}>
          <span className="badge failed">Failed to load</span>
          <span className="muted" style={{ marginLeft: 8, fontSize: "0.85rem" }}>
            {err}
          </span>
        </div>
      )}

      <div className="card stack" style={{ marginBottom: "1rem" }}>
        <h3 style={{ margin: 0 }}>Add memory</h3>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Org-wide applies everywhere. Repo scope is for one codebase. PR scope is for one review
          (e.g. “defer this fix to a follow-up PR”).
        </p>
        <form className="stack" onSubmit={(e) => void createMemory(e)}>
          <div className="grid cols-2">
            <div className="field" style={{ margin: 0 }}>
              <label>Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Prefer early returns over nested ifs"
                required
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Polarity</label>
              <Select
                value={formPolarity}
                onChange={(v) => setFormPolarity(v as "positive" | "negative")}
                aria-label="Memory polarity"
                options={[
                  { value: "positive", label: "positive (reinforce)" },
                  { value: "negative", label: "negative (suppress noise)" },
                ]}
              />
            </div>
          </div>
          <div className="grid cols-2">
            <div className="field" style={{ margin: 0 }}>
              <label>Scope</label>
              <Select
                value={formScope}
                onChange={(v) => setFormScope(v as LearningScope)}
                aria-label="Memory scope"
                options={[
                  { value: "org", label: "Org-wide (all projects)" },
                  { value: "repo", label: "Repo (one repository)" },
                  { value: "pr", label: "PR (one pull request)" },
                ]}
              />
            </div>
            {(formScope === "repo" || formScope === "pr") && (
              <div className="field" style={{ margin: 0 }}>
                <label>Repo id</label>
                <input
                  value={formRepoId}
                  onChange={(e) => setFormRepoId(e.target.value)}
                  placeholder="owner/repo"
                  required
                />
              </div>
            )}
          </div>
          {formScope === "pr" && (
            <div className="field" style={{ margin: 0 }}>
              <label>PR key</label>
              <input
                value={formPrKey}
                onChange={(e) => setFormPrKey(e.target.value)}
                placeholder="owner/repo#42"
                required
              />
            </div>
          )}
          <div className="field" style={{ margin: 0 }}>
            <label>Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional detail — when this should apply, examples, exceptions…"
              rows={3}
              style={{ width: "100%", resize: "vertical" }}
            />
          </div>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !title.trim()}>
              {busy ? "Saving…" : "Create memory"}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Memory feed</h3>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            move across scopes if something landed wrong
          </span>
        </div>
        {loading ? (
          <SkeletonLines lines={6} />
        ) : memories.length === 0 ? (
          <EmptyState
            title="No learnings yet"
            description="Create a memory above, react 👍 / 👎 on findings, or comment @codesteward on a PR."
            icon="✦"
            action={
              <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                <Link to="/sessions?mode=gate">
                  <button type="button" className="primary sm">
                    Run first review
                  </button>
                </Link>
                <Link to="/findings">
                  <button type="button" className="sm">
                    Open findings
                  </button>
                </Link>
              </div>
            }
          />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {memories.map((m) => {
              const label = m.title || m.pattern || m.fingerprint || "Untitled memory";
              const scope = memoryScope(m);
              return (
                <div
                  key={m.id}
                  className="card"
                  style={{ margin: 0, background: "var(--bg-deep)", padding: "0.85rem 1rem" }}
                >
                  <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <Badge tone={scope === "org" ? "ok" : scope === "repo" ? "info" : "warn"}>
                        {SCOPE_LABEL[scope]}
                      </Badge>
                      <Badge tone={m.polarity === "positive" ? "ok" : "warn"}>{m.polarity}</Badge>
                      <Badge>{m.kind}</Badge>
                      {m.repoId && (
                        <span className="mono muted" style={{ fontSize: "0.72rem" }}>
                          {m.repoId}
                        </span>
                      )}
                      {m.prKey && (
                        <span className="mono muted" style={{ fontSize: "0.72rem" }}>
                          {m.prKey}
                        </span>
                      )}
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="muted" style={{ fontSize: "0.75rem" }}>
                        {formatRelative(m.updatedAt ?? m.createdAt)}
                      </span>
                      <button
                        type="button"
                        className="ghost sm"
                        disabled={busy}
                        onClick={() => (movingId === m.id ? setMovingId(null) : openMove(m))}
                      >
                        {movingId === m.id ? "Cancel" : "Move scope"}
                      </button>
                      <button
                        type="button"
                        className="ghost sm danger"
                        disabled={busy}
                        onClick={() => void deleteMemory(m.id, label)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, fontWeight: 600 }}>{label}</div>
                  {m.body && (
                    <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                      {m.body}
                    </p>
                  )}
                  {m.source && (
                    <div className="mono faint" style={{ marginTop: 6, fontSize: "0.7rem" }}>
                      source · {m.source}
                      {typeof m.weight === "number" ? ` · weight ${m.weight}` : ""}
                    </div>
                  )}
                  {movingId === m.id && (
                    <div
                      className="stack"
                      style={{
                        marginTop: 12,
                        padding: "0.75rem",
                        borderRadius: 8,
                        border: "1px solid var(--border, rgba(255,255,255,0.08))",
                        background: "var(--bg, transparent)",
                      }}
                    >
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        Move to another scope
                      </div>
                      <div className="grid cols-2">
                        <div className="field" style={{ margin: 0 }}>
                          <label>Scope</label>
                          <Select
                            value={moveScope}
                            onChange={(v) => setMoveScope(v as LearningScope)}
                            aria-label="Move target scope"
                            options={[
                              { value: "org", label: "Org-wide" },
                              { value: "repo", label: "Repo" },
                              { value: "pr", label: "PR" },
                            ]}
                          />
                        </div>
                        {(moveScope === "repo" || moveScope === "pr") && (
                          <div className="field" style={{ margin: 0 }}>
                            <label>Repo id</label>
                            <input
                              value={moveRepoId}
                              onChange={(e) => setMoveRepoId(e.target.value)}
                              placeholder="owner/repo"
                            />
                          </div>
                        )}
                      </div>
                      {moveScope === "pr" && (
                        <div className="field" style={{ margin: 0 }}>
                          <label>PR key</label>
                          <input
                            value={movePrKey}
                            onChange={(e) => setMovePrKey(e.target.value)}
                            placeholder="owner/repo#42"
                          />
                        </div>
                      )}
                      <div className="row">
                        <button
                          type="button"
                          className="primary sm"
                          disabled={busy}
                          onClick={() => void submitMove(m.id)}
                        >
                          {busy ? "Moving…" : "Apply move"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
