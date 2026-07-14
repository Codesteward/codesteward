import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { Badge, EmptyState, PageHero, SkeletonLines } from "../components/ui";
import { Select } from "../components/Select";
import {
  MustacheBlock,
  MustacheEditor,
  MustacheVarChips,
  highlightMustache,
} from "../components/MustacheHighlight";
import { api } from "../lib/api";

type PromptComponent = {
  id: string;
  label: string;
  description?: string;
  kind: "editable" | "runtime" | "learning" | "system";
  body: string;
  vars?: string[];
  omitIfEmptyVars?: string[];
};

type RoleTemplate = {
  role: string;
  system: PromptComponent[];
  user: PromptComponent[];
};

type PromptPack = {
  version: 1;
  roles: Record<string, RoleTemplate>;
  updatedAt?: string;
};

type Preview = {
  system: string;
  user: string;
  components: Array<PromptComponent & { rendered: string; locked: boolean }>;
};

function kindBadge(kind: string) {
  if (kind === "learning") return <Badge tone="steward">learning · locked</Badge>;
  if (kind === "runtime") return <Badge tone="gate">runtime · locked</Badge>;
  if (kind === "system") return <Badge tone="warn">system · locked</Badge>;
  return <Badge tone="ok">editable</Badge>;
}

export function Prompts() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [role, setRole] = useState("security");
  const [pack, setPack] = useState<PromptPack | null>(null);
  const [effective, setEffective] = useState<PromptPack | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [learningChars, setLearningChars] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [showPreview, setShowPreview] = useState(true);
  const [limits, setLimits] = useState<{
    components: Record<string, number>;
    roleEditableSystemMax: number;
    roleEditableUserMax: number;
  } | null>(null);

  const roleTpl = effective?.roles?.[role];

  const DEFAULT_COMPONENT_MAX: Record<string, number> = {
    persona: 2000,
    grounding: 3000,
    deep_tools: 3000,
    severity: 800,
    user_header: 1500,
  };

  function maxFor(id: string): number {
    return limits?.components?.[id] ?? DEFAULT_COMPONENT_MAX[id] ?? 2000;
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getPromptPack(role);
      const eff = res.effective as PromptPack;
      setPack((res.pack as PromptPack | null) ?? null);
      setEffective(eff);
      setRoles(
        res.roles?.length
          ? res.roles
          : Object.keys((eff && eff.roles) || {}),
      );
      setPreview(res.preview as Preview);
      setLearningChars(res.learningPreviewChars ?? 0);
      setNote(res.note ?? "");
      if (res.limits) setLimits(res.limits);
      else if (res.catalog?.length) {
        const components: Record<string, number> = {};
        for (const c of res.catalog) {
          if (typeof c.maxChars === "number") components[c.id] = c.maxChars;
        }
        setLimits({
          components,
          roleEditableSystemMax: 8000,
          roleEditableUserMax: 2500,
        });
      }
      setDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [role, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshPreview(nextPack?: PromptPack | null) {
    try {
      const res = await api.previewPromptPack({
        role,
        pack: nextPack ?? effective ?? undefined,
      });
      setPreview(res.preview as Preview);
      setLearningChars(res.learningPreviewChars ?? 0);
    } catch {
      /* preview best-effort */
    }
  }

  function updateComponent(section: "system" | "user", id: string, body: string) {
    if (!effective) return;
    const tpl = effective.roles[role];
    if (!tpl) return;
    const max = maxFor(id);
    const clipped = body.length > max ? body.slice(0, max) : body;
    const list = section === "system" ? tpl.system : tpl.user;
    const nextList = list.map((c) =>
      c.id === id && c.kind === "editable" ? { ...c, body: clipped } : c,
    );
    const next: PromptPack = {
      ...effective,
      roles: {
        ...effective.roles,
        [role]: {
          ...tpl,
          [section]: nextList,
        },
      },
    };
    setEffective(next);
    setDirty(true);
    void refreshPreview(next);
  }

  const roleBudget = useMemo(() => {
    const systemMax = limits?.roleEditableSystemMax ?? 8000;
    const userMax = limits?.roleEditableUserMax ?? 2500;
    if (!roleTpl) return { system: 0, user: 0, systemMax, userMax };
    const sum = (arr: PromptComponent[]) =>
      arr.reduce((s, c) => s + (c.kind === "editable" ? c.body.length : 0), 0);
    return {
      system: sum(roleTpl.system),
      user: sum(roleTpl.user),
      systemMax,
      userMax,
    };
  }, [roleTpl, limits]);

  async function save() {
    if (!effective) return;
    setSaving(true);
    try {
      const res = await api.putPromptPack({ pack: effective });
      setPack(res.effective as PromptPack);
      setEffective(res.effective as PromptPack);
      setDirty(false);
      toast.success("Prompt pack saved for this org");
      await refreshPreview(res.effective as PromptPack);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    if (!confirm("Reset all org prompt customizations to product defaults?")) return;
    setSaving(true);
    try {
      const res = await api.putPromptPack({ reset: true });
      setPack(null);
      setEffective(res.effective as PromptPack);
      setDirty(false);
      toast.success("Prompts reset to defaults");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const components = useMemo(() => {
    if (!roleTpl) return [];
    return [
      ...roleTpl.system.map((c) => ({ ...c, section: "system" as const })),
      ...roleTpl.user.map((c) => ({ ...c, section: "user" as const })),
    ];
  }, [roleTpl]);

  return (
    <div>
      <PageHero
        kicker="Platform"
        title="Prompts"
        subtitle="Per-org specialist prompts. Persona and guidance are editable; JSON output format, learning, and runtime context are locked so the review pipeline cannot be broken."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="ghost sm" onClick={() => void load()} disabled={loading}>
              Reload
            </button>
            <button type="button" className="ghost sm" onClick={() => void resetDefaults()} disabled={saving}>
              Reset defaults
            </button>
            <button type="button" className="primary sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "Saving…" : dirty ? "Save pack" : "Saved"}
            </button>
          </div>
        }
      />

      {note && (
        <div className="banner ok" style={{ marginBottom: "1rem" }}>
          {note}{" "}
          <Link to="/learnings" style={{ marginLeft: 6 }}>
            Manage learnings →
          </Link>
        </div>
      )}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0, minWidth: 200 }}>
            <label>Specialist role</label>
            <Select
              value={role}
              onChange={(v) => {
                setRole(v);
                setDirty(false);
              }}
              options={roles.map((r) => ({ value: r, label: r }))}
              aria-label="Prompt role"
            />
          </div>
          <div className="muted" style={{ fontSize: "0.82rem", paddingBottom: 6 }}>
            Live learning block:{" "}
            <strong className="mono">{learningChars}</strong> chars
            {learningChars > 0 ? " (injected in preview)" : " (empty until feedback)"}
            {pack ? " · org customizations active" : " · using product defaults"}
            {dirty ? " · unsaved edits" : ""}
            {roleTpl && (
              <>
                {" · "}
                <span
                  className={`mustache-role-budget mono${
                    roleBudget.system > roleBudget.systemMax || roleBudget.user > roleBudget.userMax
                      ? " over"
                      : ""
                  }`}
                >
                  role budget sys {roleBudget.system}/{roleBudget.systemMax} · user{" "}
                  {roleBudget.user}/{roleBudget.userMax}
                </span>
              </>
            )}
          </div>
          <label className="row" style={{ gap: 6, fontSize: "0.85rem", paddingBottom: 6 }}>
            <input
              type="checkbox"
              checked={showPreview}
              onChange={(e) => setShowPreview(e.target.checked)}
            />
            Show rendered preview
          </label>
        </div>
      </div>

      {loading ? (
        <SkeletonLines lines={8} />
      ) : !roleTpl ? (
        <EmptyState
          title="No template for this role"
          description="Reset to defaults or pick another specialist role."
        />
      ) : (
        <div className="grid cols-2" style={{ alignItems: "start", gap: "1rem" }}>
          <div className="stack" style={{ gap: "0.75rem" }}>
            {components.map((c) => {
              const locked = c.kind !== "editable";
              return (
                <div key={`${c.section}-${c.id}`} className="card stack" style={{ gap: 8 }}>
                  <div className="card-header" style={{ alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{c.label}</div>
                      <div className="muted" style={{ fontSize: "0.75rem" }}>
                        {c.section} · <span className="mono">{c.id}</span>
                      </div>
                    </div>
                    {kindBadge(c.kind)}
                  </div>
                  {c.description && (
                    <p className="muted" style={{ fontSize: "0.8rem", margin: 0, lineHeight: 1.45 }}>
                      {c.description}
                    </p>
                  )}
                  {c.vars && c.vars.length > 0 && (
                    <MustacheVarChips
                      vars={c.vars}
                      onInsert={
                        locked
                          ? undefined
                          : (token) =>
                              updateComponent(
                                c.section,
                                c.id,
                                c.body.endsWith(" ") || c.body.endsWith("\n") || !c.body
                                  ? `${c.body}${token}`
                                  : `${c.body}${token}`,
                              )
                      }
                    />
                  )}
                  {locked ? (
                    <MustacheBlock
                      text={c.body}
                      dashed
                      footer={
                        <>
                          {c.kind === "learning" && (
                            <span
                              style={{
                                display: "block",
                                marginTop: 8,
                                color: "var(--accent)",
                                fontSize: "0.78rem",
                              }}
                            >
                              ↳ Populated at review from org feedback (not editable here)
                            </span>
                          )}
                          {c.kind === "system" && (
                            <span
                              style={{
                                display: "block",
                                marginTop: 8,
                                color: "var(--warn)",
                                fontSize: "0.78rem",
                              }}
                            >
                              ↳ Locked product contract — required so specialists / DeepAgents can parse
                              findings
                            </span>
                          )}
                          {c.kind === "runtime" && (
                            <span
                              style={{
                                display: "block",
                                marginTop: 8,
                                color: "var(--text-faint)",
                                fontSize: "0.78rem",
                              }}
                            >
                              ↳ Filled automatically at review time — highlighted{" "}
                              <mark className="mustache-token">{"{{vars}}"}</mark> are placeholders
                            </span>
                          )}
                        </>
                      }
                    />
                  ) : (
                    <MustacheEditor
                      value={c.body}
                      onChange={(v) => updateComponent(c.section, c.id, v)}
                      maxLength={maxFor(c.id)}
                      aria-label={`${c.label} template`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {showPreview && (
            <div className="card stack" style={{ position: "sticky", top: 12, gap: 10 }}>
              <div className="card-header">
                <h3 className="card-title">Rendered preview · {role}</h3>
              </div>
              <p className="muted" style={{ fontSize: "0.78rem", margin: 0, lineHeight: 1.45 }}>
                Sample vars + live org learning. This is the structure specialists receive
                (system then user).
              </p>
              {!preview ? (
                <SkeletonLines lines={6} />
              ) : (
                <>
                  <div>
                    <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
                      SYSTEM
                    </div>
                    <div
                      className="mustache-block mono"
                      style={{ maxHeight: 320, overflow: "auto", fontSize: "0.72rem" }}
                    >
                      <pre className="mustache-pre" style={{ color: "var(--text-secondary)" }}>
                        {highlightMustache(preview.system)}
                      </pre>
                    </div>
                  </div>
                  <div>
                    <div className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
                      USER
                    </div>
                    <div
                      className="mustache-block mono"
                      style={{ maxHeight: 220, overflow: "auto", fontSize: "0.72rem" }}
                    >
                      <pre className="mustache-pre" style={{ color: "var(--text-secondary)" }}>
                        {highlightMustache(preview.user)}
                      </pre>
                    </div>
                  </div>
                  {preview.system.includes("Org learning") && (
                    <div className="banner ok" style={{ margin: 0, fontSize: "0.8rem" }}>
                      Org learning block is present in the system prompt preview
                      {learningChars > 0 ? ` (${learningChars} live chars).` : " (placeholder until feedback)."}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
