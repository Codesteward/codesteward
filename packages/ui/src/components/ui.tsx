import type { ReactNode } from "react";

export function PageHero({
  kicker,
  title,
  subtitle,
  hero,
  actions,
}: {
  kicker?: string;
  title: string;
  subtitle?: string;
  hero?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header-row">
      <div className="page-hero">
        {kicker && <div className="page-hero-kicker">{kicker}</div>}
        <h2 className={`page-title${hero ? " hero" : ""}`}>{title}</h2>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function SkeletonLines({ lines = 4 }: { lines?: number }) {
  return (
    <div>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton line"
          style={{ width: `${70 + ((i * 17) % 30)}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card">
          <div className="skeleton line" style={{ width: "40%" }} />
          <div className="skeleton block" style={{ height: 40, marginTop: 12 }} />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = "◇",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <h4>{title}</h4>
      {description && <p>{description}</p>}
      {action && <div style={{ marginTop: "1rem" }}>{action}</div>}
    </div>
  );
}

/** Normalize status/mode strings into CSS class tokens (e.g. completed_with_errors → completed-with-errors). */
function badgeToneClass(tone?: string): string {
  if (!tone) return "";
  return tone
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function Badge({
  children,
  tone,
  className = "",
}: {
  children: ReactNode;
  tone?: string;
  className?: string;
}) {
  const toneClass = badgeToneClass(tone);
  return (
    <span className={`badge ${toneClass} ${className}`.trim()}>{children}</span>
  );
}

export function KpiCard({
  label,
  value,
  meta,
  trend,
  loading,
}: {
  label: string;
  value: ReactNode;
  meta?: string;
  trend?: { label: string; down?: boolean };
  loading?: boolean;
}) {
  return (
    <div className="card kpi">
      <h3>{label}</h3>
      {loading ? (
        <div className="skeleton block" style={{ height: 36, width: "50%" }} />
      ) : (
        <>
          <div className="kpi-value">{value}</div>
          {(meta || trend) && (
            <div className="kpi-meta row">
              {trend && (
                <span className={`kpi-trend${trend.down ? " down" : ""}`}>
                  {trend.down ? "↓" : "↑"} {trend.label}
                </span>
              )}
              {meta && <span>{meta}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden />
      <aside className="drawer" role="dialog" aria-modal aria-label={title}>
        <div className="drawer-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="muted" style={{ marginTop: 4, fontSize: "0.8rem" }}>{subtitle}</div>}
          </div>
          <button type="button" className="icon ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>
  );
}

export const STAGES = [
  "queued",
  "policy",
  "graph",
  "planning",
  "specialists",
  "verification",
  "discourse",
  "judge",
  "prove",
  "publish",
  "completed",
] as const;

/** Optional stages often skipped — dim unless they actually ran. */
const OPTIONAL_STAGES = new Set(["discourse", "prove", "publish"]);

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export type StagePipelineProps = {
  stage: string;
  failed?: boolean;
  /** Closed stage wall times (from audit.timings or live tracking). */
  durationsMs?: Record<string, number>;
  /**
   * When the current stage was entered (ISO or epoch ms).
   * Drives live elapsed under the active step.
   */
  activeEnteredAt?: string | number | null;
  /** Stages that actually started (SSE). Optional stages not listed are shown as skipped. */
  visitedStages?: string[];
  /** Force re-render for live elapsed (pass Date.now() from a 1s tick). */
  nowMs?: number;
};

export function StagePipeline({
  stage,
  failed,
  durationsMs,
  activeEnteredAt,
  visitedStages,
  nowMs,
}: StagePipelineProps) {
  const idx = STAGES.indexOf(stage as (typeof STAGES)[number]);
  const activeIdx =
    stage === "failed" || stage === "cancelled" ? -1 : idx >= 0 ? idx : 0;
  const visited = new Set(visitedStages ?? []);
  const now = nowMs ?? Date.now();

  let liveElapsed: string | null = null;
  if (activeEnteredAt != null && stage !== "completed" && stage !== "failed") {
    const t0 =
      typeof activeEnteredAt === "number"
        ? activeEnteredAt
        : Date.parse(String(activeEnteredAt));
    if (Number.isFinite(t0)) {
      liveElapsed = formatDurationMs(Math.max(0, now - t0));
    }
  }

  return (
    <div className="pipeline" role="list" aria-label="Review pipeline">
      {STAGES.map((s, i) => {
        const optional = OPTIONAL_STAGES.has(s);
        const wasVisited = visited.has(s) || Boolean(durationsMs?.[s]);
        const isSkippedOptional =
          optional &&
          !wasVisited &&
          (stage === "completed" || (activeIdx >= 0 && i < activeIdx));

        let cls = "";
        if (failed && (stage === "failed" || stage === "cancelled")) {
          cls = i === 0 ? "failed" : "";
        } else if (isSkippedOptional) {
          cls = "skipped";
        } else if (s === "completed" && stage === "completed") {
          cls = "done";
        } else if (i < activeIdx || stage === "completed") {
          cls = "done";
        } else if (i === activeIdx) {
          cls = stage === "completed" ? "done" : "active";
        }

        const dur =
          cls === "active" && liveElapsed
            ? liveElapsed
            : durationsMs?.[s] != null
              ? formatDurationMs(durationsMs[s])
              : null;

        return (
          <div
            key={s}
            className={`pipeline-step ${cls}`}
            role="listitem"
            title={
              isSkippedOptional
                ? `${s} (skipped)`
                : dur
                  ? `${s}: ${dur}`
                  : s
            }
          >
            <div className="pipeline-dot">
              {cls === "done" ? "✓" : cls === "skipped" ? "–" : i + 1}
            </div>
            <div className="pipeline-label">{s}</div>
            {dur && cls !== "skipped" ? (
              <div
                className={`pipeline-dur${cls === "active" ? " pipeline-dur--live" : ""}`}
              >
                {cls === "active" ? `· ${dur}` : dur}
              </div>
            ) : isSkippedOptional ? (
              <div className="pipeline-dur pipeline-dur--skip">skip</div>
            ) : (
              <div className="pipeline-dur pipeline-dur--placeholder">&nbsp;</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}

export function shortId(id: string, n = 12): string {
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

/** Click-to-copy ID chip — shows short form, copies full value. */
export function CopyId({
  id,
  n = 14,
  label,
}: {
  id: string;
  n?: number;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="mono ghost sm"
      title={`Click to copy full id: ${id}`}
      style={{
        padding: "0.1rem 0.35rem",
        fontSize: "0.78rem",
        cursor: "pointer",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "transparent",
        color: "inherit",
        maxWidth: "100%",
      }}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(id).then(
          () => {
            /* toast optional — title is enough */
          },
          () => {
            // Fallback for non-secure contexts
            const ta = document.createElement("textarea");
            ta.value = id;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          },
        );
      }}
    >
      {label ?? shortId(id, n)}
    </button>
  );
}
