import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { useToast } from "../components/Toast";
import {
  Badge,
  CopyId,
  Drawer,
  EmptyState,
  PageHero,
  StagePipeline,
  formatRelative,
  shortId,
} from "../components/ui";
import { Select } from "../components/Select";
import {
  api,
  downloadJson,
  type Finding,
  type FindingEvidence,
  type Job,
  type ProgressEvent,
  type ReviewUnit,
  type Session,
  type SessionAudit,
  type WorkerStatus,
} from "../lib/api";
import { RepoPicker } from "../components/RepoPicker";

/** Product brand is "Codesteward" (not CodeSteward). */
function normalizeBrand(text: string): string {
  return text.replace(/CodeSteward/g, "Codesteward");
}

interface TimelineEntry {
  id: string;
  ts: string;
  message: string;
  kind: "default" | "heal" | "error" | "evidence";
}

function isGraphOrEvidenceMessage(type: string, message: string, role?: string): boolean {
  const hay = `${type} ${message} ${role ?? ""}`.toLowerCase();
  return /graph|evidence|taint|referential|lexical|dependency|query|symbol|call.?chain|edge/.test(hay);
}

function formatEvidenceLine(ev: FindingEvidence): string {
  const parts = [ev.type];
  if (ev.summary) parts.push(ev.summary);
  else if (ev.artifactUri) parts.push(ev.artifactUri);
  return parts.filter(Boolean).join(" · ");
}

function formatDiscourseItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item ?? "");
  const o = item as Record<string, unknown>;
  const move = o.move ?? o.kind ?? o.type ?? o.action;
  const target = o.targetTitle ?? o.target ?? o.title ?? o.findingTitle;
  const rationale = o.rationale ?? o.message ?? o.note ?? o.body ?? o.text;
  return [move, target, rationale]
    .filter((x) => x != null && String(x).length)
    .map(String)
    .join(" · ");
}

function extractDiscourseTranscript(session: Session | null, units: ReviewUnit[]): string[] {
  const lines: string[] = [];
  if (!session) return lines;
  const meta = session.metadata ?? {};

  // Prefer full engine transcript (orchestrator writes discourseTranscript)
  const transcript = meta.discourseTranscript ?? meta.discourse_notes ?? meta.discourseNotesArray;
  if (Array.isArray(transcript)) {
    for (const item of transcript) {
      const line = formatDiscourseItem(item);
      if (line) lines.push(line);
    }
  }

  const discourse = meta.discourse;
  if (Array.isArray(discourse)) {
    for (const item of discourse) {
      const line = formatDiscourseItem(item);
      if (line) lines.push(line);
    }
  } else if (discourse && typeof discourse === "object" && lines.length === 0) {
    const o = discourse as Record<string, unknown>;
    if (Array.isArray(o.notes) && typeof o.notes[0] !== "number") {
      for (const n of o.notes) {
        const line = formatDiscourseItem(n);
        if (line) lines.push(line);
      }
    } else if (typeof o.transcript === "string") {
      lines.push(...o.transcript.split("\n").filter(Boolean));
    } else if (typeof o.summary === "string") {
      lines.push(o.summary);
    } else {
      // Summary stats object only
      const stats = [
        o.passACount != null ? `passA=${o.passACount}` : null,
        o.passBCount != null ? `passB=${o.passBCount}` : null,
        o.surfacedCount != null ? `surfaced=${o.surfacedCount}` : null,
        o.droppedByChallenge != null ? `challenged=${o.droppedByChallenge}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (stats) lines.push(`Discourse summary: ${stats}`);
    }
  }

  if (typeof meta.discourseNotes === "number" && lines.length === 0) {
    lines.push(`${meta.discourseNotes} discourse note${meta.discourseNotes === 1 ? "" : "s"} recorded`);
  }

  for (const u of units) {
    const notes = u.discourseNotes ?? (u.metadata?.discourseNotes as unknown);
    if (Array.isArray(notes)) {
      for (const n of notes) {
        if (typeof n === "string") lines.push(`[${u.label}] ${n}`);
        else if (n && typeof n === "object") {
          const note = n as Record<string, unknown>;
          lines.push(
            `[${u.label}] ${[note.move, note.targetTitle, note.rationale]
              .filter((x) => x != null && String(x).length)
              .map(String)
              .join(" · ")}`,
          );
        }
      }
    }
    if (typeof u.metadata?.discourse === "string") {
      lines.push(`[${u.label}] ${u.metadata.discourse}`);
    }
  }

  return lines;
}

function modeFromParam(raw: string | null): "gate" | "stewardship" {
  if (!raw) return "gate";
  if (raw === "steward" || raw === "stewardship") return "stewardship";
  return "gate";
}

/** Matches packages/agents planner rolesForTier — keep UI copy in sync. */
const RISK_TIER_INFO: Record<
  string,
  { label: string; summary: string; specialists: string; extras: string }
> = {
  trivial: {
    label: "trivial — single generalist",
    summary: "Fastest, cheapest pass. One generalist agent only — good for docs/typo-level or smoke checks.",
    specialists: "generalist",
    extras: "No multi-specialist fan-out; not for security-sensitive merges.",
  },
  lite: {
    label: "lite — generalist + rules",
    summary: "Light review: general findings plus path/policy rules. Use for small, low-risk PRs.",
    specialists: "generalist, rules",
    extras: "Still no dedicated security/correctness specialists.",
  },
  full: {
    label: "full — standard multi-specialist",
    summary: "Default balanced review: correctness, security, rules, and testing specialists.",
    specialists: "correctness, security, rules, testing",
    extras: "Usual choice for normal product PRs and stewardship audits.",
  },
  security: {
    label: "security — security-focused set",
    summary:
      "Same specialist set as full (correctness, security, rules, testing), oriented for security-sensitive changes. Prefer when the change touches auth, crypto, data planes, or untrusted input.",
    specialists: "correctness, security, rules, testing",
    extras: "Graph/taint grounding is used more aggressively on security/correctness paths; not a separate lighter stack.",
  },
  thorough: {
    label: "thorough — deepest + discourse",
    summary:
      "Maximum depth: more specialist roles, dual-correctness discourse (AGREE/CHALLENGE/CONNECT/SURFACE). Requires Pro or Enterprise plan (thorough discourse entitlement).",
    specialists: "correctness, security, performance, testing, rules, requirements, discourse",
    extras: "Slowest/costliest. Use for critical paths, regulated releases, or when you need the full audit trail.",
  },
};

export function Sessions() {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const fromQuery =
      searchParams.get("sessionId") ?? searchParams.get("id") ?? searchParams.get("session");
    if (fromQuery) return fromQuery;
    const st = location.state as { openSessionId?: string } | null;
    return st?.openSessionId ?? null;
  });
  const [detail, setDetail] = useState<Session | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [units, setUnits] = useState<ReviewUnit[]>([]);
  const [sessionFindings, setSessionFindings] = useState<Finding[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [stuckWarning, setStuckWarning] = useState(false);
  const startWatch = useRef<{ id: string; stage: string; at: number } | null>(null);

  // Start form — mode/pr/repoId seeded from query (nav: Gate / Steward, PRs page)
  const [repoId, setRepoId] = useState(() => searchParams.get("repoId") ?? "codesteward");
  const [repoPath, setRepoPath] = useState("");
  const [riskTier, setRiskTier] = useState("full");
  const [mode, setMode] = useState<"gate" | "stewardship">(() => modeFromParam(searchParams.get("mode")));
  const [paths, setPaths] = useState(".");
  const [prNumber, setPrNumber] = useState(() => searchParams.get("pr") ?? "");
  const [baseBranch, setBaseBranch] = useState(() => searchParams.get("base") ?? "main");
  const [headBranch, setHeadBranch] = useState(() => searchParams.get("head") ?? "");
  const [showForm, setShowForm] = useState(true);
  /** Plan entitlements — thorough requires thorough_discourse (Pro+) */
  const [allowThorough, setAllowThorough] = useState(true);
  const [planLabel, setPlanLabel] = useState<string | null>(null);

  useEffect(() => {
    setMode(modeFromParam(searchParams.get("mode")));
    const pr = searchParams.get("pr");
    if (pr) setPrNumber(pr);
    const rid = searchParams.get("repoId");
    if (rid) setRepoId(rid);
    // Deep-link from Reports / external links: open session drawer
    const openId =
      searchParams.get("sessionId") ??
      searchParams.get("id") ??
      searchParams.get("session") ??
      (location.state as { openSessionId?: string } | null)?.openSessionId;
    if (openId) {
      setSelectedId(openId);
      setShowForm(false);
    }
  }, [searchParams, location.state]);

  useEffect(() => {
    const refreshEntitlements = () => {
      void api
        .license()
        .then((r) => {
          const thorough =
            r.features?.find((f) => f.id === "thorough_discourse")?.enabled ??
            Boolean(r.license?.thoroughDiscourse);
          // When open mode / not enforced, featureMatrix still marks enabled; honor plan when billing is on
          const open = Boolean(r.openMode || r.license?.openMode);
          const ok = open || thorough;
          setAllowThorough(ok);
          setPlanLabel(r.plan?.id ?? r.license?.tier ?? null);
          if (!ok) {
            setRiskTier((cur) => (cur === "thorough" ? "full" : cur));
          }
        })
        .catch(() => {
          /* keep default; API will 402 if blocked */
        });
    };
    refreshEntitlements();
    window.addEventListener("cs:org-changed", refreshEntitlements);
    return () => window.removeEventListener("cs:org-changed", refreshEntitlements);
  }, []);

  const refresh = async () => {
    try {
      const [s, j] = await Promise.all([api.sessions(), api.jobs().catch(() => null)]);
      setSessions(s.sessions);
      if (j?.worker) setWorker(j.worker);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Aggressive polling while sessions may be queued
    const t = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setSessionFindings([]);
      return;
    }
    api
      .session(selectedId)
      .then((r) => {
        setDetail(r.session);
        // Always mirror server units (including status transitions) when present
        if (Array.isArray(r.session.units) && r.session.units.length) {
          setUnits(r.session.units);
        }
        const jobId = r.session.metadata?.jobId;
        if (typeof jobId === "string") setLastJobId(jobId);
      })
      .catch(() => setDetail(sessions.find((s) => s.id === selectedId) ?? null));
    api
      .sessionFindings(selectedId)
      .then((r) => setSessionFindings(r.findings))
      .catch(() => setSessionFindings([]));
  }, [selectedId, sessions]);

  // Stuck detection: pending + queued after 5s with no stage change
  useEffect(() => {
    const watch = startWatch.current;
    if (!watch) return;
    const s = sessions.find((x) => x.id === watch.id) ?? (detail?.id === watch.id ? detail : null);
    if (!s) return;
    if (s.stage !== "queued" && s.status !== "pending") {
      setStuckWarning(false);
      startWatch.current = null;
      return;
    }
    const elapsed = Date.now() - watch.at;
    if (elapsed >= 5000 && (s.status === "pending" || s.stage === "queued")) {
      setStuckWarning(true);
    }
  }, [sessions, detail]);

  useEffect(() => {
    if (!selectedId) return;
    setTimeline([]);
    setUnits([]);
    const es = new EventSource(api.eventsUrl(selectedId));
    /** Client-side dedupe: SSE reconnects replay backlog; ignore repeats. */
    const seen = new Set<string>();

    const eventDedupeKey = (
      type: string,
      parsed: ProgressEvent | null,
      data: string,
      lastEventId?: string,
    ): string => {
      if (lastEventId) return `sse:${lastEventId}`;
      if (parsed) {
        return [
          parsed.type ?? type,
          parsed.ts ?? "",
          parsed.unitId ?? "",
          parsed.stage ?? "",
          parsed.status ?? "",
          parsed.role ?? "",
          (parsed.message ?? "").slice(0, 120),
          parsed.finding?.id ?? "",
          parsed.findingCount != null ? String(parsed.findingCount) : "",
        ].join("|");
      }
      return `${type}|${data.slice(0, 160)}`;
    };

    const push = (
      message: string,
      kind: TimelineEntry["kind"] = "default",
      ts?: string,
      dedupeKey?: string,
    ) => {
      const text = (message ?? "").trim();
      if (!text || text === "undefined" || text === "null") return;
      // Collapse "error: undefined" / empty noise
      if (/^error:\s*(undefined|null)?$/i.test(text)) return;
      const key = dedupeKey ?? `${ts ?? ""}|${kind}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Cap seen set growth
      if (seen.size > 400) {
        const drop = [...seen].slice(0, 100);
        for (const k of drop) seen.delete(k);
      }
      setTimeline((prev) => [
        ...prev.slice(-120),
        {
          id: key,
          ts: ts ?? new Date().toISOString(),
          message: text,
          kind,
        },
      ]);
    };

    const onEv = (type: string, data: string, lastEventId?: string) => {
      if (data == null || data === "" || data === "undefined") {
        // Named event with empty payload — ignore (was rendering as "error: undefined")
        return;
      }
      let parsed: ProgressEvent | null = null;
      try {
        const raw = JSON.parse(data) as ProgressEvent | null;
        if (!raw || typeof raw !== "object") return;
        parsed = raw;
      } catch {
        const kind =
          type === "error" || /error/i.test(data)
            ? "error"
            : isGraphOrEvidenceMessage(type, data)
              ? "evidence"
              : "default";
        const safe = typeof data === "string" ? data : String(data ?? "");
        if (!safe || safe === "undefined") return;
        push(type && type !== "message" ? `${type}: ${safe}` : safe, kind, undefined, eventDedupeKey(type, null, safe, lastEventId));
        return;
      }
      const evType = parsed.type || type;
      const ts = parsed.ts ?? new Date().toISOString();
      const dkey = eventDedupeKey(evType, parsed, data, lastEventId);

      if (evType === "stage") {
        const msg = `Stage → ${parsed.stage ?? "?"}${parsed.message ? `: ${parsed.message}` : ""}`;
        const kind =
          isGraphOrEvidenceMessage(evType, msg) || /discourse|evidence|graph/i.test(parsed.stage ?? "")
            ? "evidence"
            : "default";
        push(msg, kind, ts, dkey);
        if (parsed.stage) {
          setDetail((d) => (d ? { ...d, stage: parsed!.stage! } : d));
          setStuckWarning(false);
        }
      } else if (evType === "unit") {
        push(
          `Unit ${parsed.label ?? parsed.unitId ?? "?"}: ${parsed.status ?? "unknown"}`,
          "default",
          ts,
          dkey,
        );
        if (parsed.unitId) {
          setUnits((prev) => {
            const next = [...prev];
            const i = next.findIndex((u) => u.id === parsed!.unitId);
            const row: ReviewUnit = {
              id: parsed.unitId!,
              label: parsed.label ?? parsed.unitId!,
              status: (parsed.status as ReviewUnit["status"]) ?? "running",
            };
            if (i >= 0) next[i] = { ...next[i], ...row };
            else next.push(row);
            return next;
          });
        }
      } else if (evType === "agent") {
        const heal =
          parsed.role === "prove" ||
          parsed.role === "verifier" ||
          /heal|fix|retry/i.test(parsed.message ?? "");
        const msg = `Agent ${parsed.role ?? "?"} ${parsed.status ?? ""}${parsed.message ? ` — ${parsed.message}` : ""}`.trim();
        const kind: TimelineEntry["kind"] = heal
          ? "heal"
          : isGraphOrEvidenceMessage(evType, msg, parsed.role) ||
              parsed.role === "evidence" ||
              parsed.role === "discourse"
            ? "evidence"
            : "default";
        push(msg, kind, ts, dkey);
      } else if (evType === "finding") {
        push(`Finding: ${parsed.finding?.title ?? "untitled"}`, "default", ts, dkey);
        if (parsed.finding) {
          setSessionFindings((prev) => {
            if (prev.some((f) => f.id === parsed!.finding!.id)) return prev;
            return [...prev, parsed!.finding!];
          });
        }
      } else if (evType === "completed") {
        push(
          `Completed · ${parsed.status ?? "done"} · ${parsed.findingCount ?? "?"} findings`,
          parsed.status === "failed" ? "error" : "heal",
          ts,
          dkey,
        );
        void refresh();
        if (selectedId) {
          void api.sessionFindings(selectedId).then((r) => setSessionFindings(r.findings)).catch(() => undefined);
        }
      } else if (evType === "error") {
        const msg =
          (typeof parsed.message === "string" && parsed.message.trim()) ||
          "Review error (no details)";
        push(msg, "error", ts, dkey);
      } else if (evType === "log") {
        const body =
          (typeof parsed.message === "string" && parsed.message.trim()) ||
          "log event";
        const msg = `[${parsed.level ?? "info"}] ${body}`;
        const kind: TimelineEntry["kind"] =
          parsed.level === "error"
            ? "error"
            : isGraphOrEvidenceMessage(evType, msg)
              ? "evidence"
              : "default";
        push(msg, kind, ts, dkey);
      } else if (evType === "healing") {
        const strategy =
          (parsed as ProgressEvent & { strategy?: string }).strategy ?? "heal";
        const msg =
          (typeof parsed.message === "string" && parsed.message.trim()) ||
          `Healing: ${strategy}`;
        push(msg, "heal", ts, dkey);
      } else if (evType === "retry") {
        const attempt = (parsed as ProgressEvent & { attempt?: number }).attempt;
        const msg =
          (typeof parsed.message === "string" && parsed.message.trim()) ||
          `Retrying unit${attempt != null ? ` (attempt ${attempt})` : ""}`;
        push(msg, "heal", ts, dkey);
      } else if (evType === "unit_recovered") {
        const strategy =
          (parsed as ProgressEvent & { strategy?: string }).strategy ?? "recovered";
        push(
          `Unit recovered: ${parsed.label ?? parsed.unitId ?? "?"} via ${strategy}`,
          "heal",
          ts,
          dkey,
        );
      } else if (evType === "token_usage") {
        // Too noisy for the healing timeline — skip
        return;
      } else if (evType === "message") {
        // Default SSE channel: use parsed type if present
        const msg =
          (typeof parsed.message === "string" && parsed.message.trim()) ||
          `${parsed.type ?? "event"}`;
        push(msg, "default", ts, dkey);
      } else {
        const msg =
          (typeof parsed.message === "string" && parsed.message.trim()) ||
          `${evType} event`;
        push(msg, isGraphOrEvidenceMessage(evType, msg) ? "evidence" : "default", ts, dkey);
      }
    };

    const handle = (type: string) => (ev: Event) => {
      const me = ev as MessageEvent;
      onEv(type, typeof me.data === "string" ? me.data : String(me.data ?? ""), me.lastEventId || undefined);
    };

    // Do NOT also use onmessage for named events — that double-fires some proxies.
    // Only listen for known types; default "message" covers untyped frames.
    es.addEventListener("message", handle("message"));
    for (const t of [
      "stage",
      "unit",
      "agent",
      "finding",
      "completed",
      "error",
      "log",
      "token_usage",
      "healing",
      "retry",
      "unit_recovered",
    ]) {
      es.addEventListener(t, handle(t));
    }
    es.onerror = () => {
      /* EventSource auto-reconnects; server uses Last-Event-ID + client dedupe */
    };
    return () => es.close();
  }, [selectedId]);

  async function start() {
    setBusy(true);
    setStuckWarning(false);
    try {
      if (mode === "gate") {
        const n = Number(prNumber.trim());
        if (!prNumber.trim() || !Number.isFinite(n) || n < 1) {
          toast.error(
            "Gate requires a PR number — it only reviews pull-request diffs. Use Stewardship to audit a single branch, or open a PR to compare branches.",
          );
          setBusy(false);
          return;
        }
      }
      if (mode === "stewardship" && prNumber.trim()) {
        toast.error(
          "Stewardship does not take a PR. Switch to Gate after opening a PR, or clear the PR field for a branch audit.",
        );
        setBusy(false);
        return;
      }
      if (riskTier === "thorough" && !allowThorough) {
        toast.error(
          `Thorough (dual-pass discourse) requires a Pro or Enterprise plan${planLabel ? ` (current: ${planLabel})` : ""}. Upgrade under Billing.`,
        );
        setBusy(false);
        return;
      }
      const pathList = paths
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        repoId,
        riskTier,
        paths: pathList.length ? pathList : ["."],
      };
      if (repoPath.trim()) body.repoPath = repoPath.trim();
      if (mode === "gate") {
        // Gate = PR only; base/head come from the PR on the worker — do not send free-form branch pairs
        body.prNumber = Number(prNumber.trim());
      } else {
        // Stewardship = single branch tip (no PR, no branch-range compare)
        const branch = (headBranch.trim() || baseBranch.trim() || "main");
        body.headBranch = branch;
        body.baseBranch = branch;
      }
      const fn = mode === "gate" ? api.startGate : api.startSteward;
      const res = await fn(body);
      const job = res.job as Job;
      setSelectedId(res.session.id);
      setLastJobId(job?.id ?? (res.session.metadata?.jobId as string) ?? null);
      startWatch.current = {
        id: res.session.id,
        stage: res.session.stage,
        at: Date.now(),
      };
      toast.success(
        `Started ${mode} · ${res.session.id}${job?.id ? ` · job ${job.id}` : ""}`,
      );
      // Stuck check: only flag if still unclaimed after 8s; clear if already running
      window.setTimeout(() => {
        void api.session(res.session.id).then((r) => {
          const stillQueued =
            r.session.status === "pending" || r.session.stage === "queued";
          if (stillQueued) {
            setStuckWarning(true);
          } else {
            setStuckWarning(false);
          }
        });
      }, 8000);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await api.resumeSession(selectedId);
      setLastJobId(res.job?.id ?? null);
      toast.success(`Resumed · job ${res.job?.id ? shortId(res.job.id, 12) : "enqueued"}`);
      startWatch.current = { id: selectedId, stage: "queued", at: Date.now() };
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api.cancelSession(selectedId);
      toast.info("Session cancelled");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const unitProgress = useMemo(() => {
    if (!units.length) return 0;
    // Weight so a long-running single unit is not stuck at 0% forever.
    // completed/skipped = full, running = partial, failed/pending = none.
    const weight = (status: string) => {
      if (status === "completed" || status === "skipped") return 1;
      if (status === "running") return 0.45;
      if (status === "failed") return 0.15;
      return 0;
    };
    const sum = units.reduce((acc, u) => acc + weight(u.status), 0);
    return Math.min(100, Math.round((sum / units.length) * 100));
  }, [units]);

  const selected = detail ?? sessions.find((s) => s.id === selectedId) ?? null;
  // "No worker" only when queue will not drain: inline disabled AND unhealthy external,
  // or a session stuck in queued/pending after claim timeout.
  const workerMissing =
    Boolean(worker) &&
    worker!.healthy === false &&
    (worker!.mode === "external" || worker!.enabled === false);
  const sessionStuckWaiting =
    Boolean(selected?.metadata?.waitingForWorker) &&
    (selected?.status === "pending" || selected?.stage === "queued");
  const waitingWorker = stuckWarning || sessionStuckWaiting || workerMissing;

  const evidenceItems = useMemo(() => {
    const items: { key: string; title: string; detail: string; source: string }[] = [];
    for (const f of sessionFindings) {
      for (const ev of f.evidence ?? []) {
        items.push({
          key: `${f.id}:${ev.id}`,
          title: f.title,
          detail: formatEvidenceLine(ev),
          source: "finding",
        });
      }
    }
    const gq = selected?.metadata?.graphQueries;
    if (Array.isArray(gq)) {
      gq.forEach((q, i) => {
        if (typeof q === "string") {
          items.push({ key: `gq-${i}`, title: "Graph query", detail: q, source: "session" });
        } else if (q && typeof q === "object") {
          const o = q as Record<string, unknown>;
          items.push({
            key: `gq-${i}`,
            title: String(o.type ?? o.query_type ?? o.name ?? "Graph query"),
            detail: String(o.query ?? o.summary ?? o.message ?? JSON.stringify(o).slice(0, 160)),
            source: "session",
          });
        }
      });
    }
    return items;
  }, [sessionFindings, selected]);

  const discourseLines = useMemo(
    () => extractDiscourseTranscript(selected, units),
    [selected, units],
  );

  const evidenceEvents = useMemo(
    () => timeline.filter((e) => e.kind === "evidence"),
    [timeline],
  );

  return (
    <div>
      <PageHero
        kicker="Live process"
        title="Sessions"
        subtitle="Gate and stewardship runs with stage pipeline, unit progress, and healing timeline."
        actions={
          <div className="row">
            {worker && (
              <span title={worker.hint ?? undefined}>
                <Badge
                  tone={
                    worker.healthy === false || worker.enabled === false
                      ? "failed"
                      : "ok"
                  }
                >
                  {worker.mode === "external"
                    ? worker.healthy === false
                      ? "no worker"
                      : "external worker"
                    : worker.running
                      ? "inline worker"
                      : "no worker"}
                </Badge>
              </span>
            )}
            <button type="button" className="sm" onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Hide form" : "New review"}
            </button>
          </div>
        }
      />

      <details className="card" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.9rem" }}>
          Gate vs stewardship (hard split) · risk tiers · repo path vs paths
        </summary>
        <div
          className="stack"
          style={{ gap: 10, marginTop: 10, fontSize: "0.85rem", lineHeight: 1.55, color: "var(--text-secondary)" }}
        >
          <div>
            <strong style={{ color: "var(--text)" }}>Gate</strong> is{" "}
            <em>PR-only</em>: it reviews the <strong>pull-request diff</strong> (base…head from
            the PR) as a merge check. <strong>PR number is required</strong> — no free-form
            branch pair. Base and head come from SCM for that PR.
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>Stewardship</strong> is a{" "}
            <em>single branch / repo audit</em> (tip of one branch).{" "}
            <strong>No PR field</strong> and no branch-range compare. To compare two branches,
            open a PR and run <strong>Gate</strong> — that is the supported path.
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>Risk tier</strong> chooses{" "}
            <em>how deep</em> the review goes (which specialist agents run). It is independent
            of gate vs stewardship — both modes use the same tiers.
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {(Object.entries(RISK_TIER_INFO) as Array<[string, (typeof RISK_TIER_INFO)[string]]>).map(
              ([key, info]) => (
                <li key={key} style={{ marginBottom: 6 }}>
                  <strong style={{ color: "var(--text)" }} className="mono">
                    {key}
                  </strong>
                  {" — "}
                  {info.summary}{" "}
                  <span className="mono muted" style={{ fontSize: "0.78rem" }}>
                    ({info.specialists})
                  </span>
                  {info.extras ? (
                    <>
                      {" "}
                      <span className="muted" style={{ fontSize: "0.8rem" }}>
                        {info.extras}
                      </span>
                    </>
                  ) : null}
                </li>
              ),
            )}
          </ul>
          <div>
            <strong style={{ color: "var(--text)" }}>Repository (repo ID)</strong> is the{" "}
            <em>logical</em> identity of the project (e.g.{" "}
            <span className="mono">owner/name</span>) for SCM, learning, and findings. It is
            not a filesystem path.
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>Repo path</strong> is the{" "}
            <em>on-disk workspace root</em> the worker uses when it does not clone (or as a
            fallback): absolute path or mount like{" "}
            <span className="mono">/repos/project</span>. Empty → server{" "}
            <span className="mono">REPO_PATH</span> / process cwd. With{" "}
            <span className="mono">STEW_WORKSPACE_CLONE=1</span> and credentials, the worker
            usually clones into{" "}
            <span className="mono">/data/workspaces/&lt;session&gt;</span> and ignores this
            for the real tree.
          </div>
          <div>
            <strong style={{ color: "var(--text)" }}>Paths</strong> are{" "}
            <em>relative scopes inside that tree</em> (comma-separated), e.g.{" "}
            <span className="mono">packages/api</span>,{" "}
            <span className="mono">src/auth</span>. Default{" "}
            <span className="mono">.</span> = whole repo (subject to token budget). Gate mainly
            uses the PR diff; paths can further focus units. Stewardship uses paths over the
            branch tip.
          </div>
          <div className="muted" style={{ fontSize: "0.8rem" }}>
            <strong>Repo path</strong> = where code lives on disk.{" "}
            <strong>Paths</strong> = which subtrees inside it to focus.{" "}
            <strong>Mode</strong> = hard split: PR gate vs branch stewardship.{" "}
            <strong>Risk tier</strong> = specialist depth. Write-ups:{" "}
            <a href="/reports">Reports</a>.
          </div>
        </div>
      </details>

      {waitingWorker && (
        <div className="banner warn" role="alert">
          <strong>Job queued but not claimed</strong>
          <span>
            {worker?.mode === "external" ? (
              <>
                API uses dedicated workers (<span className="mono">STEW_INLINE_WORKER=0</span>
                ). Ensure the worker container is up (
                <span className="mono">docker compose … worker</span>
                ) — the API process will not claim jobs.{" "}
              </>
            ) : (
              <>
                Ensure a worker is running:{" "}
                <span className="mono">pnpm dev:worker</span> or set{" "}
                <span className="mono">STEW_INLINE_WORKER=1</span>.{" "}
              </>
            )}
            {lastJobId ? (
              <>
                Job id: <span className="mono">{lastJobId}</span>
              </>
            ) : null}
          </span>
        </div>
      )}

      {showForm && (
        <div className="card stack" style={{ marginBottom: "1rem" }}>
          <div className="card-header">
            <h3>Start review</h3>
            <Badge tone={mode}>{mode}</Badge>
          </div>
          <div className="grid cols-3">
            <div className="field" style={{ margin: 0 }}>
              <label>Repository</label>
              <RepoPicker
                value={repoId}
                onChange={(p) => {
                  setRepoId(p.repoId);
                  if ("fullName" in p && p.fullName) setRepoId(p.fullName);
                }}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label title="Filesystem root on the worker when not cloning (mount). Empty → REPO_PATH env.">
                Repo path (workspace root)
              </label>
              <input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="optional — e.g. /repos/project (empty → REPO_PATH)"
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label title="Controls which specialist agents run and how deep the review goes">
                Risk tier
              </label>
              <Select
                value={riskTier}
                onChange={(v) => {
                  if (v === "thorough" && !allowThorough) {
                    toast.error(
                      `Thorough requires Pro/Enterprise${planLabel ? ` (current plan: ${planLabel})` : ""}. Open Billing to upgrade.`,
                    );
                    return;
                  }
                  setRiskTier(v);
                }}
                aria-label="Risk tier"
                options={(Object.keys(RISK_TIER_INFO) as Array<keyof typeof RISK_TIER_INFO>).map(
                  (k) => ({
                    value: k,
                    label:
                      k === "thorough" && !allowThorough
                        ? `${RISK_TIER_INFO[k].label} (Pro+)`
                        : RISK_TIER_INFO[k].label,
                    disabled: k === "thorough" && !allowThorough,
                    text: RISK_TIER_INFO[k].label,
                  }),
                )}
              />
              {RISK_TIER_INFO[riskTier] && (
                <p
                  className="muted"
                  style={{ fontSize: "0.75rem", margin: "0.35rem 0 0", lineHeight: 1.45 }}
                >
                  {RISK_TIER_INFO[riskTier].summary}{" "}
                  <span className="mono">Specialists: {RISK_TIER_INFO[riskTier].specialists}</span>
                </p>
              )}
              {!allowThorough && (
                <p
                  className="muted"
                  style={{ fontSize: "0.75rem", margin: "0.35rem 0 0", lineHeight: 1.45 }}
                >
                  Thorough / dual-pass discourse is a <strong>Pro+</strong> feature
                  {planLabel ? ` (your plan: ${planLabel})` : ""}. Upgrade under{" "}
                  <span className="mono">Billing</span>.
                </p>
              )}
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Mode</label>
              <Select
                value={mode}
                onChange={(v) => {
                  const next = v as "gate" | "stewardship";
                  setMode(next);
                  // Hard split: clear fields that do not belong to the other mode
                  if (next === "gate") {
                    setHeadBranch("");
                    setBaseBranch("main");
                  } else {
                    setPrNumber("");
                    if (!headBranch.trim()) setHeadBranch(baseBranch.trim() || "main");
                  }
                }}
                aria-label="Review mode"
                options={[
                  { value: "gate", label: "gate — PR merge check only" },
                  { value: "stewardship", label: "stewardship — single branch audit" },
                ]}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label title="Relative paths inside the repo to review (not the workspace root)">
                Paths (scope inside repo)
              </label>
              <input
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                placeholder=".  or  packages/api,src/auth"
              />
            </div>
            {mode === "gate" ? (
              <div className="field" style={{ margin: 0 }}>
                <label>
                  PR number{" "}
                  <span style={{ color: "var(--danger)" }}>(required)</span>
                </label>
                <input
                  value={prNumber}
                  onChange={(e) => setPrNumber(e.target.value)}
                  placeholder="e.g. 42 — base…head come from the PR"
                  inputMode="numeric"
                  required
                  aria-required
                />
                <p className="muted" style={{ fontSize: "0.72rem", margin: "0.3rem 0 0", lineHeight: 1.4 }}>
                  Gate is PR-only. To compare two branches, open a PR first — free-form base/head is not supported here.
                </p>
              </div>
            ) : (
              <div className="field" style={{ margin: 0 }}>
                <label title="Single branch tip to clone and audit (not a PR range)">
                  Branch to audit
                </label>
                <input
                  value={headBranch || baseBranch}
                  onChange={(e) => {
                    setHeadBranch(e.target.value);
                    setBaseBranch(e.target.value);
                  }}
                  placeholder="main"
                  list="cs-common-branches"
                />
                <datalist id="cs-common-branches">
                  <option value="main" />
                  <option value="master" />
                  <option value="develop" />
                  <option value="trunk" />
                </datalist>
                <p className="muted" style={{ fontSize: "0.72rem", margin: "0.3rem 0 0", lineHeight: 1.4 }}>
                  Stewardship audits this one branch tip. No PR. Branch comparison requires a PR → Gate.
                </p>
              </div>
            )}
          </div>
          <p className="muted" style={{ fontSize: "0.78rem", margin: "0.35rem 0 0", lineHeight: 1.45 }}>
            {mode === "stewardship"
              ? "Stewardship: full branch/repo audit on one tip. PR field is unavailable by design."
              : "Gate: merge check on a PR diff only. Base and head are taken from the PR via SCM."}
          </p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !repoId.trim() ||
                (mode === "gate" && !prNumber.trim()) ||
                (mode === "stewardship" && !(headBranch.trim() || baseBranch.trim()))
              }
              onClick={() => void start()}
            >
              {busy ? "Starting…" : mode === "gate" ? "Start gate" : "Start stewardship"}
            </button>
            {lastJobId && (
              <span className="muted" style={{ fontSize: "0.8rem", display: "inline-flex", alignItems: "center", gap: 6 }}>
                last job <CopyId id={lastJobId} n={18} />
              </span>
            )}
          </div>
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="skeleton block" style={{ height: 200 }} />
        ) : sessions.length === 0 ? (
          <EmptyState
            title="No sessions"
            description="Kick off a gate review on a PR or a stewardship pass on a branch."
            action={
              <button type="button" className="primary sm" disabled={busy} onClick={() => void start()}>
                Start first gate
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID (click to copy)</th>
                  <th>Mode</th>
                  <th>Repo</th>
                  <th>Status</th>
                  <th>Stage</th>
                  <th>Risk</th>
                  <th>Job</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    className={`clickable${selectedId === s.id ? " selected" : ""}`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <CopyId id={s.id} n={18} />
                    </td>
                    <td>
                      <Badge tone={s.mode}>{s.mode}</Badge>
                    </td>
                    <td>{s.repoId}</td>
                    <td>
                      <Badge tone={s.status}>{s.status}</Badge>
                    </td>
                    <td className="muted">{s.stage}</td>
                    <td className="muted">{s.riskTier}</td>
                    <td className="mono muted" style={{ fontSize: "0.72rem" }}>
                      {typeof s.metadata?.jobId === "string" ? (
                        <CopyId id={s.metadata.jobId as string} n={12} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="muted">{formatRelative(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected ? `${selected.mode} · ${selected.id}` : ""}
        subtitle={
          selected
            ? `${selected.repoId} · ${selected.status}${lastJobId ? ` · job ${lastJobId}` : ""} · click IDs in table to copy`
            : undefined
        }
        footer={
          <>
            <button type="button" className="ghost" onClick={() => setSelectedId(null)}>
              Close
            </button>
            {selected && selected.status !== "running" && (
              <button type="button" className="primary" disabled={busy} onClick={() => void resume()}>
                Resume
              </button>
            )}
            {selected && selected.status === "running" && (
              <button type="button" className="danger" disabled={busy} onClick={() => void cancel()}>
                Cancel
              </button>
            )}
          </>
        }
      >
        {selected && (
          <div className="stack">
            {(selected.status === "pending" || selected.stage === "queued") &&
              (stuckWarning ||
                Boolean(selected.metadata?.waitingForWorker) ||
                workerMissing) && (
              <div className="banner warn" role="alert">
                Job queued but not claimed — ensure the worker container is running
                {worker?.mode === "external"
                  ? " (API uses STEW_INLINE_WORKER=0; only the worker service claims jobs)."
                  : "."}
              </div>
            )}

            {(selected.status === "failed" ||
              selected.error ||
              (selected.failureLog?.length ?? 0) > 0 ||
              selected.units?.some((u) => u.error)) && (
              <div
                className="banner warn"
                role="alert"
                style={{
                  borderColor: "rgba(248,113,113,0.45)",
                  background: "rgba(248,113,113,0.08)",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong>Why this session failed</strong>
                  <CopyId id={selected.id} n={22} />
                </div>
                {selected.error || selected.metadata?.failureSummary ? (
                  <pre
                    className="mono"
                    style={{
                      margin: "0.5rem 0 0",
                      whiteSpace: "pre-wrap",
                      fontSize: "0.75rem",
                      maxHeight: 140,
                      overflow: "auto",
                    }}
                  >
                    {String(selected.error || selected.metadata?.failureSummary)}
                  </pre>
                ) : null}
                {(selected.failureLog?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: "0.75rem", marginBottom: 6 }}>
                      Failure log ({selected.failureLog!.length} attempt
                      {selected.failureLog!.length === 1 ? "" : "s"})
                    </div>
                    <div className="stack" style={{ gap: 6, maxHeight: 220, overflow: "auto" }}>
                      {[...selected.failureLog!].reverse().map((f) => (
                        <div
                          key={f.id}
                          className="card"
                          style={{ margin: 0, padding: "0.5rem 0.65rem", background: "var(--bg-deep)" }}
                        >
                          <div className="row" style={{ gap: 8, flexWrap: "wrap", fontSize: "0.75rem" }}>
                            <Badge tone="error">#{f.attempt}</Badge>
                            {f.strategy && <Badge>{f.strategy}</Badge>}
                            {f.unitLabel && <span className="muted">{f.unitLabel}</span>}
                            <span className="muted">{formatRelative(f.ts)}</span>
                          </div>
                          <pre
                            className="mono"
                            style={{
                              margin: "0.35rem 0 0",
                              whiteSpace: "pre-wrap",
                              fontSize: "0.72rem",
                            }}
                          >
                            {f.error}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selected.units
                  ?.filter((u) => u.error)
                  .map((u) => (
                    <div key={u.id} style={{ marginTop: 8, fontSize: "0.78rem" }}>
                      <Badge tone={u.status}>{u.status}</Badge>{" "}
                      <strong>{u.label}</strong>
                      <pre
                        className="mono"
                        style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap", fontSize: "0.72rem" }}
                      >
                        {u.error}
                      </pre>
                    </div>
                  ))}
              </div>
            )}

            <div>
              <h3 className="card-title" style={{ marginBottom: 10 }}>
                Stage pipeline
              </h3>
              <StagePipeline
                stage={selected.stage}
                failed={selected.status === "failed" || selected.status === "cancelled"}
              />
            </div>

            <SessionReportPanel session={selected} findings={sessionFindings} />

            <ReviewAuditPanel session={selected} />

            <div>
              <div className="card-header" style={{ marginBottom: 8 }}>
                <h3 className="card-title">Unit progress</h3>
                <span className="muted mono">
                  {unitProgress}%
                  {units.length
                    ? ` · ${units.filter((u) => u.status === "completed" || u.status === "skipped").length}/${units.length} done` +
                      (units.some((u) => u.status === "running")
                        ? ` · ${units.filter((u) => u.status === "running").length} running`
                        : "")
                    : ""}
                </span>
              </div>
              <div className="progress-bar">
                <span style={{ width: `${unitProgress}%` }} />
              </div>
              {units.length === 0 ? (
                <p className="muted" style={{ marginTop: 10, fontSize: "0.85rem" }}>
                  Units appear as the planner shards the review.
                </p>
              ) : (
                <div className="unit-list" style={{ marginTop: 10 }}>
                  {units.map((u) => (
                    <div key={u.id} className="unit-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span className="label">{u.label}</span>
                        <Badge tone={u.status}>{u.status}</Badge>
                      </div>
                      {u.error && (
                        <pre
                          className="mono muted"
                          style={{ margin: 0, fontSize: "0.7rem", whiteSpace: "pre-wrap" }}
                        >
                          {u.error.slice(0, 500)}
                          {u.error.length > 500 ? "…" : ""}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="card-title" style={{ marginBottom: 10 }}>
                Events & healing timeline
              </h3>
              {timeline.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  Streaming progress events…
                </p>
              ) : (
                <div className="timeline">
                  {[...timeline].reverse().map((e) => (
                    <div key={e.id} className={`timeline-item ${e.kind}`}>
                      <div className="timeline-time">
                        {e.kind === "evidence" ? (
                          <Badge tone="ok">graph/evidence</Badge>
                        ) : null}{" "}
                        {formatRelative(e.ts)}
                      </div>
                      <div className="timeline-msg">{e.message}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="card-header" style={{ marginBottom: 8 }}>
                <h3 className="card-title">Evidence</h3>
                <span className="muted mono">{evidenceItems.length}</span>
              </div>
              {evidenceItems.length === 0 && evidenceEvents.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  Finding evidence and graph queries appear here when specialists attach proof.
                </p>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {evidenceItems.map((item) => (
                    <div
                      key={item.key}
                      className="card"
                      style={{ margin: 0, background: "var(--bg-deep)", padding: "0.65rem 0.85rem" }}
                    >
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <Badge>{item.source}</Badge>
                        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{item.title}</span>
                      </div>
                      <div className="mono muted" style={{ marginTop: 4, fontSize: "0.75rem" }}>
                        {item.detail}
                      </div>
                    </div>
                  ))}
                  {evidenceEvents.length > 0 && (
                    <div className="muted" style={{ fontSize: "0.78rem" }}>
                      {evidenceEvents.length} graph/evidence event
                      {evidenceEvents.length === 1 ? "" : "s"} in live stream
                      {evidenceItems.length === 0 ? " (see timeline above)" : ""}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="card-header" style={{ marginBottom: 8 }}>
                <h3 className="card-title">Discourse</h3>
                {typeof selected.metadata?.discourseNotes === "number" && (
                  <span className="muted mono">{selected.metadata.discourseNotes as number} notes</span>
                )}
              </div>
              {discourseLines.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  Thorough mode dual-correctness AGREE/CHALLENGE/CONNECT/SURFACE transcript appears
                  here when discourse runs.
                </p>
              ) : (
                <div className="timeline">
                  {discourseLines.map((line, i) => (
                    <div key={`d-${i}`} className="timeline-item heal">
                      <div className="timeline-msg">{line}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selected.tokenUsage &&
              (selected.tokenUsage.totalTokens > 0 ||
                (selected.tokenUsage.promptTokens ?? 0) +
                  (selected.tokenUsage.completionTokens ?? 0) >
                  0) && (
              <div className="card glass">
                <h3>Token usage</h3>
                <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.8rem" }}>
                  Whole session — all specialist / judge / discourse / prove LLM calls combined
                  (input + output tracked separately when the provider reports them).
                </p>
                <div className="mono" style={{ marginTop: 10, fontSize: "0.9rem" }}>
                  <strong>{selected.tokenUsage.totalTokens.toLocaleString()}</strong>
                  <span className="muted"> total tokens</span>
                </div>
                <div className="mono muted" style={{ marginTop: 4, fontSize: "0.85rem" }}>
                  {(selected.tokenUsage.promptTokens ?? 0).toLocaleString()} prompt (input) ·{" "}
                  {(selected.tokenUsage.completionTokens ?? 0).toLocaleString()} completion
                  (output)
                  {typeof selected.tokenUsage.calls === "number" && selected.tokenUsage.calls > 0
                    ? ` · ${selected.tokenUsage.calls} call${selected.tokenUsage.calls === 1 ? "" : "s"}`
                    : ""}
                </div>
                {typeof selected.tokenUsage.costUsd === "number" &&
                  Number.isFinite(selected.tokenUsage.costUsd) && (
                    <div style={{ marginTop: 10 }}>
                      <div className="mono" style={{ fontSize: "0.95rem" }}>
                        <strong>
                          {selected.tokenUsage.costUsd < 0.01 && selected.tokenUsage.costUsd > 0
                            ? `$${selected.tokenUsage.costUsd.toFixed(4)}`
                            : `$${selected.tokenUsage.costUsd.toFixed(2)}`}
                        </strong>
                        <span className="muted">
                          {" "}
                          est. cost
                          {selected.tokenUsage.costEstimated !== false ? " (list price)" : ""}
                        </span>
                      </div>
                      <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.75rem" }}>
                        Estimate from published list prices for the models used — not an invoice.
                        Org negotiated rates may differ.
                      </p>
                    </div>
                  )}
                {selected.tokenUsage.byModel &&
                  Object.keys(selected.tokenUsage.byModel).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="muted" style={{ fontSize: "0.75rem", marginBottom: 4 }}>
                        By model
                      </div>
                      <div className="stack" style={{ gap: 4 }}>
                        {Object.entries(selected.tokenUsage.byModel).map(([model, row]) => (
                          <div
                            key={model}
                            className="mono muted"
                            style={{ fontSize: "0.75rem" }}
                          >
                            {model}: {row.totalTokens.toLocaleString()} tok
                            {typeof row.costUsd === "number"
                              ? ` · ~$${row.costUsd < 0.01 ? row.costUsd.toFixed(4) : row.costUsd.toFixed(2)}`
                              : ""}
                            {row.calls ? ` · ${row.calls}×` : ""}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function resolveSessionAudit(session: Session): SessionAudit | null {
  if (session.audit) return session.audit;
  const meta = session.metadata?.audit;
  if (meta && typeof meta === "object") return meta as SessionAudit;
  return null;
}

type SessionReportMeta = {
  markdown?: string;
  headline?: string;
  format?: string;
  generatedAt?: string;
  llmNarrative?: boolean;
  findingCount?: number;
  verdict?: string;
  severityCounts?: Record<string, number>;
};

function resolveSessionReport(session: Session): SessionReportMeta | null {
  const r = session.metadata?.report;
  if (r && typeof r === "object" && typeof (r as SessionReportMeta).markdown === "string") {
    return r as SessionReportMeta;
  }
  const headline = session.metadata?.reportHeadline;
  if (typeof headline === "string" && headline.trim()) {
    return { headline, markdown: undefined };
  }
  return null;
}

/** Human-readable end-of-run report (stewardship & gate). */
function SessionReportPanel({
  session,
  findings,
}: {
  session: Session;
  findings: Finding[];
}) {
  const report = resolveSessionReport(session);
  const finished =
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "cancelled" ||
    session.stage === "completed";

  if (!finished && !report) {
    return (
      <div>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Review report
        </h3>
        <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
          A human-readable report is generated when the session finishes (summary, scope, findings,
          next steps).
        </p>
      </div>
    );
  }

  if (!report?.markdown) {
    // Lightweight fallback for older sessions without stored report
    const counts = findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
    const countStr =
      Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "no findings";
    return (
      <div>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Review report
        </h3>
        <div className="card" style={{ margin: 0, background: "var(--bg-deep)", padding: "0.85rem 1rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
            {session.mode === "stewardship" ? "Stewardship" : "Gate"} of{" "}
            <strong className="mono">{session.repoId}</strong>
            {session.verdict ? (
              <>
                {" "}
                · verdict <Badge tone={session.verdict}>{session.verdict}</Badge>
              </>
            ) : null}
            . {findings.length} finding(s) ({countStr}). Re-run the review to capture a full markdown
            report with narrative and next steps.
          </p>
        </div>
      </div>
    );
  }

  const markdown = normalizeBrand(report.markdown!);
  const headline = report.headline ? normalizeBrand(report.headline) : undefined;

  const download = () => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codesteward-report-${session.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="card-header" style={{ marginBottom: 10 }}>
        <h3 className="card-title">Review report</h3>
        <div className="row" style={{ gap: 8 }}>
          {report.llmNarrative ? <Badge tone="ok">narrative</Badge> : <Badge>structured</Badge>}
          {report.verdict && <Badge tone={report.verdict}>{report.verdict}</Badge>}
          <button type="button" className="sm ghost" onClick={download}>
            Download .md
          </button>
          <button
            type="button"
            className="sm ghost"
            onClick={() => void downloadSessionAudit(session)}
          >
            Download audit JSON
          </button>
        </div>
      </div>
      {headline && (
        <p style={{ margin: "0 0 0.75rem", fontSize: "0.92rem", lineHeight: 1.45 }}>
          {headline}
        </p>
      )}
      <div
        className="card report-md"
        style={{
          margin: 0,
          background: "var(--bg-deep)",
          padding: "0.85rem 1.1rem",
          maxHeight: 480,
          overflow: "auto",
        }}
      >
        <ReactMarkdown
          components={{
            h1: ({ children }) => <h1 className="report-md-h1">{children}</h1>,
            h2: ({ children }) => <h2 className="report-md-h2">{children}</h2>,
            h3: ({ children }) => <h3 className="report-md-h3">{children}</h3>,
            p: ({ children }) => <p className="report-md-p">{children}</p>,
            ul: ({ children }) => <ul className="report-md-ul">{children}</ul>,
            ol: ({ children }) => <ol className="report-md-ol">{children}</ol>,
            li: ({ children }) => <li className="report-md-li">{children}</li>,
            strong: ({ children }) => <strong className="report-md-strong">{children}</strong>,
            em: ({ children }) => <em>{children}</em>,
            code: ({ children, className }) => {
              const inline = !className;
              if (inline) {
                return <code className="report-md-code-inline">{children}</code>;
              }
              return (
                <code className={`report-md-code-block ${className ?? ""}`}>{children}</code>
              );
            },
            pre: ({ children }) => <pre className="report-md-pre">{children}</pre>,
            hr: () => <hr className="report-md-hr" />,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer" className="report-md-a">
                {children}
              </a>
            ),
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}

async function downloadSessionAudit(
  session: Session,
  toast?: { success: (m: string) => void; error: (m: string) => void },
): Promise<void> {
  try {
    let audit = resolveSessionAudit(session);
    if (!audit) {
      const r = await api.sessionAudit(session.id);
      audit = r.audit;
    }
    if (!audit) {
      toast?.error(
        "No review audit for this session yet (older runs or incomplete worker). Re-run the review to generate one.",
      );
      return;
    }
    downloadJson(`codesteward-audit-${session.id}.json`, {
      exportedAt: new Date().toISOString(),
      sessionId: session.id,
      repoId: session.repoId,
      mode: session.mode,
      status: session.status,
      verdict: session.verdict,
      tokenUsage: session.tokenUsage,
      audit,
    });
    toast?.success("Audit JSON download started");
  } catch (err) {
    toast?.error(err instanceof Error ? err.message : String(err));
  }
}

/** Manager-readable provenance: what code was bound and which specialists ran. */
function ReviewAuditPanel({ session }: { session: Session }) {
  const toast = useToast();
  const audit = resolveSessionAudit(session);
  const [remote, setRemote] = useState<SessionAudit | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    if (audit) {
      setRemote(null);
      setHint(null);
      return;
    }
    let cancelled = false;
    api
      .sessionAudit(session.id)
      .then((r) => {
        if (cancelled) return;
        setRemote(r.audit);
        setHint(r.hint ?? null);
      })
      .catch(() => {
        if (!cancelled) setHint("Could not load audit");
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, audit]);

  const a = audit ?? remote;

  const onExport = async () => {
    setExportBusy(true);
    try {
      await downloadSessionAudit(session, toast);
    } finally {
      setExportBusy(false);
    }
  };

  if (!a) {
    return (
      <div>
        <div className="card-header" style={{ marginBottom: 10 }}>
          <h3 className="card-title">Review audit</h3>
          <button
            type="button"
            className="sm ghost"
            disabled={exportBusy}
            onClick={() => void onExport()}
          >
            {exportBusy ? "…" : "Download audit JSON"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
          {hint ??
            "No provenance for this session yet. New runs record code source, specialist runs, and a zero-findings rationale. You can still try Download audit JSON if the API has a stored payload."}
        </p>
      </div>
    );
  }

  const ctx = a.context;
  const sourceTone =
    ctx.source === "clone"
      ? "ok"
      : ctx.source === "unverified_mount"
        ? "failed"
        : ctx.source === "scm_diff"
          ? "running"
          : "info";

  return (
    <div>
      <div className="card-header" style={{ marginBottom: 10 }}>
        <h3 className="card-title">Review audit</h3>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={sourceTone}>{ctx.source.replace(/_/g, " ")}</Badge>
          <button
            type="button"
            className="sm ghost"
            disabled={exportBusy}
            onClick={() => void onExport()}
          >
            {exportBusy ? "…" : "Download audit JSON"}
          </button>
        </div>
      </div>

      <div className="card" style={{ margin: 0, background: "var(--bg-deep)", padding: "0.85rem 1rem" }}>
        <div className="stack" style={{ gap: 8 }}>
          <div>
            <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
              Code under review
            </div>
            <div style={{ fontSize: "0.88rem" }}>
              <strong className="mono">{ctx.repoId}</strong>
              {ctx.verified ? (
                <Badge tone="ok">verified</Badge>
              ) : (
                <Badge tone="warn">SHA not verified</Badge>
              )}
            </div>
            <div className="mono muted" style={{ fontSize: "0.72rem", marginTop: 4 }}>
              {[
                ctx.baseSha && ctx.headSha
                  ? `${shortId(ctx.baseSha, 10)}…${shortId(ctx.headSha, 10)}`
                  : ctx.verifiedSha
                    ? `HEAD ${shortId(ctx.verifiedSha, 12)}`
                    : null,
                ctx.repoPath,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {(ctx.notes?.length ?? 0) > 0 && (
              <ul className="muted" style={{ margin: "6px 0 0", paddingLeft: "1.1rem", fontSize: "0.78rem" }}>
                {ctx.notes!.slice(0, 6).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="row" style={{ gap: 12, flexWrap: "wrap", fontSize: "0.8rem" }}>
            <span>
              <strong>{ctx.pathsEffective?.length ?? ctx.pathsRequested?.length ?? 0}</strong>{" "}
              <span className="muted">paths</span>
            </span>
            <span>
              <strong>{ctx.filesIncluded?.length ?? 0}</strong>{" "}
              <span className="muted">files in context</span>
            </span>
            {ctx.estimatedTokens != null && (
              <span>
                <strong>~{ctx.estimatedTokens}</strong> <span className="muted">tokens</span>
                {ctx.truncated ? " · truncated" : ""}
              </span>
            )}
            {ctx.graph?.degraded && (
              <Badge tone="failed">graph degraded</Badge>
            )}
            {ctx.graph?.mock && <Badge tone="nit">graph mock</Badge>}
            {ctx.graph?.lastBuild && !ctx.graph.degraded && (
              <span className="muted mono" style={{ fontSize: "0.72rem" }}>
                graph {formatRelative(ctx.graph.lastBuild)}
              </span>
            )}
          </div>

          {a.zeroFindings && (
            <div
              className="banner warn"
              style={{ margin: 0, padding: "0.65rem 0.75rem" }}
              role="status"
            >
              <strong style={{ fontSize: "0.85rem" }}>{a.zeroFindings.message}</strong>
              {(a.zeroFindings.evidence?.length ?? 0) > 0 && (
                <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.78rem" }}>
                  {a.zeroFindings.evidence!.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div>
            <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 6 }}>
              Subagent ledger ({a.specialistRuns?.length ?? 0} steps)
            </div>
            {(a.specialistRuns?.length ?? 0) === 0 ? (
              <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
                No specialist runs recorded.
              </p>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {[...a.specialistRuns!]
                  .sort(
                    (x, y) =>
                      (x.stepIndex ?? 0) - (y.stepIndex ?? 0) ||
                      (x.startedAt ?? "").localeCompare(y.startedAt ?? ""),
                  )
                  .map((r, idx) => (
                  <div
                    key={r.id}
                    style={{
                      fontSize: "0.8rem",
                      padding: "0.5rem 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <div
                      className="row"
                      style={{
                        justifyContent: "space-between",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <span className="muted mono" style={{ fontSize: "0.68rem" }}>
                        #{(r.stepIndex ?? idx) + 1}
                      </span>
                      <Badge tone={r.status === "ok" ? "ok" : "failed"}>{r.role}</Badge>
                      {r.unitLabel && (
                        <span className="muted" style={{ fontSize: "0.75rem" }}>
                          {r.unitLabel}
                        </span>
                      )}
                      <span className="muted mono" style={{ fontSize: "0.7rem" }}>
                        {r.model ?? r.runner ?? "—"}
                      </span>
                      {r.usedGraph && <Badge tone="info">graph</Badge>}
                    </div>
                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <span>
                        <strong>{r.findingCount}</strong>{" "}
                        <span className="muted">findings</span>
                      </span>
                      {r.avgConfidence != null && (
                        <span className="muted">
                          conf {(r.avgConfidence * 100).toFixed(0)}%
                        </span>
                      )}
                      {r.durationMs != null && (
                        <span className="muted mono">
                          {(r.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                      {r.toolCallCount != null && r.toolCallCount > 0 && (
                        <span className="muted">{r.toolCallCount} tools</span>
                      )}
                    </div>
                    </div>
                    {(r.pathsReviewed?.length || r.filesReviewed?.length) && (
                      <div className="muted mono" style={{ fontSize: "0.68rem", marginTop: 4 }}>
                        {r.pathsReviewed?.length
                          ? `paths: ${r.pathsReviewed.slice(0, 4).join(", ")}${r.pathsReviewed.length > 4 ? "…" : ""}`
                          : null}
                        {r.filesReviewed?.length
                          ? ` · files: ${r.filesReviewed.length}`
                          : null}
                      </div>
                    )}
                    {(r.findingsSummary?.length ?? 0) > 0 && (
                      <ul
                        style={{
                          margin: "6px 0 0",
                          paddingLeft: "1.1rem",
                          fontSize: "0.72rem",
                        }}
                      >
                        {r.findingsSummary!.slice(0, 6).map((f, fi) => (
                          <li key={fi}>
                            <strong>[{(f.severity ?? "?").toUpperCase()}]</strong> {f.title}
                            {f.confidence != null
                              ? ` (${(f.confidence * 100).toFixed(0)}%)`
                              : ""}
                            {f.path ? (
                              <span className="muted mono">
                                {" "}
                                {f.path}
                                {f.startLine != null ? `:${f.startLine}` : ""}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.error && (
                      <pre
                        className="mono"
                        style={{
                          width: "100%",
                          margin: "4px 0 0",
                          fontSize: "0.7rem",
                          whiteSpace: "pre-wrap",
                          color: "var(--danger)",
                        }}
                      >
                        {r.error.slice(0, 300)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {(a.tools?.total ?? 0) > 0 && (
            <div>
              <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 6 }}>
                Tools · {a.tools!.total} call{a.tools!.total === 1 ? "" : "s"}
                {a.tools!.errors ? ` · ${a.tools!.errors} error(s)` : ""}
              </div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {Object.entries(a.tools!.byTool ?? {}).map(([k, n]) => (
                  <Badge key={k} tone="info">
                    {k} ×{n}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {a.judge && (
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              Judge: {a.judge.inputCount} in → {a.judge.outputCount} out
              {a.judge.sastCount != null ? ` · SAST ${a.judge.sastCount}` : ""}
              {a.judge.discourse?.ran ? ` · discourse notes ${a.judge.discourse.notes ?? 0}` : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
