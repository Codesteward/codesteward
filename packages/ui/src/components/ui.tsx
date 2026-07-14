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

export function StagePipeline({ stage, failed }: { stage: string; failed?: boolean }) {
  const idx = STAGES.indexOf(stage as (typeof STAGES)[number]);
  const activeIdx = stage === "failed" || stage === "cancelled" ? -1 : idx >= 0 ? idx : 0;

  return (
    <div className="pipeline" role="list" aria-label="Review pipeline">
      {STAGES.map((s, i) => {
        let cls = "";
        if (failed && (stage === "failed" || stage === "cancelled")) {
          cls = i === 0 ? "failed" : "";
        } else if (s === "completed" && stage === "completed") {
          cls = "done";
        } else if (i < activeIdx || stage === "completed") {
          cls = "done";
        } else if (i === activeIdx) {
          cls = stage === "completed" ? "done" : "active";
        }
        return (
          <div key={s} className={`pipeline-step ${cls}`} role="listitem">
            <div className="pipeline-dot">{cls === "done" ? "✓" : i + 1}</div>
            <div className="pipeline-label">{s}</div>
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
