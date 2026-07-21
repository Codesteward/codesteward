/**
 * Product session deep-dive: org-facing view of ClickHouse traces.
 * Full I/O is stored; UI renders chat / tools / findings in a readable layout
 * (raw JSON is optional, not the default).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Badge,
  EmptyState,
  PageHero,
  formatRelative,
  shortId,
} from "../components/ui";
import {
  api,
  type Session,
  type TraceObservationRow,
  type TraceSessionSummary,
} from "../lib/api";

function tryParseJson(raw: unknown): unknown {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return raw;
  const t = raw.trim();
  if (!t) return null;
  if (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  ) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function kindTone(kind: string): "ok" | "running" | "warn" | "default" {
  if (kind === "generation") return "ok";
  if (kind === "tool") return "running";
  if (kind === "trace_summary") return "warn";
  return "default";
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "generation":
      return "LLM call";
    case "tool":
      return "Tool";
    case "trace_summary":
      return "Summary";
    case "span":
      return "Step";
    default:
      return kind || "Event";
  }
}

function roleLabel(role: string): string {
  if (!role) return "";
  const map: Record<string, string> = {
    human: "User",
    user: "User",
    ai: "Assistant",
    assistant: "Assistant",
    system: "System",
    tool: "Tool",
  };
  return map[role.toLowerCase()] ?? role;
}

function groupByTrace(
  rows: TraceObservationRow[],
): Map<string, TraceObservationRow[]> {
  const m = new Map<string, TraceObservationRow[]>();
  for (const r of rows) {
    const tid = String(r.trace_id ?? r.traceId ?? "unknown");
    const list = m.get(tid) ?? [];
    list.push(r);
    m.set(tid, list);
  }
  return m;
}

function humanTraceTitle(traceId: string, rows: TraceObservationRow[]): string {
  const role = rows.find((r) => r.role)?.role;
  const name = rows.find((r) => r.name && String(r.name).startsWith("steward."))?.name
    ?? rows.find((r) => r.name)?.name;
  if (role) return `${String(role)} specialist`;
  if (name) return String(name).replace(/^steward\./, "");
  // ses_xxx:unit:role → last segment
  const parts = traceId.split(":");
  return parts[parts.length - 1] || shortId(traceId, 16);
}

type ChatMsg = {
  role: string;
  content: string;
  tool_calls?: unknown;
  name?: string;
};

function extractMessages(value: unknown): ChatMsg[] | null {
  const v = tryParseJson(value);
  if (!v) return null;
  if (Array.isArray(v)) {
    if (
      v.length &&
      v.every(
        (x) =>
          x &&
          typeof x === "object" &&
          ("role" in (x as object) || "content" in (x as object)),
      )
    ) {
      return (v as ChatMsg[]).map((m) => ({
        role: String(m.role ?? "message"),
        content:
          typeof m.content === "string"
            ? m.content
            : m.content != null
              ? JSON.stringify(m.content, null, 2)
              : "",
        tool_calls: m.tool_calls,
        name: m.name != null ? String(m.name) : undefined,
      }));
    }
    // Nested threads [[msgs]]
    if (v.length && Array.isArray(v[0])) {
      return extractMessages(v.flat());
    }
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.messages)) return extractMessages(o.messages);
    // ModelRouter shape { system, messages }
    if (o.system != null || Array.isArray(o.messages)) {
      const msgs: ChatMsg[] = [];
      if (o.system != null) {
        msgs.push({
          role: "system",
          content: typeof o.system === "string" ? o.system : JSON.stringify(o.system, null, 2),
        });
      }
      if (Array.isArray(o.messages)) {
        const nested = extractMessages(o.messages);
        if (nested) msgs.push(...nested);
      }
      if (msgs.length) return msgs;
    }
    if (typeof o.role === "string" && o.content != null) {
      return [
        {
          role: o.role,
          content:
            typeof o.content === "string"
              ? o.content
              : JSON.stringify(o.content, null, 2),
          tool_calls: o.tool_calls,
          name: o.name != null ? String(o.name) : undefined,
        },
      ];
    }
  }
  return null;
}

function extractFindings(value: unknown): Array<Record<string, unknown>> | null {
  const v = tryParseJson(value);
  if (!v) return null;
  if (typeof v === "string") {
    try {
      return extractFindings(JSON.parse(v));
    } catch {
      const m = v.match(/\{[\s\S]*"findings"\s*:\s*\[[\s\S]*\}\s*$/);
      if (m) {
        try {
          return extractFindings(JSON.parse(m[0]!));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.findings)) {
      return o.findings.filter((x) => x && typeof x === "object") as Array<
        Record<string, unknown>
      >;
    }
    // assistant message wrapping findings
    if (typeof o.content === "string" && o.content.includes("findings")) {
      return extractFindings(o.content);
    }
  }
  if (Array.isArray(v) && v[0] && typeof v[0] === "object" && "content" in (v[0] as object)) {
    return extractFindings((v[0] as { content: unknown }).content);
  }
  return null;
}

function ChatBubbles({ messages }: { messages: ChatMsg[] }) {
  return (
    <div className="trace-chat">
      {messages.map((m, i) => {
        const r = m.role.toLowerCase();
        const isUser = r === "user" || r === "human";
        const isSystem = r === "system";
        const isTool = r === "tool";
        return (
          <div
            key={i}
            className={`trace-chat-msg ${isUser ? "user" : isSystem ? "system" : isTool ? "tool" : "assistant"}`}
          >
            <div className="trace-chat-role">
              {roleLabel(m.role)}
              {m.name ? ` · ${m.name}` : ""}
            </div>
            {m.content?.trim() ? (
              <div className="trace-chat-body">{m.content}</div>
            ) : null}
            {m.tool_calls != null ? (
              <div className="trace-chat-tools">
                <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
                  Tool requests
                </div>
                <pre className="trace-pre-sm">
                  {typeof m.tool_calls === "string"
                    ? m.tool_calls
                    : JSON.stringify(m.tool_calls, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FindingsCards({ findings }: { findings: Array<Record<string, unknown>> }) {
  return (
    <div className="trace-findings">
      {findings.map((f, i) => (
        <div key={i} className="trace-finding-card">
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <strong style={{ fontSize: "0.9rem" }}>
              {String(f.title ?? f.name ?? `Finding ${i + 1}`)}
            </strong>
            {f.severity != null && (
              <Badge tone={String(f.severity).toLowerCase() === "critical" ? "error" : "warn"}>
                {String(f.severity)}
              </Badge>
            )}
            {f.category != null && (
              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {String(f.category)}
              </span>
            )}
          </div>
          {f.path != null && (
            <div className="mono muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>
              {String(f.path)}
              {f.line != null ? `:${f.line}` : ""}
            </div>
          )}
          {(f.body != null || f.description != null) && (
            <p style={{ margin: "8px 0 0", fontSize: "0.85rem", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {String(f.body ?? f.description)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ToolPayload({ value, label }: { value: unknown; label: string }) {
  const v = tryParseJson(value);
  if (v == null || v === "") {
    return <span className="muted">—</span>;
  }
  // Tool message with content
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.content != null && (o.role === "tool" || o.status || o.name)) {
      return (
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            {o.name != null && <Badge tone="running">{String(o.name)}</Badge>}
            {o.status != null && (
              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {String(o.status)}
              </span>
            )}
          </div>
          <pre className="trace-pre">{String(o.content)}</pre>
        </div>
      );
    }
  }
  return (
    <div>
      <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
        {label}
      </div>
      <pre className="trace-pre">
        {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
      </pre>
    </div>
  );
}

function IoPanel({
  label,
  value,
  kind,
}: {
  label: string;
  value: unknown;
  kind: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const messages = extractMessages(value);
  const findings = extractFindings(value);
  const parsed = tryParseJson(value);
  const empty = value == null || value === "";

  let body: ReactNode;
  if (empty) {
    body = <span className="muted">—</span>;
  } else if (showRaw) {
    body = (
      <pre className="trace-pre">
        {typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } else if (findings && findings.length > 0 && (kind === "generation" || kind === "trace_summary")) {
    body = (
      <div>
        <div className="muted" style={{ fontSize: "0.75rem", marginBottom: 8 }}>
          {findings.length} finding{findings.length === 1 ? "" : "s"} in response
        </div>
        <FindingsCards findings={findings} />
      </div>
    );
  } else if (messages && messages.length > 0) {
    body = <ChatBubbles messages={messages} />;
  } else if (kind === "tool" || String(label).toLowerCase().includes("tool")) {
    body = <ToolPayload value={value} label={label} />;
  } else if (typeof parsed === "string") {
    body = <div className="trace-prose">{parsed}</div>;
  } else {
    body = (
      <pre className="trace-pre">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  }

  return (
    <div className="trace-io">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: "0.8rem" }}>{label}</strong>
        {!empty && (
          <button
            type="button"
            className="ghost sm"
            style={{ fontSize: "0.72rem", padding: "2px 8px" }}
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Readable view" : "Raw JSON"}
          </button>
        )}
      </div>
      {body}
    </div>
  );
}

export function TraceExplorer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("session") ?? "";

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<TraceSessionSummary[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [observations, setObservations] = useState<TraceObservationRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [productSession, setProductSession] = useState<Session | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filterKind, setFilterKind] = useState<string>("all");
  const [filterRole, setFilterRole] = useState<string>("all");
  const [query, setQuery] = useState("");
  /** Hide low-level graph noise by default for a friendlier view */
  const [showInternal, setShowInternal] = useState(false);

  const loadStatusAndList = useCallback(() => {
    setListLoading(true);
    setListErr(null);
    void Promise.all([api.traceStorageStatus(), api.traceSessions(200)])
      .then(([st, list]) => {
        setEnabled(Boolean(st.enabled));
        if (st.enabled && list.enabled) {
          setSessions(list.sessions ?? []);
        } else {
          setSessions([]);
        }
      })
      .catch((e: Error) => {
        setEnabled(false);
        setListErr(e.message);
      })
      .finally(() => setListLoading(false));
  }, []);

  useEffect(() => {
    loadStatusAndList();
  }, [loadStatusAndList]);

  useEffect(() => {
    if (!selectedId || !enabled) {
      setObservations([]);
      setProductSession(null);
      return;
    }
    setDetailLoading(true);
    setDetailErr(null);
    void Promise.all([
      api.sessionTraces(selectedId, 5000),
      api.session(selectedId).catch(() => null),
    ])
      .then(([tr, ses]) => {
        setObservations((tr.observations ?? []) as TraceObservationRow[]);
        setProductSession(ses?.session ?? null);
        setExpanded({});
      })
      .catch((e: Error) => setDetailErr(e.message))
      .finally(() => setDetailLoading(false));
  }, [selectedId, enabled]);

  const roles = useMemo(() => {
    const s = new Set<string>();
    for (const o of observations) {
      const r = String(o.role ?? "").trim();
      if (r) s.add(r);
    }
    return [...s].sort();
  }, [observations]);

  const filtered = useMemo(() => {
    return observations.filter((o) => {
      const kind = String(o.kind ?? "");
      const role = String(o.role ?? "");
      const name = String(o.name ?? "");
      if (filterKind !== "all" && kind !== filterKind) return false;
      if (filterRole !== "all" && role !== filterRole) return false;
      if (!showInternal) {
        // Collapse noisy LangGraph internals unless user opts in
        if (
          kind === "span" &&
          /^(Runnable|CompiledStateGraph|ChannelWrite|Branch|__start__|__end__)/i.test(name)
        ) {
          return false;
        }
      }
      if (query.trim()) {
        const hay = [o.name, o.kind, o.role, o.model, o.input, o.output, o.trace_id]
          .map((x) => String(x ?? "").toLowerCase())
          .join(" ");
        if (!hay.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [observations, filterKind, filterRole, query, showInternal]);

  const byTrace = useMemo(() => groupByTrace(filtered), [filtered]);

  // Timeline: prefer generations + tools + summaries for a story-like view
  const timeline = useMemo(() => {
    if (filterKind !== "all") return filtered;
    return filtered.filter((o) => {
      const k = String(o.kind ?? "");
      return k === "generation" || k === "tool" || k === "trace_summary" || showInternal;
    });
  }, [filtered, filterKind, showInternal]);

  if (enabled === false) {
    return (
      <div>
        <PageHero
          kicker="Observability"
          title="Session traces"
          subtitle="Understand how specialists and tools worked through a review."
        />
        <EmptyState
          title="Trace storage is not enabled"
          description="Your platform admin can enable ClickHouse under Platform settings. Once enabled, every org can open this page to inspect agent turns."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHero
        kicker="Observability"
        title="Session traces"
        subtitle="Follow each specialist’s work — prompts, tool use, and findings — stored for your organization."
        actions={
          <button type="button" className="ghost sm" onClick={() => loadStatusAndList()}>
            Refresh
          </button>
        }
      />

      <details className="card" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}>
          What am I looking at? · event types · specialists · internal steps (Runnable…)
        </summary>
        <div
          className="stack"
          style={{
            gap: 10,
            marginTop: 10,
            fontSize: "0.85rem",
            lineHeight: 1.55,
            color: "var(--text-secondary)",
          }}
        >
          <div>
            <strong style={{ color: "var(--text)" }}>Traces</strong> are a{" "}
            <em>replay of how the review agents worked</em> for one product session: which
            specialist ran, what was sent to the model, which tools it called, and what came
            back. They are stored in ClickHouse when platform trace storage is enabled — not
            the findings list itself.
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>Left column</strong> lists sessions that
            have stored events. <strong style={{ color: "var(--text)" }}>Right column</strong>{" "}
            is a timeline grouped by specialist run (each group is one agent invocation).
          </div>

          <div>
            <strong style={{ color: "var(--text)" }}>Event types (badges)</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>LLM call</strong> (
              <span className="mono">generation</span>) — a request/response to a language
              model: system + user prompts in, assistant text (and optional tool-call plans)
              out. Token counts and model name appear when available.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>Tool</strong> — the agent invoked a
              product tool (e.g. <span className="mono">read_file</span>,{" "}
              <span className="mono">graph_query</span>, <span className="mono">sandbox_exec</span>
              ). “What was sent” is the tool arguments; “What came back” is the tool result.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>Summary</strong> — a compact end-of-run
              rollup for that specialist (high-level outcome, not full chat).
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>Step</strong> (
              <span className="mono">span</span>) — a structural or framework span. Useful ones
              may be product-named; many are low-level graph internals (see below).
            </li>
          </ul>

          <div>
            <strong style={{ color: "var(--text)" }}>Specialists</strong> (roles such as{" "}
            <span className="mono">security</span>, <span className="mono">correctness</span>,{" "}
            <span className="mono">rules</span>) are parallel agent runs inside a review. Filter
            by specialist to isolate one role. Trace titles like “security specialist” map to
            those roles.
          </div>

          <div>
            <strong style={{ color: "var(--text)" }}>Show internal steps</strong>
          </div>
          <div>
            Off by default so the timeline stays readable (LLM + tools + summaries). Turn it{" "}
            <em>on</em> when you are debugging agent plumbing, empty tools, or odd control flow.
            Internal names come from <strong style={{ color: "var(--text)" }}>LangChain /
            LangGraph / DeepAgents</strong> — the library stack that runs the agent loop — not
            from your application domain names.
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }} className="mono">
                RunnableSequence
              </strong>{" "}
              — a pipeline that runs several steps <em>in order</em> (e.g. format prompt → call
              model → parse). Seeing many of these is normal; they are the framework’s way of
              composing work, not separate “bugs.”
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }} className="mono">
                RunnableLambda
              </strong>{" "}
              — a small anonymous function node in that pipeline (data shape, routing, light
              transforms). Usually no user-facing content; empty or tiny I/O is expected.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }} className="mono">
                CompiledStateGraph
              </strong>{" "}
              / graph nodes — the agent state machine (LangGraph). One specialist run is often
              one compiled graph execution.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }} className="mono">
                ChannelWrite
              </strong>
              ,{" "}
              <strong style={{ color: "var(--text)" }} className="mono">
                Branch
              </strong>
              ,{" "}
              <strong style={{ color: "var(--text)" }} className="mono">
                __start__
              </strong>
              ,{" "}
              <strong style={{ color: "var(--text)" }} className="mono">
                __end__
              </strong>{" "}
              — graph wiring (write to state channels, conditional branches, entry/exit).
              Rarely useful for review quality; hide them unless debugging the runtime.
            </li>
          </ul>

          <div>
            <strong style={{ color: "var(--text)" }}>Reading a step</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>What was sent</strong> — inputs to that
              step (prompts, tool args). Prefer the readable view; use{" "}
              <em>Raw JSON</em> only when debugging structure.
            </li>
            <li style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>What came back</strong> — model text, tool
              results, or structured payloads. Empty tool results often mean a path/FS issue or
              a refused sandbox call, not a blank UI.
            </li>
          </ul>

          <div className="muted" style={{ fontSize: "0.8rem" }}>
            <strong>Tip:</strong> start with LLM calls + tools for a given specialist; open
            internal steps only when the agent seems stuck or tools return errors. Findings and
            verdicts stay on{" "}
            <Link to="/sessions">Sessions</Link> /{" "}
            <Link to="/findings">Findings</Link> — traces explain{" "}
            <em>how</em> the agents worked, not the final gate decision alone.
          </div>
        </div>
      </details>

      {listErr && (
        <div className="banner error" style={{ marginBottom: 12 }}>
          {listErr}
        </div>
      )}

      <div className="trace-explorer">
        <div className="card trace-session-list">
          <div className="trace-session-list-head">
            <strong>Sessions</strong>
            <div className="muted" style={{ fontSize: "0.75rem" }}>
              {listLoading ? "Loading…" : `${sessions.length} with traces`}
            </div>
          </div>
          {!listLoading && sessions.length === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState
                title="No traces yet"
                description="After a review runs with ClickHouse enabled, sessions show up here."
              />
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {sessions.map((s) => {
                const active = s.sessionId === selectedId;
                return (
                  <li key={s.sessionId}>
                    <button
                      type="button"
                      className={`trace-session-item${active ? " active" : ""}`}
                      onClick={() =>
                        setSearchParams({ session: s.sessionId }, { replace: false })
                      }
                    >
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span className="mono" style={{ fontSize: "0.8rem" }}>
                          {shortId(s.sessionId, 14)}
                        </span>
                        {s.status && (
                          <Badge tone={s.status === "completed" ? "ok" : "running"}>
                            {s.status}
                          </Badge>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                        {s.repoId || "Repository"} · {s.observationCount} events
                      </div>
                      <div className="muted" style={{ fontSize: "0.72rem" }}>
                        {s.lastTs
                          ? formatRelative(s.lastTs.includes("T") ? s.lastTs : `${s.lastTs.replace(" ", "T")}Z`)
                          : "—"}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card trace-detail">
          {!selectedId ? (
            <EmptyState
              title="Select a session"
              description="Choose a session to walk through specialist turns, tool calls, and model responses."
            />
          ) : detailLoading ? (
            <p className="muted">Loading session…</p>
          ) : detailErr ? (
            <div className="banner error">{detailErr}</div>
          ) : (
            <>
              <div className="trace-detail-head">
                <div>
                  <div className="mono" style={{ fontWeight: 600 }}>
                    {selectedId}
                  </div>
                  <div className="muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                    {productSession?.repoId ?? "—"}
                    {productSession?.mode ? ` · ${productSession.mode}` : ""}
                    {productSession?.verdict ? ` · ${productSession.verdict}` : ""}
                    {" · "}
                    {observations.length} stored events
                  </div>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <select
                    value={filterKind}
                    onChange={(e) => setFilterKind(e.target.value)}
                    aria-label="Filter by type"
                  >
                    <option value="all">All types</option>
                    <option value="generation">LLM calls</option>
                    <option value="tool">Tools</option>
                    <option value="span">Steps</option>
                    <option value="trace_summary">Summaries</option>
                  </select>
                  <select
                    value={filterRole}
                    onChange={(e) => setFilterRole(e.target.value)}
                    aria-label="Filter by specialist"
                  >
                    <option value="all">All specialists</option>
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="Search…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ minWidth: 120 }}
                  />
                  <label
                    className="row"
                    style={{ gap: 6, fontSize: "0.78rem", color: "var(--text-muted)" }}
                  >
                    <input
                      type="checkbox"
                      checked={showInternal}
                      onChange={(e) => setShowInternal(e.target.checked)}
                    />
                    Show internal steps
                  </label>
                </div>
              </div>

              {timeline.length === 0 ? (
                <EmptyState
                  title="Nothing to show"
                  description={
                    showInternal
                      ? "No events match your filters."
                      : "Try enabling “Show internal steps” or clearing filters."
                  }
                />
              ) : (
                <div className="trace-timeline">
                  {[...byTrace.entries()].map(([traceId, rows]) => {
                    const title = humanTraceTitle(traceId, rows);
                    const rowsShow = filterKind === "all" && !showInternal
                      ? rows.filter((r) => {
                          const k = String(r.kind ?? "");
                          return (
                            k === "generation" ||
                            k === "tool" ||
                            k === "trace_summary"
                          );
                        })
                      : rows;
                    if (!rowsShow.length) return null;
                    return (
                      <section key={traceId} className="trace-group">
                        <header className="trace-group-head">
                          <strong>{title}</strong>
                          <span className="muted mono" style={{ fontSize: "0.72rem" }}>
                            {rowsShow.length} step{rowsShow.length === 1 ? "" : "s"}
                          </span>
                        </header>
                        <ol className="trace-steps">
                          {rowsShow.map((o, idx) => {
                            const oid = String(
                              o.observation_id ?? o.observationId ?? `${traceId}-${idx}`,
                            );
                            const open = expanded[oid] ?? idx < 2;
                            const kind = String(o.kind ?? "span");
                            return (
                              <li key={oid} className="trace-step">
                                <button
                                  type="button"
                                  className="trace-step-toggle"
                                  onClick={() =>
                                    setExpanded((prev) => ({
                                      ...prev,
                                      [oid]: !open,
                                    }))
                                  }
                                >
                                  <span className="trace-step-idx">{idx + 1}</span>
                                  <Badge tone={kindTone(kind)}>{kindLabel(kind)}</Badge>
                                  <span className="trace-step-name">
                                    {String(o.name ?? "—")
                                      .replace(/^tool:/, "")
                                      .replace(/^chat\./, "chat · ")}
                                  </span>
                                  {o.role ? (
                                    <span className="muted" style={{ fontSize: "0.75rem" }}>
                                      {String(o.role)}
                                    </span>
                                  ) : null}
                                  {o.model ? (
                                    <span className="muted mono" style={{ fontSize: "0.72rem" }}>
                                      {String(o.model)}
                                    </span>
                                  ) : null}
                                  <span className="trace-step-meta muted">
                                    {Number(o.total_tokens ?? 0) > 0
                                      ? `${o.total_tokens} tokens`
                                      : ""}
                                    {Number(o.duration_ms ?? 0) > 0
                                      ? ` · ${o.duration_ms} ms`
                                      : ""}
                                    {" · "}
                                    {open ? "Hide" : "Show"}
                                  </span>
                                </button>
                                {open && (
                                  <div className="trace-step-body">
                                    <IoPanel
                                      label="What was sent"
                                      value={o.input}
                                      kind={kind}
                                    />
                                    <IoPanel
                                      label="What came back"
                                      value={o.output}
                                      kind={kind}
                                    />
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <style>{`
        .trace-explorer {
          display: grid;
          grid-template-columns: minmax(240px, 300px) 1fr;
          gap: 16px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .trace-explorer { grid-template-columns: 1fr; }
        }
        .trace-session-list {
          padding: 0;
          max-height: calc(100vh - 200px);
          overflow: auto;
        }
        .trace-session-list-head {
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
          position: sticky;
          top: 0;
          background: var(--bg-elevated);
          z-index: 1;
        }
        .trace-session-item {
          width: 100%;
          text-align: left;
          padding: 10px 12px;
          border: none;
          border-bottom: 1px solid var(--border);
          background: transparent;
          cursor: pointer;
          color: inherit;
          font: inherit;
        }
        .trace-session-item:hover { background: var(--bg-hover); }
        .trace-session-item.active { background: var(--accent-dim); }
        .trace-detail {
          min-height: 420px;
          padding: 14px 16px;
        }
        .trace-detail-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--border);
        }
        .trace-detail-head select,
        .trace-detail-head input {
          font-size: 0.85rem;
        }
        .trace-group {
          border: 1px solid var(--border);
          border-radius: var(--radius);
          margin-bottom: 16px;
          overflow: hidden;
        }
        .trace-group-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 14px;
          background: var(--bg-hover);
          border-bottom: 1px solid var(--border);
        }
        .trace-steps {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .trace-step {
          border-bottom: 1px solid var(--border);
        }
        .trace-step:last-child { border-bottom: none; }
        .trace-step-toggle {
          width: 100%;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
          text-align: left;
        }
        .trace-step-toggle:hover { background: var(--bg-hover); }
        .trace-step-idx {
          width: 1.5rem;
          height: 1.5rem;
          border-radius: 999px;
          background: var(--accent-dim);
          color: var(--accent);
          font-size: 0.75rem;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .trace-step-name { font-weight: 600; font-size: 0.88rem; }
        .trace-step-meta { margin-left: auto; font-size: 0.75rem; }
        .trace-step-body {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          padding: 0 14px 14px;
        }
        @media (max-width: 800px) {
          .trace-step-body { grid-template-columns: 1fr; }
        }
        .trace-io {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 10px 12px;
          min-height: 80px;
        }
        .trace-chat { display: flex; flex-direction: column; gap: 8px; }
        .trace-chat-msg {
          border-radius: 10px;
          padding: 8px 10px;
          border: 1px solid var(--border);
        }
        .trace-chat-msg.user {
          background: var(--accent-dim);
          border-color: rgba(124, 92, 252, 0.25);
        }
        .trace-chat-msg.system {
          background: var(--bg-hover);
          opacity: 0.95;
        }
        .trace-chat-msg.assistant {
          background: rgba(45, 212, 191, 0.08);
          border-color: rgba(45, 212, 191, 0.2);
        }
        .trace-chat-msg.tool {
          background: rgba(251, 191, 36, 0.08);
          border-color: rgba(251, 191, 36, 0.2);
        }
        .trace-chat-role {
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
          margin-bottom: 4px;
        }
        .trace-chat-body {
          font-size: 0.84rem;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 420px;
          overflow: auto;
        }
        .trace-prose {
          font-size: 0.85rem;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 480px;
          overflow: auto;
        }
        .trace-pre, .trace-pre-sm {
          margin: 0;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          line-height: 1.4;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 360px;
          overflow: auto;
        }
        .trace-pre-sm { max-height: 160px; font-size: 10px; }
        .trace-findings { display: flex; flex-direction: column; gap: 8px; }
        .trace-finding-card {
          padding: 10px 12px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--border);
          background: var(--bg-elevated);
        }
      `}</style>
    </div>
  );
}
