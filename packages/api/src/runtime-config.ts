/**
 * Runtime configuration: env vars win over org DB settings over defaults.
 *
 * Resolution per key:
 *   1. process.env[KEY] if the variable is set (even to "")
 *   2. org_settings.settings.runtime[KEY] from DB/file
 *   3. catalog default
 *
 * Call applyOrgRuntimeToProcess(orgId) on worker job start so code that still
 * reads process.env picks up DB values when env is unset.
 */
import { getOrgSettingsStore } from "./org-settings-store.js";

export type RuntimeValueType = "boolean" | "string" | "number" | "enum";

export interface RuntimeConfigMeta {
  key: string;
  label: string;
  description: string;
  type: RuntimeValueType;
  /** Allowed values for enum */
  enumValues?: string[];
  default: string;
  /** If true, never editable via UI (infra / security) */
  envOnly?: boolean;
  group: "review" | "graph" | "worker" | "debug" | "sandbox";
}

/** User-facing runtime knobs (safe subset). */
export const RUNTIME_CONFIG_CATALOG: RuntimeConfigMeta[] = [
  {
    key: "STEW_WORKSPACE_CLONE",
    label: "Clone target repos",
    description:
      "Clone owner/repo into a workspace for stewardship (1) instead of mounting REPO_PATH. Set 0 to force mount-only.",
    type: "enum",
    enumValues: ["0", "1", "auto"],
    default: "1",
    group: "review",
  },
  {
    key: "STEW_ALLOW_UNRELATED_MOUNT",
    label: "Allow mount fallback for remote repos",
    description:
      "Dangerous: allow reviewing REPO_PATH when clone fails for an owner/repo job. Prefer fixing clone credentials.",
    type: "boolean",
    default: "0",
    group: "review",
  },
  {
    key: "STEW_USE_DEEPAGENTS",
    label: "DeepAgents tool runners",
    description: "Use DeepAgents for specialists (1) or simple chat-only runners (0).",
    type: "boolean",
    default: "1",
    group: "review",
  },
  {
    key: "STEW_REQUIRE_TOOL_AGENTS",
    label: "Require tool agents",
    description: "Fail closed if DeepAgents cannot load (no silent simple fallback).",
    type: "boolean",
    default: "1",
    group: "review",
  },
  {
    key: "STEW_SESSION_REPORT_LLM",
    label: "LLM narrative in session report",
    description: "Add an LLM-written executive narrative for stewardship/thorough reports (0 to disable).",
    type: "boolean",
    default: "1",
    group: "review",
  },
  {
    key: "STEW_CODE_TOKEN_BUDGET",
    label: "Code pack token budget",
    description: "Approx tokens of source packed into specialist context for stewardship.",
    type: "number",
    default: "14000",
    group: "review",
  },
  {
    key: "STEW_DIFF_TOKEN_BUDGET",
    label: "Diff pack token budget",
    description: "Approx tokens of PR diff packed into gate specialist context.",
    type: "number",
    default: "12000",
    group: "review",
  },
  {
    key: "STEW_MAX_CONCURRENT",
    label: "Max concurrent specialists",
    description: "Parallel specialist runs within one job on a worker.",
    type: "number",
    default: "8",
    group: "worker",
  },
  {
    key: "STEW_JOB_LEASE_MS",
    label: "Job lease (ms)",
    description: "How long a worker holds a job before another can reclaim after crash (default 45m).",
    type: "number",
    default: "2700000",
    group: "worker",
  },
  {
    key: "STEW_JOB_STARTUP_RECLAIM_MS",
    label: "Startup reclaim age (ms)",
    description: "On worker boot, reclaim running jobs older than this (default 60s).",
    type: "number",
    default: "60000",
    group: "worker",
  },
  {
    key: "STEW_JOB_HEARTBEAT_MS",
    label: "Job lease heartbeat (ms)",
    description: "How often a running job extends its lease.",
    type: "number",
    default: "60000",
    group: "worker",
  },
  {
    key: "STEW_INLINE_WORKER",
    label: "Inline worker in API",
    description:
      "API process claims jobs (1) or only dedicated workers (0). Changing requires API restart; prefer env for deploy topology.",
    type: "boolean",
    default: "0",
    group: "worker",
  },
  {
    key: "GRAPH_MOCK",
    label: "Mock graph client",
    description: "Skip real Graph MCP (offline demo).",
    type: "boolean",
    default: "0",
    group: "graph",
  },
  {
    key: "GRAPH_MCP_URL",
    label: "Graph MCP URL",
    description: "Codesteward Graph endpoint (use …/sse for Docker TRANSPORT=sse).",
    type: "string",
    default: "http://graph-mcp:3000/sse",
    group: "graph",
  },
  {
    key: "GRAPH_MCP_HOST_HEADER",
    label: "Graph MCP Host header",
    description: "Host override for MCP SSE DNS-rebinding protection (e.g. 127.0.0.1:3000).",
    type: "string",
    default: "127.0.0.1:3000",
    group: "graph",
  },
  {
    key: "STEW_SANDBOX_PROVIDER",
    label: "Sandbox provider",
    description: "Prove/sandbox backend: null | local | docker | k8s.",
    type: "enum",
    enumValues: ["null", "local", "docker", "k8s"],
    default: "local",
    group: "sandbox",
  },
  {
    key: "STEW_DEBUG_LLM",
    label: "Debug LLM extraction",
    description: "Log extract peel/accept counts and dump responses under STEW_DATA_DIR/debug-llm.",
    type: "boolean",
    default: "0",
    group: "debug",
  },
  {
    key: "STEW_SAST",
    label: "Run SAST adapters",
    description: "Enable semgrep/gitleaks adapters when available (0 to disable).",
    type: "boolean",
    default: "1",
    group: "review",
  },
];

const byKey = new Map(RUNTIME_CONFIG_CATALOG.map((c) => [c.key, c]));

/**
 * Keys present in process.env at module load — true "operator env" overrides.
 * After applyOrgRuntimeToProcess() we may paint process.env from DB; those must
 * not be reported as source=env (would lock the UI incorrectly).
 */
const BOOT_ENV_KEYS = new Set(
  RUNTIME_CONFIG_CATALOG.map((c) => c.key).filter((k) =>
    Object.prototype.hasOwnProperty.call(process.env, k),
  ),
);

export type RuntimeConfigSource = "env" | "db" | "default";

export interface RuntimeConfigEntryView {
  key: string;
  label: string;
  description: string;
  type: RuntimeValueType;
  enumValues?: string[];
  group: string;
  default: string;
  /** Effective value after resolution */
  value: string;
  source: RuntimeConfigSource;
  envSet: boolean;
  /** Env value when set (not secret-masked; these keys are non-secret) */
  envValue?: string;
  dbValue?: string;
  editable: boolean;
  envOnly?: boolean;
}

function envIsSet(key: string): boolean {
  return BOOT_ENV_KEYS.has(key);
}

export function resolveRuntimeValue(
  key: string,
  dbRuntime: Record<string, string> | undefined,
): { value: string; source: RuntimeConfigSource; envSet: boolean; envValue?: string; dbValue?: string } {
  const meta = byKey.get(key);
  const def = meta?.default ?? "";
  const dbValue =
    dbRuntime && dbRuntime[key] !== undefined && dbRuntime[key] !== null
      ? String(dbRuntime[key])
      : undefined;
  if (envIsSet(key)) {
    return {
      value: process.env[key] ?? "",
      source: "env",
      envSet: true,
      envValue: process.env[key],
      dbValue,
    };
  }
  if (dbValue !== undefined) {
    return { value: dbValue, source: "db", envSet: false, dbValue };
  }
  return { value: def, source: "default", envSet: false, dbValue };
}

export async function loadOrgRuntimeMap(orgId: string): Promise<Record<string, string>> {
  try {
    const store = getOrgSettingsStore();
    const doc = await store.get(orgId);
    // Extended on store — see getRuntimeSettings
    const runtime = await store.getRuntimeSettings(orgId);
    return runtime;
  } catch {
    return {};
  }
}

export async function getRuntimeConfigView(orgId: string): Promise<{
  orgId: string;
  entries: RuntimeConfigEntryView[];
  note: string;
}> {
  const dbRuntime = await loadOrgRuntimeMap(orgId);
  const entries: RuntimeConfigEntryView[] = RUNTIME_CONFIG_CATALOG.map((meta) => {
    const r = resolveRuntimeValue(meta.key, dbRuntime);
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      type: meta.type,
      enumValues: meta.enumValues,
      group: meta.group,
      default: meta.default,
      value: r.value,
      source: r.source,
      envSet: r.envSet,
      envValue: r.envValue,
      dbValue: r.dbValue,
      editable: !meta.envOnly && !r.envSet,
      envOnly: meta.envOnly,
    };
  });
  return {
    orgId,
    entries,
    note:
      "Environment variables always override UI/DB values for the same key. " +
      "Clear the env var and restart (or unset in compose) to use a UI setting. " +
      "DB values apply to workers on the next job when env is unset.",
  };
}

export async function putRuntimeConfig(
  orgId: string,
  patch: Record<string, string | null | undefined>,
): Promise<{ orgId: string; entries: RuntimeConfigEntryView[] }> {
  const allowed = new Set(RUNTIME_CONFIG_CATALOG.filter((c) => !c.envOnly).map((c) => c.key));
  const cleaned: Record<string, string> = {};
  const prev = await loadOrgRuntimeMap(orgId);
  Object.assign(cleaned, prev);

  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    if (v === null || v === undefined || v === "") {
      delete cleaned[k];
      continue;
    }
    const meta = byKey.get(k);
    if (meta?.type === "boolean") {
      cleaned[k] = v === "1" || v === "true" || v === "yes" ? "1" : "0";
    } else if (meta?.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      cleaned[k] = String(Math.trunc(n));
    } else if (meta?.type === "enum" && meta.enumValues) {
      if (!meta.enumValues.includes(v)) continue;
      cleaned[k] = v;
    } else {
      cleaned[k] = String(v);
    }
  }

  await getOrgSettingsStore().putRuntimeSettings(orgId, cleaned);
  // Apply immediately for this process where env is unset
  await applyOrgRuntimeToProcess(orgId);
  const view = await getRuntimeConfigView(orgId);
  return { orgId, entries: view.entries };
}

/**
 * For keys not set in process.env, copy effective DB/default into process.env
 * so existing process.env readers pick up org UI config.
 */
export async function applyOrgRuntimeToProcess(orgId: string): Promise<void> {
  const dbRuntime = await loadOrgRuntimeMap(orgId);
  for (const meta of RUNTIME_CONFIG_CATALOG) {
    if (envIsSet(meta.key)) continue;
    const r = resolveRuntimeValue(meta.key, dbRuntime);
    if (r.source === "db") {
      process.env[meta.key] = r.value;
    }
  }
}

/** Sync helper for code paths with only env today — prefers env, then process (after apply). */
export function runtimeEnv(key: string, fallback?: string): string {
  if (envIsSet(key)) return process.env[key] ?? "";
  if (process.env[key] !== undefined) return process.env[key] ?? "";
  const meta = byKey.get(key);
  return fallback ?? meta?.default ?? "";
}
