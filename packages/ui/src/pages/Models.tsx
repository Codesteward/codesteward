import { useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { Badge, PageHero } from "../components/ui";
import { Select } from "../components/Select";
import { api, type ModelProfile } from "../lib/api";
import { OrgLangfusePanel } from "./settings/panels";

const PROVIDERS = [
  { id: "openai", label: "OpenAI", keyLabel: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", keyLabel: "ANTHROPIC_API_KEY" },
  { id: "xai", label: "SpaceXAI", keyLabel: "SPACEXAI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", keyLabel: "OPENROUTER_API_KEY" },
  { id: "openai-compatible", label: "OpenAI-compatible", keyLabel: "API key" },
  { id: "litellm", label: "LiteLLM", keyLabel: "API key" },
] as const;

const DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  litellm: "http://localhost:4000",
};

const STAGE_HINTS: Record<string, string> = {
  default: "Fallback for roles without override",
  judge:
    "Strong-tier routing for noise/judge stack (not a separate multi-model adjudication stage)",
  security: "Security specialist",
  correctness: "Correctness specialist",
  evidence: "Evidence / graph grounding",
  discourse: "Thorough dual-pass discourse",
  verifier: "Verifier / self-check",
  prove: "Prove / test generation (license-gated on OSS)",
  summary: "Cheap summarization",
  coordinator: "Orchestration / planning",
  generalist: "General specialist",
  performance: "Performance specialist",
  testing: "Testing specialist",
  rules: "Rules / policy specialist",
  requirements: "Requirements specialist",
};

/** Per-stage override: provider + model only. Keys come from org Providers section. */
type RoleRow = { provider?: string; model?: string; baseUrl?: string };
type ProviderForm = { apiKey: string; baseUrl: string; apiKeySet: boolean };

const emptyProviderForm = (): ProviderForm => ({ apiKey: "", baseUrl: "", apiKeySet: false });

export function Models() {
  const toast = useToast();
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [strongModel, setStrong] = useState("");
  const [cheapModel, setCheap] = useState("");
  const [roles, setRoles] = useState<Record<string, RoleRow>>({});
  const [roleList, setRoleList] = useState<string[]>(Object.keys(STAGE_HINTS));
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderForm>>(() => {
    const init: Record<string, ProviderForm> = {};
    for (const p of PROVIDERS) init[p.id] = emptyProviderForm();
    return init;
  });

  function applyProfile(p: ModelProfile) {
    setProfile(p);
    setProvider(p.provider || "openai");
    setModel(p.model || "");
    setStrong(p.strongModel || "");
    setCheap(p.cheapModel || "");
    // Drop legacy apiKeyRef fields if present — keys live under Providers only
    const cleaned: Record<string, RoleRow> = {};
    for (const [role, row] of Object.entries(p.roleMatrix ?? {})) {
      const r = row as RoleRow & { apiKeyRef?: string };
      cleaned[role] = {
        provider: r.provider,
        model: r.model,
        baseUrl: r.baseUrl,
      };
    }
    setRoles(cleaned);
    if (p.availableRoles?.length) setRoleList(p.availableRoles);
    setProviderKeys((prev) => {
      const next = { ...prev };
      for (const pr of PROVIDERS) {
        const masked = p.providers?.[pr.id];
        const fallbackBase =
          pr.id === "openai"
            ? (p.openaiBaseUrl ?? DEFAULT_BASE_URL.openai)
            : pr.id === "litellm"
              ? (p.litellmBaseUrl ?? DEFAULT_BASE_URL.litellm)
              : pr.id === "openrouter"
                ? (p.openrouterBaseUrl ?? DEFAULT_BASE_URL.openrouter)
                : (DEFAULT_BASE_URL[pr.id] ?? prev[pr.id]?.baseUrl ?? "");
        next[pr.id] = {
          apiKey: "",
          baseUrl: masked?.baseUrl ?? fallbackBase ?? prev[pr.id]?.baseUrl ?? "",
          apiKeySet: Boolean(masked?.apiKeySet) ||
            (pr.id === "openai" && p.hasOpenAI) ||
            (pr.id === "anthropic" && p.hasAnthropic) ||
            (pr.id === "xai" && p.hasXai) ||
            (pr.id === "openrouter" && p.hasOpenRouter) ||
            false,
        };
      }
      return next;
    });
  }

  useEffect(() => {
    api
      .models()
      .then(applyProfile)
      .catch(() => setProfile(null))
      .finally(() => setLoading(false));
  }, []);

  function setRole(role: string, patch: Partial<RoleRow>) {
    setRoles((r) => ({ ...r, [role]: { ...r[role], ...patch } }));
  }

  function setProviderField(id: string, patch: Partial<ProviderForm>) {
    setProviderKeys((p) => ({ ...p, [id]: { ...p[id]!, ...patch } }));
  }

  async function saveMatrix() {
    setSaving(true);
    try {
      const providers: Record<string, { apiKey?: string; baseUrl?: string }> = {};
      for (const pr of PROVIDERS) {
        const row = providerKeys[pr.id] ?? emptyProviderForm();
        providers[pr.id] = {
          baseUrl: row.baseUrl || undefined,
          // empty = keep existing; only send key when user typed a new value
          apiKey: row.apiKey.trim() || undefined,
        };
      }
      // Per-stage matrix: provider + model only (no env: key refs — use Providers above)
      const rolesOut: Record<string, RoleRow> = {};
      for (const [role, row] of Object.entries(roles)) {
        if (!row?.provider && !row?.model && !row?.baseUrl) continue;
        rolesOut[role] = {
          provider: row.provider,
          model: row.model,
          baseUrl: row.baseUrl,
        };
      }
      await api.putModels({
        defaultProvider: provider,
        defaultModel: model,
        strongModel,
        cheapModel,
        roles: rolesOut,
        providers,
      });
      toast.success("Model settings saved for this org (keys encrypted at rest)");
      const p = await api.models();
      applyProfile(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearProviderKey(id: string) {
    setSaving(true);
    try {
      await api.putModels({
        providers: { [id]: { apiKey: "__clear__" } },
      });
      toast.info(`${id} API key cleared for this org`);
      const p = await api.models();
      applyProfile(p);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function testRole(role: string) {
    setTesting(role);
    setTestResult(null);
    try {
      const res = await api.testModel({ role });
      setTestResult(`${role}: ${res.provider}/${res.model} → ${res.content}`);
      toast.success(`Test OK (${role})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestResult(msg);
      toast.error("Connection test failed — check org provider keys or model name");
    } finally {
      setTesting(null);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHero kicker="BYOK" title="Models" subtitle="Loading…" />
        <div className="skeleton block" style={{ height: 200 }} />
      </div>
    );
  }

  return (
    <div>
      <PageHero
        kicker="Org · multi-tenant"
        title="Models"
        subtitle="Configure providers and stage models for this Codesteward org from the UI. API keys are stored encrypted per org — host env is only a single-tenant fallback."
        actions={
          <button type="button" className="primary" disabled={saving} onClick={() => void saveMatrix()}>
            {saving ? "Saving…" : "Save for this org"}
          </button>
        }
      />

      {profile?.note && (
        <div className="banner ok" style={{ marginBottom: "1rem" }}>
          {profile.note}
        </div>
      )}

      <div className="card stack" style={{ marginBottom: "1rem" }}>
        <div className="card-header">
          <h3>Provider API keys (this org)</h3>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            Leave key blank to keep the current value · never written to process.env in multi-org
          </span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>API key</th>
                <th>Base URL (optional)</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((pr) => {
                const row = providerKeys[pr.id] ?? emptyProviderForm();
                return (
                  <tr key={pr.id}>
                    <td style={{ fontWeight: 600 }}>{pr.label}</td>
                    <td>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={row.apiKey}
                        onChange={(e) => setProviderField(pr.id, { apiKey: e.target.value })}
                        placeholder={row.apiKeySet ? "•••• set — paste to replace" : `Paste ${pr.keyLabel}`}
                        style={{ minWidth: 200 }}
                      />
                    </td>
                    <td>
                      <input
                        value={row.baseUrl}
                        onChange={(e) => setProviderField(pr.id, { baseUrl: e.target.value })}
                        placeholder={
                          pr.id === "openai"
                            ? "https://api.openai.com/v1"
                            : pr.id === "openrouter"
                              ? "https://openrouter.ai/api/v1"
                            : pr.id === "anthropic"
                              ? "https://api.anthropic.com"
                              : pr.id === "xai"
                                ? "https://api.x.ai/v1"
                                : "https://…"
                        }
                        style={{ minWidth: 180 }}
                      />
                    </td>
                    <td>
                      <Badge tone={row.apiKeySet ? "ok" : "nit"}>
                        {row.apiKeySet ? "key set" : "not set"}
                      </Badge>
                    </td>
                    <td>
                      {row.apiKeySet && (
                        <button
                          type="button"
                          className="danger sm"
                          disabled={saving}
                          onClick={() => void clearProviderKey(pr.id)}
                        >
                          Clear key
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: "1rem" }}>
        <div className="card stack">
          <h3>Org defaults</h3>
          <div className="field">
            <label>Default provider</label>
            <Select
              value={provider}
              onChange={setProvider}
              aria-label="Default provider"
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <div className="field">
            <label>Default / specialist model</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                provider === "openrouter"
                  ? "openai/gpt-4.1 or anthropic/claude-sonnet-4"
                  : "claude-sonnet-4… / gpt-4.1"
              }
            />
          </div>
          <div className="field">
            <label>Strong tier (security / discourse / prove)</label>
            <input
              value={strongModel}
              onChange={(e) => setStrong(e.target.value)}
              placeholder={
                provider === "openrouter"
                  ? "anthropic/claude-sonnet-4"
                  : "claude-opus-4…"
              }
            />
          </div>
          <div className="field">
            <label>Cheap tier (summary)</label>
            <input
              value={cheapModel}
              onChange={(e) => setCheap(e.target.value)}
              placeholder={
                provider === "openrouter" ? "openai/gpt-4.1-mini" : "…-mini / haiku"
              }
            />
          </div>
        </div>

        <div className="card stack">
          <h3>Effective runtime</h3>
          <div className="row">
            <span className="muted">Default</span>
            <Badge tone="ok">
              {provider}/{model || profile?.model || "—"}
            </Badge>
          </div>
          <div className="row">
            <span className="muted">Strong</span>
            <span className="mono">{strongModel || profile?.strongModel || "—"}</span>
          </div>
          <div className="row">
            <span className="muted">Cheap</span>
            <span className="mono">{cheapModel || profile?.cheapModel || "—"}</span>
          </div>
          <div className="row">
            <span className="muted">Source</span>
            <span className="mono">{profile?.source ?? "org"}</span>
          </div>
          {testResult && (
            <pre className="mono" style={{ fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
              {testResult}
            </pre>
          )}
          <p className="muted" style={{ fontSize: "0.78rem", margin: 0, lineHeight: 1.45 }}>
            Reviews for this org use these settings via the worker. Host env keys apply only if an org key is
            missing (single-tenant dogfood).
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Per-stage matrix (optional)</h3>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            Empty model → inherits strong/default/cheap. API keys always come from{" "}
            <strong>Provider API keys</strong> above (by provider), not per stage.
          </span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Provider</th>
                <th>Model</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roleList.map((role) => {
                const row = roles[role] ?? {};
                return (
                  <tr key={role}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{role}</div>
                      <div className="muted" style={{ fontSize: "0.72rem" }}>
                        {STAGE_HINTS[role] ?? "Specialist / pipeline stage"}
                      </div>
                    </td>
                    <td>
                      <Select
                        value={row.provider ?? ""}
                        onChange={(v) => setRole(role, { provider: v || undefined })}
                        size="sm"
                        style={{ minWidth: 120 }}
                        aria-label={`Provider for ${role}`}
                        options={[
                          { value: "", label: "(default)" },
                          ...PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
                        ]}
                      />
                    </td>
                    <td>
                      <input
                        value={row.model ?? ""}
                        onChange={(e) => setRole(role, { model: e.target.value || undefined })}
                        placeholder="inherit"
                        style={{ minWidth: 160 }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sm"
                        disabled={testing === role}
                        onClick={() => void testRole(role)}
                      >
                        {testing === role ? "…" : "Test"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Optional LLM observability — same pattern as org provider keys */}
      <div style={{ marginTop: "1.25rem" }}>
        <OrgLangfusePanel />
      </div>
    </div>
  );
}
