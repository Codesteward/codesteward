/**
 * Runtime configuration (install + org).
 *
 * Most knobs are **platform / install-wide** (clone, DeepAgents, graph, worker, …).
 * Org-overridable keys (when platform is Unset): STEW_SUGGESTED_CODE_FIXES,
 * STEW_PUBLISH_SARIF.
 *
 * Resolution order per key:
 *   1. Boot process.env (operator pin — always wins)
 *   2. Platform store (install-wide UI)
 *   3. Org store — only for keys in ORG_OVERRIDABLE_RUNTIME_KEYS, and only when
 *      platform has no explicit value for that key
 *   4. Catalog default
 *
 * Call applyOrgRuntimeToProcess(orgId) on worker job start so process.env
 * readers pick up platform + org UI values when env is unset.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getOrgSettingsStore } from "./org-settings-store.js";

export type RuntimeValueType = "boolean" | "string" | "number" | "enum";

export interface RuntimeConfigMeta {
  key: string;
  label: string;
  description: string;
  type: RuntimeValueType;
  enumValues?: string[];
  default: string;
  /** If true, never editable via UI (infra / security) */
  envOnly?: boolean;
  /**
   * platform = install-wide only (default).
   * org = org may override when platform is unset (and env unset).
   */
  scope?: "platform" | "org";
  group: "review" | "graph" | "worker" | "debug" | "sandbox";
}

/** Keys orgs may set when platform leaves them unset. */
export const ORG_OVERRIDABLE_RUNTIME_KEYS = new Set([
  "STEW_SUGGESTED_CODE_FIXES",
  "STEW_PUBLISH_SARIF",
]);

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
    scope: "platform",
  },
  {
    key: "STEW_ALLOW_UNRELATED_MOUNT",
    label: "Allow mount fallback for remote repos",
    description:
      "Dangerous: allow reviewing REPO_PATH when clone fails for an owner/repo job. Prefer fixing clone credentials.",
    type: "boolean",
    default: "0",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_USE_DEEPAGENTS",
    label: "DeepAgents tool runners",
    description: "Use DeepAgents for specialists (1) or simple chat-only runners (0).",
    type: "boolean",
    default: "1",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_REQUIRE_TOOL_AGENTS",
    label: "Require tool agents",
    description: "Fail closed if DeepAgents cannot load (no silent simple fallback).",
    type: "boolean",
    default: "1",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_SESSION_REPORT_LLM",
    label: "LLM narrative in session report",
    description: "Add an LLM-written executive narrative for stewardship/thorough reports (0 to disable).",
    type: "boolean",
    default: "1",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_CODE_TOKEN_BUDGET",
    label: "Code pack token budget",
    description: "Approx tokens of source packed into specialist context for stewardship.",
    type: "number",
    default: "14000",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_DIFF_TOKEN_BUDGET",
    label: "Diff pack token budget",
    description: "Approx tokens of PR diff packed into gate specialist context.",
    type: "number",
    default: "12000",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_MAX_CONCURRENT",
    label: "Max concurrent specialists",
    description: "Parallel specialist runs within one job on a worker.",
    type: "number",
    default: "8",
    group: "worker",
    scope: "platform",
  },
  {
    key: "STEW_JOB_LEASE_MS",
    label: "Job lease (ms)",
    description: "How long a worker holds a job before another can reclaim after crash (default 45m).",
    type: "number",
    default: "2700000",
    group: "worker",
    scope: "platform",
  },
  {
    key: "STEW_JOB_STARTUP_RECLAIM_MS",
    label: "Startup reclaim age (ms)",
    description: "On worker boot, reclaim running jobs older than this (default 60s).",
    type: "number",
    default: "60000",
    group: "worker",
    scope: "platform",
  },
  {
    key: "STEW_JOB_HEARTBEAT_MS",
    label: "Job lease heartbeat (ms)",
    description: "How often a running job extends its lease.",
    type: "number",
    default: "60000",
    group: "worker",
    scope: "platform",
  },
  {
    key: "STEW_INLINE_WORKER",
    label: "Inline worker in API",
    description:
      "API process claims jobs (1) or only dedicated workers (0). Changing requires API restart; prefer env for deploy topology.",
    type: "boolean",
    default: "0",
    group: "worker",
    scope: "platform",
  },
  {
    key: "GRAPH_MOCK",
    label: "Mock graph client",
    description: "Skip real Graph MCP (offline demo).",
    type: "boolean",
    default: "0",
    group: "graph",
    scope: "platform",
  },
  {
    key: "GRAPH_MCP_URL",
    label: "Graph MCP URL",
    description: "Codesteward Graph endpoint (use …/sse for Docker TRANSPORT=sse).",
    type: "string",
    default: "http://graph-mcp:3000/sse",
    group: "graph",
    scope: "platform",
  },
  {
    key: "GRAPH_MCP_HOST_HEADER",
    label: "Graph MCP Host header",
    description: "Host override for MCP SSE DNS-rebinding protection (e.g. 127.0.0.1:3000).",
    type: "string",
    default: "127.0.0.1:3000",
    group: "graph",
    scope: "platform",
  },
  {
    key: "STEW_SANDBOX_PROVIDER",
    label: "Sandbox provider",
    description: "Prove/sandbox backend: null | local | docker | k8s.",
    type: "enum",
    enumValues: ["null", "local", "docker", "k8s"],
    default: "local",
    group: "sandbox",
    scope: "platform",
  },
  {
    key: "STEW_DEBUG_LLM",
    label: "Debug LLM extraction",
    description: "Log extract peel/accept counts and dump responses under STEW_DATA_DIR/debug-llm.",
    type: "boolean",
    default: "0",
    group: "debug",
    scope: "platform",
  },
  {
    key: "STEW_SAST",
    label: "Run SAST adapters",
    description: "Enable semgrep/gitleaks adapters when available (0 to disable).",
    type: "boolean",
    default: "1",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_SUGGESTED_CODE_FIXES",
    label: "Suggested code fixes",
    description:
      "Install policy for concrete code snippets on findings. Unset = each org may choose. Off/On = force for all orgs (org UI locked).",
    type: "boolean",
    default: "0",
    group: "review",
    scope: "org",
  },
  {
    key: "STEW_SUGGESTED_FIX_MIN_CONFIDENCE",
    label: "Min confidence for code fixes",
    description:
      "Platform-wide: only attach suggestedFix when finding confidence is at least this value (0–1). Plain-text suggestion is always kept. Default 0.75 — reduces low-confidence fix snippets that may introduce new issues.",
    type: "number",
    default: "0.75",
    group: "review",
    scope: "platform",
  },
  {
    key: "STEW_PUBLISH_SARIF",
    label: "Publish SARIF to GitHub Code Scanning",
    description:
      "Upload findings SARIF to GitHub Security → Code scanning on PR gate publish. Unset = each org may choose (product default On). Off/On = force for all orgs. Requires code scanning enabled and security_events: write on the GitHub App/token.",
    type: "boolean",
    default: "1",
    group: "review",
    scope: "org",
  },
];

const byKey = new Map(RUNTIME_CONFIG_CATALOG.map((c) => [c.key, c]));

/**
 * Keys present in process.env at module load — true "operator env" overrides.
 * After applyOrgRuntimeToProcess() we may paint process.env from stores; those must
 * not be reported as source=env (would lock the UI incorrectly).
 */
const BOOT_ENV_KEYS = new Set(
  RUNTIME_CONFIG_CATALOG.map((c) => c.key).filter((k) =>
    Object.prototype.hasOwnProperty.call(process.env, k),
  ),
);

export type RuntimeConfigSource = "env" | "platform" | "org" | "default";

export interface RuntimeConfigEntryView {
  key: string;
  label: string;
  description: string;
  type: RuntimeValueType;
  enumValues?: string[];
  group: string;
  default: string;
  scope: "platform" | "org";
  /** Effective value after full resolution */
  value: string;
  source: RuntimeConfigSource;
  envSet: boolean;
  envValue?: string;
  platformValue?: string;
  orgValue?: string;
  /** UI may write this layer */
  editable: boolean;
  envOnly?: boolean;
  /**
   * For org-overridable keys: false when platform or env pins the value.
   */
  orgEditable?: boolean;
}

function envIsSet(key: string): boolean {
  return BOOT_ENV_KEYS.has(key);
}

function platformRuntimePath(): string {
  return join(process.env.STEW_DATA_DIR ?? ".steward-data", "platform-runtime.json");
}

export async function loadPlatformRuntimeMap(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(platformRuntimePath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function savePlatformRuntimeMap(
  runtime: Record<string, string>,
): Promise<void> {
  await mkdir(process.env.STEW_DATA_DIR ?? ".steward-data", { recursive: true });
  await writeFile(platformRuntimePath(), JSON.stringify(runtime, null, 2) + "\n", "utf8");
}

export async function loadOrgRuntimeMap(orgId: string): Promise<Record<string, string>> {
  try {
    return await getOrgSettingsStore().getRuntimeSettings(orgId);
  } catch {
    return {};
  }
}

function normalizeStored(
  key: string,
  v: string,
): string | null {
  const meta = byKey.get(key);
  if (!meta) return null;
  if (meta.type === "boolean") {
    return v === "1" || v === "true" || v === "yes" || v === "on" ? "1" : "0";
  }
  if (meta.type === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    // Unit-interval platform knobs (confidence 0–1); others stay integers
    if (meta.key === "STEW_SUGGESTED_FIX_MIN_CONFIDENCE") {
      return String(Math.min(1, Math.max(0, Math.round(n * 1000) / 1000)));
    }
    return String(Math.trunc(n));
  }
  if (meta.type === "enum" && meta.enumValues) {
    if (!meta.enumValues.includes(v)) return null;
    return v;
  }
  return String(v);
}

function applyPatchToMap(
  prev: Record<string, string>,
  patch: Record<string, string | null | undefined>,
  allowed: Set<string>,
): Record<string, string> {
  const cleaned: Record<string, string> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    if (v === null || v === undefined || v === "") {
      delete cleaned[k];
      continue;
    }
    const n = normalizeStored(k, v);
    if (n === null) continue;
    cleaned[k] = n;
  }
  return cleaned;
}

/**
 * Full resolution for a key given platform + org maps.
 */
export function resolveRuntimeValue(
  key: string,
  platformRuntime: Record<string, string> | undefined,
  orgRuntime?: Record<string, string> | undefined,
): {
  value: string;
  source: RuntimeConfigSource;
  envSet: boolean;
  envValue?: string;
  platformValue?: string;
  orgValue?: string;
} {
  const meta = byKey.get(key);
  const def = meta?.default ?? "";
  const platformValue =
    platformRuntime &&
    platformRuntime[key] !== undefined &&
    platformRuntime[key] !== null &&
    platformRuntime[key] !== ""
      ? String(platformRuntime[key])
      : undefined;
  const orgValue =
    orgRuntime &&
    orgRuntime[key] !== undefined &&
    orgRuntime[key] !== null &&
    orgRuntime[key] !== ""
      ? String(orgRuntime[key])
      : undefined;

  if (envIsSet(key)) {
    return {
      value: process.env[key] ?? "",
      source: "env",
      envSet: true,
      envValue: process.env[key],
      platformValue,
      orgValue,
    };
  }
  if (platformValue !== undefined) {
    return {
      value: platformValue,
      source: "platform",
      envSet: false,
      platformValue,
      orgValue,
    };
  }
  if (ORG_OVERRIDABLE_RUNTIME_KEYS.has(key) && orgValue !== undefined) {
    return {
      value: orgValue,
      source: "org",
      envSet: false,
      platformValue,
      orgValue,
    };
  }
  return {
    value: def,
    source: "default",
    envSet: false,
    platformValue,
    orgValue,
  };
}

/** @deprecated — use resolveRuntimeValue(key, platform, org) */
export function resolveRuntimeValueLegacy(
  key: string,
  dbRuntime: Record<string, string> | undefined,
): ReturnType<typeof resolveRuntimeValue> {
  // Old callers treated "db" as org; map to org layer only
  return resolveRuntimeValue(key, {}, dbRuntime);
}

function entryFromMeta(
  meta: RuntimeConfigMeta,
  r: ReturnType<typeof resolveRuntimeValue>,
  layer: "platform" | "org",
): RuntimeConfigEntryView {
  const scope = meta.scope === "org" || ORG_OVERRIDABLE_RUNTIME_KEYS.has(meta.key) ? "org" : "platform";
  const orgKey = ORG_OVERRIDABLE_RUNTIME_KEYS.has(meta.key);

  let editable = !meta.envOnly && !r.envSet;
  let orgEditable = false;

  if (layer === "platform") {
    // Platform UI edits platform store for all catalog keys (except env-only)
    editable = !meta.envOnly && !r.envSet;
  } else {
    // Org UI: only org-overridable keys, and only when env + platform leave them free
    orgEditable =
      orgKey && !r.envSet && r.platformValue === undefined && !meta.envOnly;
    editable = orgEditable;
  }

  return {
    key: meta.key,
    label: meta.label,
    description: meta.description,
    type: meta.type,
    enumValues: meta.enumValues,
    group: meta.group,
    default: meta.default,
    scope,
    value: r.value,
    source: r.source,
    envSet: r.envSet,
    envValue: r.envValue,
    platformValue: r.platformValue,
    orgValue: r.orgValue,
    editable,
    envOnly: meta.envOnly,
    orgEditable,
  };
}

/** Platform install-wide runtime view (all catalog keys). */
export async function getPlatformRuntimeConfigView(): Promise<{
  entries: RuntimeConfigEntryView[];
  note: string;
}> {
  const platformRuntime = await loadPlatformRuntimeMap();
  const entries = RUNTIME_CONFIG_CATALOG.map((meta) => {
    const r = resolveRuntimeValue(meta.key, platformRuntime, {});
    return entryFromMeta(meta, r, "platform");
  });
  return {
    entries,
    note:
      "Install-wide settings for this Codesteward process fleet. " +
      "Process environment variables always win until removed and the process restarts. " +
      "Org-overridable policies (Suggested code fixes, Publish SARIF): leave Unset so each organization can choose; set Off/On to force every org.",
  };
}

export async function putPlatformRuntimeConfig(
  patch: Record<string, string | null | undefined>,
): Promise<{ entries: RuntimeConfigEntryView[] }> {
  const allowed = new Set(
    RUNTIME_CONFIG_CATALOG.filter((c) => !c.envOnly).map((c) => c.key),
  );
  const prev = await loadPlatformRuntimeMap();
  const next = applyPatchToMap(prev, patch, allowed);
  await savePlatformRuntimeMap(next);
  // Apply platform layer into this process for keys not boot-pinned
  for (const meta of RUNTIME_CONFIG_CATALOG) {
    if (envIsSet(meta.key)) continue;
    if (next[meta.key] !== undefined) {
      process.env[meta.key] = next[meta.key]!;
    } else if (process.env[meta.key] !== undefined && !envIsSet(meta.key)) {
      // Clear previously painted value when platform unsets
      delete process.env[meta.key];
    }
  }
  const view = await getPlatformRuntimeConfigView();
  return { entries: view.entries };
}

/**
 * Org-facing view: only org-overridable keys (suggested code fixes today).
 * Shows whether the org can change them (platform/env may lock).
 */
export async function getOrgRuntimeConfigView(orgId: string): Promise<{
  orgId: string;
  entries: RuntimeConfigEntryView[];
  note: string;
}> {
  const platformRuntime = await loadPlatformRuntimeMap();
  const orgRuntime = await loadOrgRuntimeMap(orgId);
  const entries = RUNTIME_CONFIG_CATALOG.filter((m) =>
    ORG_OVERRIDABLE_RUNTIME_KEYS.has(m.key),
  ).map((meta) => {
    const r = resolveRuntimeValue(meta.key, platformRuntime, orgRuntime);
    return entryFromMeta(meta, r, "org");
  });
  return {
    orgId,
    entries,
    note:
      "Only tenant-overridable review preferences appear here (Suggested code fixes, Publish SARIF). " +
      "If Platform (or process env) sets a policy to Off or On, that value is forced for every organization and the matching control is locked. " +
      "When Platform leaves a key Unset, you may turn it On or Off for this org only.",
  };
}

/** @deprecated name — use getOrgRuntimeConfigView / getPlatformRuntimeConfigView */
export async function getRuntimeConfigView(orgId: string): Promise<{
  orgId: string;
  entries: RuntimeConfigEntryView[];
  note: string;
}> {
  // Preserve old call sites: if they expected full catalog, return platform+org merged
  // for the org's effective values (read-only style full list). Prefer explicit APIs.
  const platformRuntime = await loadPlatformRuntimeMap();
  const orgRuntime = await loadOrgRuntimeMap(orgId);
  const entries = RUNTIME_CONFIG_CATALOG.map((meta) => {
    const r = resolveRuntimeValue(meta.key, platformRuntime, orgRuntime);
    return entryFromMeta(meta, r, "org");
  });
  return {
    orgId,
    entries,
    note:
      "Effective runtime for this org (platform + org + env). Prefer platform API for install knobs.",
  };
}

/**
 * Org may only patch ORG_OVERRIDABLE keys, and only when platform/env do not pin them.
 */
export async function putOrgRuntimeConfig(
  orgId: string,
  patch: Record<string, string | null | undefined>,
): Promise<{ orgId: string; entries: RuntimeConfigEntryView[] }> {
  const platformRuntime = await loadPlatformRuntimeMap();
  const allowed = new Set<string>();
  for (const key of ORG_OVERRIDABLE_RUNTIME_KEYS) {
    if (envIsSet(key)) continue;
    if (platformRuntime[key] !== undefined && platformRuntime[key] !== "") continue;
    allowed.add(key);
  }
  // Reject pinned keys explicitly
  for (const k of Object.keys(patch)) {
    if (!ORG_OVERRIDABLE_RUNTIME_KEYS.has(k)) {
      throw Object.assign(
        new Error(
          `Runtime key ${k} is install-wide — configure it under Platform settings, not Organization.`,
        ),
        { status: 403, code: "PLATFORM_RUNTIME_ONLY" },
      );
    }
    if (!allowed.has(k) && patch[k] !== null && patch[k] !== undefined && patch[k] !== "") {
      throw Object.assign(
        new Error(
          `Cannot change ${k}: locked by platform install policy or process environment.`,
        ),
        { status: 403, code: "RUNTIME_LOCKED" },
      );
    }
  }

  const prev = await loadOrgRuntimeMap(orgId);
  // Only keep org-overridable keys in org store (strip legacy platform keys accidentally stored)
  const prevOrgOnly: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev)) {
    if (ORG_OVERRIDABLE_RUNTIME_KEYS.has(k)) prevOrgOnly[k] = v;
  }
  const next = applyPatchToMap(prevOrgOnly, patch, ORG_OVERRIDABLE_RUNTIME_KEYS);
  await getOrgSettingsStore().putRuntimeSettings(orgId, next);
  await applyOrgRuntimeToProcess(orgId);
  const view = await getOrgRuntimeConfigView(orgId);
  return { orgId, entries: view.entries };
}

/** @deprecated — org path now only accepts org-overridable keys */
export async function putRuntimeConfig(
  orgId: string,
  patch: Record<string, string | null | undefined>,
): Promise<{ orgId: string; entries: RuntimeConfigEntryView[] }> {
  return putOrgRuntimeConfig(orgId, patch);
}

/**
 * Paint process.env for a review job: platform install knobs + this org's overrides.
 */
export async function applyOrgRuntimeToProcess(orgId: string): Promise<void> {
  const platformRuntime = await loadPlatformRuntimeMap();
  const orgRuntime = await loadOrgRuntimeMap(orgId);
  for (const meta of RUNTIME_CONFIG_CATALOG) {
    if (envIsSet(meta.key)) continue;
    const r = resolveRuntimeValue(meta.key, platformRuntime, orgRuntime);
    if (r.source === "platform" || r.source === "org") {
      process.env[meta.key] = r.value;
    } else if (!envIsSet(meta.key) && process.env[meta.key] !== undefined) {
      // Avoid sticky values from a previous job's org override
      if (ORG_OVERRIDABLE_RUNTIME_KEYS.has(meta.key)) {
        delete process.env[meta.key];
      }
    }
  }
}

/** Sync helper — prefers boot env, then process (after apply), then default. */
export function runtimeEnv(key: string, fallback?: string): string {
  if (envIsSet(key)) return process.env[key] ?? "";
  if (process.env[key] !== undefined) return process.env[key] ?? "";
  const meta = byKey.get(key);
  return fallback ?? meta?.default ?? "";
}
