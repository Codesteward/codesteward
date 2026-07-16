import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Select } from "../../components/Select";
import { useToast } from "../../components/Toast";
import { Badge } from "../../components/ui";
import {
  api,
  describePlanGate,
  type RuntimeConfigEntry,
} from "../../lib/api";
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from "../../lib/theme";

const RUNTIME_GROUPS: Array<{ id: string; label: string }> = [
  { id: "review", label: "Review pipeline" },
  { id: "graph", label: "Graph" },
  { id: "worker", label: "Worker / queue" },
  { id: "sandbox", label: "Sandbox" },
  { id: "debug", label: "Debug" },
];

/** Install-wide runtime (Platform settings only). */
export function RuntimeConfigPanel() {
  const toast = useToast();
  const [entries, setEntries] = useState<RuntimeConfigEntry[]>([]);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api
      .getPlatformRuntimeConfig()
      .then((r) => {
        setEntries(r.entries);
        setNote(r.note ?? "");
        const d: Record<string, string> = {};
        for (const e of r.entries) {
          // Platform draft: "" = unset (product default). Explicit values are install store.
          const stored = e.platformValue ?? e.dbValue;
          d[e.key] =
            stored !== undefined && stored !== null && stored !== "" ? stored : "";
        }
        setDraft(d);
        setErr(null);
      })
      .catch((e: Error) => {
        setErr(e.message);
        setEntries([]);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, []);

  const byGroup = useMemo(() => {
    const m = new Map<string, RuntimeConfigEntry[]>();
    for (const e of entries) {
      const list = m.get(e.group) ?? [];
      list.push(e);
      m.set(e.group, list);
    }
    return m;
  }, [entries]);

  async function save() {
    setBusy(true);
    try {
      const payload: Record<string, string | null> = {};
      for (const e of entries) {
        if (e.envSet || e.envOnly) continue;
        const v = draft[e.key];
        if (v === undefined || v === "" || v === "__unset__") {
          payload[e.key] = null;
        } else if (e.type === "boolean") {
          payload[e.key] = v === "1" || v === "true" || v === "yes" ? "1" : "0";
        } else {
          payload[e.key] = v;
        }
      }
      const saved = await api.putPlatformRuntimeConfig(payload);
      setEntries(saved.entries);
      toast.success("Platform runtime saved (process env still wins when set)");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function sourceBadge(source: string) {
    if (source === "env") return <Badge tone="ok">env</Badge>;
    if (source === "platform") return <Badge tone="running">platform</Badge>;
    if (source === "org") return <Badge tone="running">org</Badge>;
    if (source === "db") return <Badge tone="running">ui/db</Badge>;
    return <Badge tone="nit">default</Badge>;
  }

  return (
    <div className="card stack" style={{ gridColumn: "1 / -1" }}>
      <div className="card-header">
        <h3 className="card-title" style={{ margin: 0 }}>
          Platform runtime
        </h3>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="ghost sm" disabled={loading || busy} onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="primary sm" disabled={loading || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save install-wide"}
          </button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
        {note ||
          "Install-wide knobs for this Codesteward fleet (clone, DeepAgents, graph, workers, …). Apply to all organizations. Booleans: Unset = product default, Off/On = force install-wide. Process env always wins until removed and restarted."}
      </p>
      {err && (
        <p style={{ color: "var(--danger)", fontSize: "0.85rem", margin: 0 }}>{err}</p>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        RUNTIME_GROUPS.map((g) => {
          const list = byGroup.get(g.id) ?? [];
          if (!list.length) return null;
          return (
            <div key={g.id} className="stack" style={{ gap: 10 }}>
              <h4 style={{ margin: "0.5rem 0 0", fontSize: "0.9rem" }}>{g.label}</h4>
              <div className="stack" style={{ gap: 12 }}>
                {list.map((e) => {
                  const draftVal = draft[e.key] ?? "";
                  const locked = !e.editable;
                  return (
                  <div
                    key={e.key}
                    style={{
                      borderTop: "1px solid var(--border)",
                      paddingTop: 10,
                    }}
                  >
                    <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <div>
                        <strong style={{ fontSize: "0.9rem" }}>{e.label}</strong>
                        <div className="mono muted" style={{ fontSize: "0.72rem" }}>
                          {e.key}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        {sourceBadge(e.source)}
                        {e.envSet && <Badge tone="warn">locked by env</Badge>}
                      </div>
                    </div>
                    <p className="muted" style={{ fontSize: "0.8rem", margin: "6px 0 8px", lineHeight: 1.45 }}>
                      {e.description}
                    </p>
                    <div className="field" style={{ margin: 0, maxWidth: 480 }}>
                      {e.type === "boolean" ? (
                        locked ? (
                          <span className="mono" style={{ fontSize: "0.85rem" }}>
                            {e.value === "1" || e.value === "true" ? "on (1)" : "off (0)"}
                            {e.envSet ? " — from process env" : ""}
                          </span>
                        ) : (
                          <Select
                            aria-label={`${e.label} override`}
                            size="sm"
                            value={
                              draftVal === "1" || draftVal === "true"
                                ? "1"
                                : draftVal === "0" || draftVal === "false"
                                  ? "0"
                                  : ""
                            }
                            onChange={(v) => setDraft((d) => ({ ...d, [e.key]: v }))}
                            options={[
                              {
                                value: "",
                                label: `Unset — product default (${e.default === "1" ? "on" : "off"})`,
                              },
                              { value: "0", label: "Off (0) — store install-wide" },
                              { value: "1", label: "On (1) — store install-wide" },
                            ]}
                          />
                        )
                      ) : e.type === "enum" && e.enumValues ? (
                        <Select
                          aria-label={`${e.label} override`}
                          size="sm"
                          disabled={locked}
                          value={locked ? e.value : draftVal || ""}
                          onChange={(v) => setDraft((d) => ({ ...d, [e.key]: v }))}
                          options={[
                            {
                              value: "",
                              label: `Unset — product default (${e.default})`,
                            },
                            ...e.enumValues.map((v) => ({ value: v, label: v })),
                          ]}
                        />
                      ) : e.type === "number" ? (
                        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <input
                            type="number"
                            disabled={locked}
                            value={locked ? e.value : draftVal}
                            onChange={(ev) =>
                              setDraft((d) => ({ ...d, [e.key]: ev.target.value }))
                            }
                            placeholder={e.default}
                            className="mono"
                            style={{ flex: 1, minWidth: 120, maxWidth: 200 }}
                            {...(e.key === "STEW_SUGGESTED_FIX_MIN_CONFIDENCE"
                              ? { min: 0, max: 1, step: 0.05 }
                              : { step: 1 })}
                          />
                          {!locked && draftVal !== "" && (
                            <button
                              type="button"
                              className="ghost sm"
                              onClick={() => setDraft((d) => ({ ...d, [e.key]: "" }))}
                            >
                              Unset
                            </button>
                          )}
                          {e.key === "STEW_SUGGESTED_FIX_MIN_CONFIDENCE" && (
                            <span className="muted" style={{ fontSize: "0.78rem" }}>
                              0–1 (default {e.default})
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <input
                            disabled={locked}
                            value={locked ? e.value : draftVal}
                            onChange={(ev) =>
                              setDraft((d) => ({ ...d, [e.key]: ev.target.value }))
                            }
                            placeholder={`default: ${e.default}`}
                            className="mono"
                            style={{ flex: 1, minWidth: 160 }}
                          />
                          {!locked && draftVal !== "" && (
                            <button
                              type="button"
                              className="ghost sm"
                              onClick={() => setDraft((d) => ({ ...d, [e.key]: "" }))}
                            >
                              Unset
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="muted mono" style={{ fontSize: "0.7rem", marginTop: 4 }}>
                      effective: {e.value}
                      {e.envSet
                        ? " (process env — UI cannot clear this)"
                        : e.platformValue != null
                          ? ` (platform store=${e.platformValue})`
                          : e.dbValue != null
                            ? ` (stored=${e.dbValue})`
                            : ` (unset → default ${e.default})`}
                      {(e.key === "STEW_SUGGESTED_CODE_FIXES" ||
                        e.key === "STEW_PUBLISH_SARIF") &&
                      (e.platformValue === undefined || e.platformValue === "")
                        ? " · orgs may override when unset here"
                        : e.key === "STEW_SUGGESTED_CODE_FIXES" ||
                            e.key === "STEW_PUBLISH_SARIF"
                          ? " · forces all orgs"
                          : ""}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Shared org-level Unset / Off / On control for platform-overridable boolean runtime keys.
 * Platform may force Off/On for all orgs (or env pins it). Org chooses only when platform is Unset.
 */
function OrgRuntimeBooleanPanel(props: {
  configKey: string;
  title: string;
  blurb: ReactNode;
  defaultLabel: string;
  toastOn: string;
  toastOff: string;
  toastUnset: string;
  selectId: string;
}) {
  const toast = useToast();
  const [entry, setEntry] = useState<RuntimeConfigEntry | null>(null);
  const [choice, setChoice] = useState<"" | "0" | "1">("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api
      .getRuntimeConfig()
      .then((r) => {
        const e = r.entries.find((x) => x.key === props.configKey) ?? null;
        setEntry(e);
        const ov = e?.orgValue ?? e?.dbValue;
        if (ov === "1" || ov === "true") setChoice("1");
        else if (ov === "0" || ov === "false") setChoice("0");
        else setChoice("");
        setErr(null);
      })
      .catch((e: Error) => {
        setErr(e.message);
        setEntry(null);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.configKey]);

  async function save(next: "" | "0" | "1") {
    setBusy(true);
    try {
      await api.putRuntimeConfig({
        [props.configKey]: next === "" ? null : next,
      });
      setChoice(next);
      toast.success(
        next === "1" ? props.toastOn : next === "0" ? props.toastOff : props.toastUnset,
      );
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      void load();
    } finally {
      setBusy(false);
    }
  }

  const lockedByEnv = Boolean(entry?.envSet);
  const lockedByPlatform = Boolean(
    entry &&
      entry.platformValue !== undefined &&
      entry.platformValue !== null &&
      entry.platformValue !== "",
  );
  const canEdit =
    Boolean(entry?.orgEditable ?? entry?.editable) && !lockedByEnv && !lockedByPlatform;
  const effectiveOn = entry?.value === "1" || entry?.value === "true";

  let statusLabel: string;
  if (lockedByEnv) statusLabel = effectiveOn ? "on · env" : "off · env";
  else if (lockedByPlatform) statusLabel = effectiveOn ? "on · platform" : "off · platform";
  else if (choice === "1") statusLabel = "on · this org";
  else if (choice === "0") statusLabel = "off · this org";
  else statusLabel = effectiveOn ? "on · default" : "off · default";

  return (
    <div className="card stack">
      <div className="card-header">
        <h3 style={{ margin: 0 }}>{props.title}</h3>
        <Badge tone={effectiveOn ? "ok" : "nit"}>{statusLabel}</Badge>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.55 }}>
        {props.blurb}
      </p>
      {loading ? (
        <p className="muted" style={{ margin: 0 }}>
          Loading…
        </p>
      ) : err ? (
        <p style={{ color: "var(--danger)", fontSize: "0.85rem", margin: 0 }}>{err}</p>
      ) : !entry ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          This API build does not expose <span className="mono">{props.configKey}</span> yet.
          Rebuild/restart the API, then refresh.
        </p>
      ) : (
        <>
          {canEdit ? (
            <div className="field" style={{ margin: 0, maxWidth: 420 }}>
              <label htmlFor={props.selectId}>This organization</label>
              <Select
                id={props.selectId}
                size="sm"
                disabled={busy}
                value={choice}
                onChange={(v) => void save(v as "" | "0" | "1")}
                options={[
                  { value: "", label: props.defaultLabel },
                  { value: "0", label: "Off for this org" },
                  { value: "1", label: "On for this org" },
                ]}
              />
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.5 }}>
              {lockedByEnv ? (
                <>
                  Locked by process environment on the API/worker (
                  <span className="mono">
                    {props.configKey}={entry.envValue ?? entry.value}
                  </span>
                  ). Operators must change/remove the env var and restart.
                </>
              ) : lockedByPlatform ? (
                <>
                  Locked by <strong>Platform</strong> install policy (
                  <span className="mono">
                    {entry.platformValue === "1" ? "On" : "Off"}
                  </span>
                  ). A platform operator must set <strong>{props.title}</strong> to{" "}
                  <strong>Unset</strong> under Platform runtime before this org can choose.
                </>
              ) : (
                <>Not editable with your current permissions.</>
              )}
            </p>
          )}
          <p className="mono muted" style={{ margin: 0, fontSize: "0.72rem" }}>
            effective={entry.value} · source={entry.source}
            {entry.platformValue != null && entry.platformValue !== ""
              ? ` · platform=${entry.platformValue}`
              : " · platform=unset"}
            {entry.orgValue != null || entry.dbValue != null
              ? ` · org=${entry.orgValue ?? entry.dbValue}`
              : " · org=unset"}
          </p>
        </>
      )}
    </div>
  );
}

/** Org preference: concrete code fixes on findings. */
export function OrgSuggestedCodeFixesPanel() {
  return (
    <OrgRuntimeBooleanPanel
      configKey="STEW_SUGGESTED_CODE_FIXES"
      title="Suggested code fixes"
      selectId="suggested-code-fixes-choice"
      defaultLabel="Unset — product default (off)"
      toastOn="This organization will request code fixes on findings"
      toastOff="This organization will not request code fixes"
      toastUnset="Cleared org preference — inherit product default (off) unless platform sets a policy"
      blurb={
        <>
          When effectively <strong>on</strong>, specialists may attach a concrete{" "}
          <span className="mono">suggestedFix</span> on findings (UI, reports, PR comments).
          This control only works when Platform leaves the install policy{" "}
          <strong>Unset</strong>. If Platform (or process env) forces Off or On, that applies to{" "}
          <strong>every</strong> organization and your choice is ignored.
        </>
      }
    />
  );
}

/** Org preference: upload SARIF to GitHub Code Scanning (Security tab). */
export function OrgPublishSarifPanel() {
  return (
    <OrgRuntimeBooleanPanel
      configKey="STEW_PUBLISH_SARIF"
      title="Publish SARIF to GitHub Code Scanning"
      selectId="publish-sarif-choice"
      defaultLabel="Unset — product default (on)"
      toastOn="This organization will upload SARIF to GitHub Code Scanning on gate publish"
      toastOff="This organization will not upload SARIF to GitHub Code Scanning"
      toastUnset="Cleared org preference — inherit product default (on) unless platform sets a policy"
      blurb={
        <>
          When effectively <strong>on</strong>, PR gate publish uploads findings as SARIF to
          GitHub <strong>Security → Code scanning</strong> (in addition to PR comments and the
          Checks tab). Requires code scanning enabled on the repo and{" "}
          <span className="mono">security_events: write</span> on the GitHub App/token.
          Same resolution as Suggested code fixes: Platform Unset → org may choose; Platform
          Off/On forces every org.
        </>
      }
    />
  );
}

export function OrgAuditLog() {
  const toast = useToast();
  const [events, setEvents] = useState<
    Array<{
      id: string;
      action: string;
      actorUserId?: string;
      resourceType?: string;
      resourceId?: string;
      metadata?: Record<string, unknown>;
      outcome?: string;
      ip?: string;
      createdAt: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [planGate, setPlanGate] = useState<ReturnType<typeof describePlanGate>>(null);
  const [actionPrefix, setActionPrefix] = useState("");
  const [total, setTotal] = useState(0);
  const [retentionDays, setRetentionDays] = useState(365);
  const [offset, setOffset] = useState(0);
  const [portalBusy, setPortalBusy] = useState(false);
  const limit = 50;

  function load(nextOffset = offset) {
    setLoading(true);
    api
      .orgAudit({
        limit,
        offset: nextOffset,
        ...(actionPrefix.trim()
          ? { actionPrefix: actionPrefix.trim() }
          : {}),
      })
      .then((r) => {
        setEvents(r.events);
        setTotal(r.total ?? r.count);
        setRetentionDays(r.retentionDays ?? 365);
        setOffset(nextOffset);
        setErr(null);
        setPlanGate(null);
      })
      .catch((e: Error) => {
        const gate = describePlanGate(e);
        setPlanGate(gate);
        setErr(gate ? null : e.message);
        setEvents([]);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial
  }, []);

  async function openBilling() {
    setPortalBusy(true);
    try {
      const res = await api.openBillingPortal({
        returnTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/settings/organization`
            : undefined,
      });
      if (res.url) window.location.assign(res.url);
      else toast.error("Billing portal unavailable");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPortalBusy(false);
    }
  }

  // Plan-gated: friendly empty card (never show raw 402 JSON)
  if (planGate) {
    const badge =
      planGate.planRequired === "enterprise"
        ? "Enterprise"
        : planGate.planRequired === "pro"
          ? "Pro+"
          : "Upgrade";
    return (
      <div className="card stack">
        <div className="card-header">
          <h3>Admin audit log</h3>
          <Badge tone="nit">{badge}</Badge>
        </div>
        <p style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600, lineHeight: 1.4 }}>
          {planGate.title}
        </p>
        <p className="muted" style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.55 }}>
          {planGate.body}
        </p>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem", lineHeight: 1.5 }}>
          Durable admin audit trails (who changed members, connectors, SCIM, and more) are included
          on Pro and Enterprise. Open Billing to upgrade this organization.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="primary sm"
            disabled={portalBusy}
            onClick={() => void openBilling()}
          >
            {portalBusy ? "Opening…" : "Upgrade in Billing"}
          </button>
          <button type="button" className="ghost sm" onClick={() => load(0)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="card-header">
        <h3>Admin audit log</h3>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ghost sm" onClick={() => load(offset)}>
            Refresh
          </button>
          <button
            type="button"
            className="ghost sm"
            onClick={(e) => {
              e.preventDefault();
              void (async () => {
                try {
                  const r = await api.orgAudit({
                    limit: 500,
                    ...(actionPrefix.trim()
                      ? { actionPrefix: actionPrefix.trim() }
                      : {}),
                  });
                  const nd = r.events.map((x) => JSON.stringify(x)).join("\n") + "\n";
                  const blob = new Blob([nd], { type: "application/x-ndjson" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `audit-${r.orgId}.ndjson`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (ex) {
                  const gate = describePlanGate(ex);
                  if (gate) toast.error(gate.body);
                }
              })();
            }}
          >
            Export NDJSON
          </button>
          <button
            type="button"
            className="ghost sm"
            onClick={() => {
              void api
                .pruneAudit()
                .then((r) => {
                  setErr(null);
                  load(0);
                  if (r.deleted === 0) setErr("No events past retention to prune");
                })
                .catch((e: Error) => {
                  const gate = describePlanGate(e);
                  if (gate) setPlanGate(gate);
                  else setErr(e.message);
                });
            }}
          >
            Prune old
          </button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
        Append-only trail of admin / IAM actions (login, users, license, models, connectors, SCIM).
        Separate from per-session <strong>Review audit</strong> (code provenance). Retention{" "}
        <span className="mono">{retentionDays}d</span>
        {total ? (
          <>
            {" "}
            · <span className="mono">{total}</span> events
          </>
        ) : null}
        .
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="mono"
          style={{ maxWidth: 220, fontSize: "0.85rem" }}
          placeholder="action prefix e.g. scim."
          value={actionPrefix}
          onChange={(e) => setActionPrefix(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(0);
          }}
        />
        <button type="button" className="ghost sm" onClick={() => load(0)}>
          Filter
        </button>
        {offset > 0 && (
          <button type="button" className="ghost sm" onClick={() => load(Math.max(0, offset - limit))}>
            Prev
          </button>
        )}
        {offset + events.length < total && (
          <button type="button" className="ghost sm" onClick={() => load(offset + limit)}>
            Next
          </button>
        )}
      </div>
      {err && (
        <p className="muted" style={{ color: "var(--danger)", fontSize: "0.85rem" }}>
          {err}
        </p>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          No audit events yet. Mutations and SCIM provisioning append here.
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Actor</th>
              <th>Resource</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id} title={ev.metadata ? JSON.stringify(ev.metadata) : undefined}>
                <td className="mono muted" style={{ fontSize: "0.72rem" }}>
                  {ev.createdAt.slice(0, 19).replace("T", " ")}
                </td>
                <td>
                  <Badge tone="info">{ev.action}</Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      ev.outcome === "failure" || ev.outcome === "denied" ? "danger" : "ok"
                    }
                  >
                    {ev.outcome ?? "success"}
                  </Badge>
                </td>
                <td className="mono muted" style={{ fontSize: "0.75rem" }}>
                  {ev.actorUserId ?? "—"}
                </td>
                <td className="mono muted" style={{ fontSize: "0.75rem" }}>
                  {[ev.resourceType, ev.resourceId].filter(Boolean).join(" ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Org SCIM setup for IdPs (Okta / Entra).
 * Tokens: full secret is shown only at mint time; later only last-4 is listed.
 */
export function OrgScimPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.scimStatus>> | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [portalBusy, setPortalBusy] = useState(false);

  function load() {
    setLoading(true);
    return api
      .scimStatus()
      .then((r) => {
        setStatus(r);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, []);

  async function openBilling() {
    setPortalBusy(true);
    try {
      const res = await api.openBillingPortal({
        returnTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/settings/organization`
            : undefined,
      });
      if (res.url) window.location.assign(res.url);
      else toast.error("Billing portal unavailable");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPortalBusy(false);
    }
  }

  async function mint() {
    if (status && !status.entitled) {
      toast.error("SCIM requires an Enterprise plan");
      return;
    }
    setBusy(true);
    setFreshToken(null);
    try {
      const r = await api.mintScimToken({ label: "IdP connector" });
      setFreshToken(r.token);
      toast.success("SCIM token minted — copy it now; it won’t be shown again");
      await load();
    } catch (e) {
      const gate = describePlanGate(e);
      const msg = gate?.body ?? (e instanceof Error ? e.message : String(e));
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await api.revokeScimToken(id);
      setFreshToken(null);
      toast.success("SCIM token revoked");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Could not copy — select the text manually");
    }
  }

  const tokens = status?.tokens ?? [];
  const entitled = status?.entitled === true;

  // Plan-gated: no mint UI (Enterprise only)
  if (!loading && status && !entitled) {
    return (
      <div className="card stack">
        <div className="card-header">
          <h3>SCIM directory provisioning</h3>
          <Badge tone="nit">Enterprise</Badge>
        </div>
        <p style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600, lineHeight: 1.4 }}>
          Enterprise plan required
        </p>
        <p className="muted" style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.55 }}>
          SCIM provisioning requires an Enterprise plan. Directory sync (Okta, Entra, and other
          IdPs) is not available on Free or Pro.
        </p>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem", lineHeight: 1.5 }}>
          Upgrade under Billing to unlock per-org SCIM base URLs and bearer tokens for this
          organization.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="primary sm"
            disabled={portalBusy}
            onClick={() => void openBilling()}
          >
            {portalBusy ? "Opening…" : "Upgrade in Billing"}
          </button>
          <button type="button" className="ghost sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="card-header">
        <h3>SCIM directory provisioning</h3>
        {status && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge tone={status.entitled ? "ok" : "nit"}>
              {status.entitled ? "licensed" : "not licensed"}
            </Badge>
            <Badge tone={tokens.length > 0 ? "ok" : "warn"}>
              {tokens.length > 0
                ? `${tokens.length} active token${tokens.length === 1 ? "" : "s"}`
                : "no tokens yet"}
            </Badge>
          </div>
        )}
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
        Connect Okta, Entra ID, or another SCIM IdP to <strong>this organization only</strong>.
        Each tenant has its own base URL and bearer token (not a shared{" "}
        <span className="mono">STEW_SCIM_TOKEN</span>). Soft-deprovision removes membership; users
        with no remaining orgs are deactivated.
      </p>
      {loading && <p className="muted">Loading…</p>}
      {err && (
        <p className="muted" style={{ color: "var(--danger)", fontSize: "0.85rem" }}>
          {err}
        </p>
      )}
      {status && !loading && (
        <>
          <div className="field">
            <label>
              Tenant SCIM base URL{" "}
              <span className="muted">
                ({status.orgSlug ?? status.orgId})
              </span>
            </label>
            <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <code
                className="mono"
                style={{ fontSize: "0.8rem", wordBreak: "break-all", flex: 1, minWidth: 200 }}
              >
                {status.baseUrl}
              </code>
              <button
                type="button"
                className="ghost sm"
                onClick={() => void copy(status.baseUrl, "Base URL")}
              >
                Copy URL
              </button>
            </div>
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem", lineHeight: 1.55 }}>
            <li>
              Users: <span className="mono">{status.endpoints.Users}</span>
            </li>
            <li>
              Groups: <span className="mono">{status.endpoints.Groups}</span>
            </li>
            <li>
              Auth header:{" "}
              <span className="mono">Authorization: Bearer &lt;token from below&gt;</span>
            </li>
          </ul>

          <div
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: "0.85rem",
              marginTop: "0.25rem",
            }}
          >
            <div
              className="row"
              style={{
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.5rem",
              }}
            >
              <strong style={{ fontSize: "0.9rem" }}>Org SCIM tokens</strong>
              <button
                type="button"
                className="primary sm"
                disabled={busy || !entitled}
                onClick={() => void mint()}
              >
                {busy ? "Working…" : "Mint token"}
              </button>
            </div>
            <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.65rem", lineHeight: 1.45 }}>
              The <strong>full secret is shown only once</strong> when you mint. After that this
              page lists only the last 4 characters (like API keys). Revoke and mint again if you
              lost it.
            </p>

            {freshToken && (
              <div
                className="field"
                style={{
                  padding: "0.75rem",
                  borderRadius: 8,
                  border: "1px solid var(--warn, #c90)",
                  background: "var(--surface-2, rgba(255,200,80,0.06))",
                  marginBottom: "0.75rem",
                }}
              >
                <label style={{ color: "var(--warn, #c90)" }}>
                  New bearer token — copy now (won’t be shown again)
                </label>
                <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <code
                    className="mono"
                    style={{ fontSize: "0.78rem", wordBreak: "break-all", flex: 1 }}
                  >
                    {freshToken}
                  </code>
                  <button
                    type="button"
                    className="primary sm"
                    onClick={() => void copy(freshToken, "Token")}
                  >
                    Copy token
                  </button>
                </div>
              </div>
            )}

            {tokens.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                No tokens yet. Click <strong>Mint token</strong>, paste it into your IdP as the
                SCIM bearer token, then use the base URL above.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Label</th>
                      <th>Created</th>
                      <th>Last used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((t) => (
                      <tr key={t.id}>
                        <td className="mono">····{t.last4}</td>
                        <td className="muted" style={{ fontSize: "0.85rem" }}>
                          {t.label ?? "—"}
                        </td>
                        <td className="mono muted" style={{ fontSize: "0.72rem" }}>
                          {t.createdAt.slice(0, 19).replace("T", " ")}
                        </td>
                        <td className="mono muted" style={{ fontSize: "0.72rem" }}>
                          {t.lastUsedAt
                            ? t.lastUsedAt.slice(0, 19).replace("T", " ")
                            : "never"}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="ghost sm"
                            disabled={busy}
                            onClick={() => void revoke(t.id)}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <strong style={{ fontSize: "0.85rem" }}>Role group names (optional)</strong>
            <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
              {status.roleGroups.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}


type LangfuseCfg = {
  enabled: boolean;
  publicKeySet: boolean;
  publicKeyHint?: string;
  secretKeySet: boolean;
  baseUrl?: string;
};

function LangfuseKeysForm(props: {
  title: string;
  subtitle: string;
  cfg: LangfuseCfg | null;
  entitled: boolean;
  badges?: ReactNode;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  publicKey: string;
  setPublicKey: (v: string) => void;
  secretKey: string;
  setSecretKey: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  busy: boolean;
  loading: boolean;
  err: string | null;
  onSave: () => void;
  onClear: () => void;
  enableLabel: string;
}) {
  const {
    title,
    subtitle,
    cfg,
    entitled,
    badges,
    enabled,
    setEnabled,
    publicKey,
    setPublicKey,
    secretKey,
    setSecretKey,
    baseUrl,
    setBaseUrl,
    busy,
    loading,
    err,
    onSave,
    onClear,
    enableLabel,
  } = props;

  return (
    <div className="card stack">
      <div className="card-header">
        <h3>{title}</h3>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Badge tone={entitled ? "ok" : "nit"}>{entitled ? "licensed" : "not licensed"}</Badge>
          {badges}
        </div>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
        {subtitle}
      </p>
      {loading && <p className="muted">Loading…</p>}
      {err && (
        <p className="muted" style={{ color: "var(--danger)", fontSize: "0.85rem" }}>
          {err}
        </p>
      )}
      {cfg && !loading && (
        <>
          <label
            className="row"
            style={{ gap: 8, alignItems: "center", fontSize: "0.9rem", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {enableLabel}
          </label>
          <div className="grid cols-2" style={{ gap: "0.75rem" }}>
            <div className="field">
              <label>
                Public key{" "}
                {cfg.publicKeySet && (
                  <span className="muted mono" style={{ fontWeight: 400 }}>
                    ({cfg.publicKeyHint})
                  </span>
                )}
              </label>
              <input
                className="mono"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder={cfg.publicKeySet ? "Leave blank to keep" : "pk-lf-…"}
                autoComplete="off"
                disabled={!enabled}
              />
            </div>
            <div className="field">
              <label>
                Secret key{" "}
                {cfg.secretKeySet && (
                  <span className="muted" style={{ fontWeight: 400 }}>
                    (set · encrypted)
                  </span>
                )}
              </label>
              <input
                className="mono"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={cfg.secretKeySet ? "Leave blank to keep" : "sk-lf-…"}
                autoComplete="new-password"
                disabled={!enabled}
              />
            </div>
          </div>
          <div className="field">
            <label>Host URL (optional)</label>
            <input
              className="mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://cloud.langfuse.com"
              disabled={!enabled}
            />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="primary sm" disabled={busy} onClick={onSave}>
              {busy ? "Saving…" : "Save Langfuse"}
            </button>
            <button type="button" className="ghost sm" disabled={busy} onClick={onClear}>
              Clear keys
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Optional per-org Langfuse — Models + Organization. Dual-writes with platform when both set. */
export function OrgLangfusePanel() {
  const toast = useToast();
  const [cfg, setCfg] = useState<LangfuseCfg | null>(null);
  const [destinations, setDestinations] = useState<
    Array<{ source: string; baseUrl?: string; publicKeyHint?: string }>
  >([]);
  const [dualWrite, setDualWrite] = useState(false);
  const [entitled, setEntitled] = useState(true);
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    return api
      .orgLangfuse()
      .then((r) => {
        setCfg(r.config);
        setDestinations(r.destinations ?? []);
        setDualWrite(Boolean(r.dualWrite));
        setEntitled(r.entitled);
        setEnabled(r.config.enabled);
        setBaseUrl(r.config.baseUrl ?? "");
        setPublicKey("");
        setSecretKey("");
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <LangfuseKeysForm
      title="Langfuse — this organization (optional)"
      subtitle={
        dualWrite
          ? "Org project is set and platform Langfuse is also set — each review dual-writes to both projects (same session id)."
          : "Optional tenant Langfuse project. You can also set a platform-wide project under Platform settings; when both are configured, traces go to both."
      }
      cfg={cfg}
      entitled={entitled}
      badges={
        <>
          {dualWrite && <Badge tone="ok">dual-write on</Badge>}
          {destinations.map((d) => (
            <Badge key={d.source} tone="info">
              → {d.source}
              {d.publicKeyHint ? ` ${d.publicKeyHint}` : ""}
            </Badge>
          ))}
          {destinations.length === 0 && <Badge tone="warn">no destinations</Badge>}
        </>
      }
      enabled={enabled}
      setEnabled={setEnabled}
      publicKey={publicKey}
      setPublicKey={setPublicKey}
      secretKey={secretKey}
      setSecretKey={setSecretKey}
      baseUrl={baseUrl}
      setBaseUrl={setBaseUrl}
      busy={busy}
      loading={loading}
      err={err}
      enableLabel="Enable org Langfuse project"
      onSave={() => {
        setBusy(true);
        void api
          .putOrgLangfuse({
            enabled,
            publicKey: publicKey.trim() || undefined,
            secretKey: secretKey.trim() || undefined,
            baseUrl: baseUrl.trim() || undefined,
          })
          .then(() => {
            toast.success("Org Langfuse saved");
            return load();
          })
          .catch((e: Error) => {
            setErr(e.message);
            toast.error(e.message);
          })
          .finally(() => setBusy(false));
      }}
      onClear={() => {
        setBusy(true);
        void api
          .putOrgLangfuse({ clear: true })
          .then(() => {
            toast.success("Org Langfuse cleared (platform still used if set)");
            return load();
          })
          .catch((e: Error) => {
            setErr(e.message);
            toast.error(e.message);
          })
          .finally(() => setBusy(false));
      }}
    />
  );
}

/** Install-wide Langfuse — Platform settings only. Dual-writes with org when both set. */
/** Install-wide GitHub App — enforce shared App for all tenants (SaaS / enterprise self-host). */
export function PlatformGithubAppPanel() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enforce, setEnforce] = useState(false);
  const [allowOrgPat, setAllowOrgPat] = useState(false);
  const [appId, setAppId] = useState("");
  const [slug, setSlug] = useState("");
  const [clientId, setClientId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [privateKeyRef, setPrivateKeyRef] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState("none");
  const [note, setNote] = useState<string | null>(null);
  const [pemSet, setPemSet] = useState(false);

  function load() {
    setLoading(true);
    return api
      .platformGithubApp()
      .then((r) => {
        setEnforce(Boolean(r.policy.enforce || r.config?.enforce));
        setAllowOrgPat(Boolean(r.policy.allowOrgPat || r.config?.allowOrgPat));
        setAppId(r.config?.appId ?? r.policy.appId ?? "");
        setSlug(r.config?.slug ?? r.policy.slug ?? "");
        setClientId(r.config?.clientId ?? "");
        setBaseUrl(r.config?.baseUrl ?? "");
        setPrivateKeyRef(r.config?.privateKeyRef ?? "");
        setPemSet(Boolean(r.config?.privateKeyConfigured));
        setConfigured(r.policy.configured);
        setSource(r.policy.source);
        setNote(r.note ?? null);
        setPrivateKeyPem("");
        setWebhookSecret("");
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    try {
      const res = await api.putPlatformGithubApp({
        enforce,
        allowOrgPat,
        appId: appId.trim() || undefined,
        slug: slug.trim() || undefined,
        clientId: clientId.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        privateKeyRef: privateKeyRef.trim() || undefined,
        privateKeyPem: privateKeyPem.trim() || undefined,
        webhookSecret: webhookSecret.trim() || undefined,
      });
      toast.success(res.note ?? "Platform GitHub App saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm("Remove platform GitHub App config and turn off enforce?")) return;
    setBusy(true);
    try {
      await api.putPlatformGithubApp({ clear: true });
      toast.success("Platform GitHub App cleared");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h3>GitHub App — platform (optional enforce)</h3>
      <p className="muted" style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.55 }}>
        SaaS and enterprise self-host: configure one GitHub App for the whole install. When{" "}
        <strong>Enforce</strong> is on, every org must install <em>this</em> App on their GitHub
        account — they cannot upload their own App PEM or (by default) a personal access token.
      </p>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge tone={enforce ? "ok" : "nit"}>{enforce ? "enforced" : "optional"}</Badge>
            <Badge tone={configured ? "ok" : "warn"}>
              {configured ? `credentials (${source})` : "not configured"}
            </Badge>
            {pemSet && <Badge tone="ok">PEM stored</Badge>}
          </div>
          {note && (
            <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
              {note}
            </p>
          )}
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={enforce}
              onChange={(e) => setEnforce(e.target.checked)}
            />
            <span>
              <strong>Enforce</strong> platform GitHub App for all orgs
            </span>
          </label>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={allowOrgPat}
              onChange={(e) => setAllowOrgPat(e.target.checked)}
              disabled={!enforce}
            />
            <span className="muted" style={{ fontSize: "0.88rem" }}>
              Allow org PATs while enforced (break-glass; off by default)
            </span>
          </label>
          <div className="grid cols-2">
            <div className="field" style={{ margin: 0 }}>
              <label>App ID</label>
              <input
                className="mono"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="123456"
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>App slug</label>
              <input
                className="mono"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="codesteward"
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Client ID (optional)</label>
              <input
                className="mono"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>API base URL (optional)</label>
              <input
                className="mono"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.github.com"
              />
            </div>
          </div>
          <div className="field">
            <label>Private key PEM (leave blank to keep existing)</label>
            <textarea
              className="mono"
              rows={4}
              value={privateKeyPem}
              onChange={(e) => setPrivateKeyPem(e.target.value)}
              placeholder={"-----BEGIN RSA PRIVATE KEY-----\\n…"}
            />
          </div>
          <div className="field">
            <label>Or private key ref (env:VAR)</label>
            <input
              className="mono"
              value={privateKeyRef}
              onChange={(e) => setPrivateKeyRef(e.target.value)}
              placeholder="env:GITHUB_APP_PRIVATE_KEY"
            />
          </div>
          <div className="field">
            <label>Webhook secret (optional)</label>
            <input
              type="password"
              className="mono"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder="leave blank to keep"
              autoComplete="off"
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="primary sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save platform GitHub App"}
            </button>
            <button type="button" className="ghost sm" disabled={busy} onClick={() => void clear()}>
              Clear
            </button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
            Env bootstrap: <span className="mono">STEW_PLATFORM_GITHUB_APP_ENFORCE=1</span> with{" "}
            <span className="mono">GITHUB_APP_ID</span> + PEM when the file store is empty.
          </p>
        </>
      )}
    </div>
  );
}

export function PlatformLangfusePanel() {
  const toast = useToast();
  const [cfg, setCfg] = useState<LangfuseCfg | null>(null);
  const [effective, setEffective] = useState<{
    source: string;
    baseUrl?: string;
    publicKeyHint?: string;
  } | null>(null);
  const [envFallback, setEnvFallback] = useState(false);
  const [entitled, setEntitled] = useState(true);
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    return api
      .platformLangfuse()
      .then((r) => {
        setCfg(r.config);
        setEffective(r.effective);
        setEnvFallback(r.envFallback);
        setEntitled(r.entitled);
        setEnabled(r.config.enabled);
        setBaseUrl(r.config.baseUrl ?? "");
        setPublicKey("");
        setSecretKey("");
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <LangfuseKeysForm
      title="Langfuse — platform (optional)"
      subtitle={
        envFallback && !cfg?.publicKeySet
          ? "Using LANGFUSE_* environment variables as platform project. You can override with keys below. Orgs may also set their own project; both receive traces when both are set."
          : "Install-wide Langfuse project. Orgs can add a second project under Organization/Models — when both are set, every review dual-writes to platform + org."
      }
      cfg={cfg}
      entitled={entitled}
      badges={
        effective ? (
          <Badge tone="ok">
            active {effective.publicKeyHint ?? effective.source}
          </Badge>
        ) : (
          <Badge tone="warn">platform tracing off</Badge>
        )
      }
      enabled={enabled}
      setEnabled={setEnabled}
      publicKey={publicKey}
      setPublicKey={setPublicKey}
      secretKey={secretKey}
      setSecretKey={setSecretKey}
      baseUrl={baseUrl}
      setBaseUrl={setBaseUrl}
      busy={busy}
      loading={loading}
      err={err}
      enableLabel="Enable platform Langfuse project"
      onSave={() => {
        setBusy(true);
        void api
          .putPlatformLangfuse({
            enabled,
            publicKey: publicKey.trim() || undefined,
            secretKey: secretKey.trim() || undefined,
            baseUrl: baseUrl.trim() || undefined,
          })
          .then(() => {
            toast.success("Platform Langfuse saved");
            return load();
          })
          .catch((e: Error) => {
            setErr(e.message);
            toast.error(e.message);
          })
          .finally(() => setBusy(false));
      }}
      onClear={() => {
        setBusy(true);
        void api
          .putPlatformLangfuse({ clear: true })
          .then(() => {
            toast.success("Platform Langfuse UI keys cleared (env still applies if set)");
            return load();
          })
          .catch((e: Error) => {
            setErr(e.message);
            toast.error(e.message);
          })
          .finally(() => setBusy(false));
      }}
    />
  );
}

export function AppearancePicker() {
  const [pref, setPref] = useState<ThemePreference>(() => getThemePreference());

  useEffect(() => subscribeTheme((p) => setPref(p)), []);

  const options: Array<{
    id: ThemePreference;
    label: string;
    hint: string;
    icon: typeof Sun;
  }> = [
    { id: "light", label: "Light", hint: "Bright surfaces", icon: Sun },
    { id: "dark", label: "Dark", hint: "Default product chrome", icon: Moon },
    { id: "system", label: "System", hint: "Follow OS preference", icon: Monitor },
  ];

  return (
    <div className="theme-picker" role="radiogroup" aria-label="Color theme">
      {options.map((o) => {
        const Icon = o.icon;
        const active = pref === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? "theme-picker-card active" : "theme-picker-card"}
            onClick={() => setThemePreference(o.id)}
          >
            <span className="theme-picker-icon" aria-hidden>
              <Icon size={20} strokeWidth={2} />
            </span>
            <span className="theme-picker-label">{o.label}</span>
            <span className="theme-picker-hint muted">{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
