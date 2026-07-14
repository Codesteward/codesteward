import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, KpiCard, PageHero, SkeletonLines, formatRelative } from "../components/ui";
import { Select } from "../components/Select";
import { api, downloadJson, type OrgMemory } from "../lib/api";

export function Learnings() {
  const toast = useToast();
  const [memories, setMemories] = useState<OrgMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [polarity, setPolarity] = useState<"all" | "positive" | "negative">("all");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [formPolarity, setFormPolarity] = useState<"positive" | "negative">("positive");

  const refresh = () =>
    api
      .listMemories(polarity === "all" ? undefined : { polarity })
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
  }, [polarity]);

  const stats = useMemo(() => {
    const positive = memories.filter((m) => m.polarity === "positive").length;
    const negative = memories.filter((m) => m.polarity === "negative").length;
    const kinds = new Set(memories.map((m) => m.kind)).size;
    return { positive, negative, kinds };
  }, [memories]);

  async function createMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
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
      });
      toast.success("Memory created");
      setTitle("");
      setBody("");
      setFormPolarity("positive");
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
        subtitle="Org memories from 👍 / 👎 and status feedback — injected into specialist model prompts and post-judge suppress, scoped per org."
        actions={
          <div className="row">
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
          Explicit preferences (e.g. “never flag import order”) become org memories for future reviews.
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
          <h3>Org memory feed</h3>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            {stats.kinds} kind{stats.kinds === 1 ? "" : "s"}
          </span>
        </div>
        {loading ? (
          <SkeletonLines lines={6} />
        ) : memories.length === 0 ? (
          <EmptyState
            title="No learnings yet"
            description="Create a memory above, or react 👍 / 👎 on findings after a review."
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
              return (
                <div
                  key={m.id}
                  className="card"
                  style={{ margin: 0, background: "var(--bg-deep)", padding: "0.85rem 1rem" }}
                >
                  <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div className="row" style={{ gap: 8 }}>
                      <Badge tone={m.polarity === "positive" ? "ok" : "warn"}>{m.polarity}</Badge>
                      <Badge>{m.kind}</Badge>
                      {m.repoId && (
                        <span className="mono muted" style={{ fontSize: "0.72rem" }}>
                          {m.repoId}
                        </span>
                      )}
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="muted" style={{ fontSize: "0.75rem" }}>
                        {formatRelative(m.updatedAt ?? m.createdAt)}
                      </span>
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
