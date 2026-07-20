/**
 * Durable org settings (model matrix, per-org LLM provider secrets).
 * Postgres org_settings when DATABASE_URL set; else file JSON.
 * Provider API keys encrypted at rest via encryptSecret.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isDatabaseEnabled,
  tryCreateStewardDb,
} from "@codesteward/db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets.js";

export interface RoleModelOverride {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /**
   * @deprecated Not used for org product config. Keys live under `providers`.
   * Host-only `STEW_MODEL_ROLE_MATRIX` may still use env:VAR in model-router.
   * Stripped on org PUT.
   */
  apiKeyRef?: string;
}

export type ProviderId =
  | "openai"
  | "anthropic"
  | "xai"
  | "spacexai"
  | "litellm"
  | "openai-compatible"
  | "openrouter";

export interface OrgProviderConfig {
  /** Encrypted at rest (enc:v1:…) */
  apiKey?: string;
  baseUrl?: string;
}

export interface OrgModelMatrix {
  defaultProvider?: string;
  defaultModel?: string;
  strongModel?: string;
  cheapModel?: string;
  /** Per-stage / agent role overrides */
  roles: Record<string, RoleModelOverride>;
  /** Per-provider keys/base URLs for this org (multi-tenant BYOK) */
  providers?: Partial<Record<ProviderId, OrgProviderConfig>>;
}

/** Org-editable specialist prompt pack (personas / instructions). */
export type OrgPromptPackDoc = {
  version: 1;
  roles: Record<
    string,
    {
      role: string;
      system: Array<Record<string, unknown>>;
      user: Array<Record<string, unknown>>;
    }
  >;
  updatedAt?: string;
};

/** Per-tenant Langfuse project (secretKey encrypted at rest). */
export interface OrgLangfuseConfig {
  /** When false, disable tracing for this org even if platform keys exist. */
  enabled?: boolean;
  publicKey?: string;
  /** Encrypted at rest (enc:v1:…) */
  secretKey?: string;
  baseUrl?: string;
}

export interface OrgSettingsDoc {
  orgId: string;
  modelMatrix: OrgModelMatrix;
  /** Non-secret runtime knobs (STEW_*, GRAPH_* subset). Env always wins at resolve time. */
  runtime?: Record<string, string>;
  /** Editable prompt components per specialist role */
  promptPack?: OrgPromptPackDoc | null;
  /** Per-tenant Langfuse observability (optional; falls back to platform env). */
  langfuse?: OrgLangfuseConfig | null;
  /**
   * Optional retention for platform ClickHouse traces (days).
   * Orgs cannot disable ClickHouse ingestion — only TTL when platform sink is on.
   */
  traceTtlDays?: number | null;
  updatedAt: string;
}

const dataDir = () => process.env.STEW_DATA_DIR ?? ".steward-data";

function empty(orgId: string): OrgSettingsDoc {
  return {
    orgId,
    modelMatrix: { roles: {}, providers: {} },
    runtime: {},
    promptPack: null,
    langfuse: null,
    traceTtlDays: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Load org-level ClickHouse TTL override (days), or null for platform default. */
export async function loadOrgTraceTtlDays(orgId: string): Promise<number | null> {
  try {
    const doc = await getOrgSettingsStore().get(orgId);
    const n = doc.traceTtlDays;
    if (n == null || !Number.isFinite(n)) return null;
    return Math.max(1, Math.min(3650, Math.floor(Number(n))));
  } catch {
    return null;
  }
}

function encryptLangfuse(cfg: OrgLangfuseConfig | null | undefined): OrgLangfuseConfig | null {
  if (!cfg) return null;
  return {
    enabled: cfg.enabled,
    publicKey: cfg.publicKey,
    baseUrl: cfg.baseUrl,
    secretKey:
      cfg.secretKey && !isEncryptedSecret(cfg.secretKey)
        ? encryptSecret(cfg.secretKey)
        : cfg.secretKey,
  };
}

export function maskLangfuse(
  cfg: OrgLangfuseConfig | null | undefined,
): {
  enabled: boolean;
  publicKeySet: boolean;
  publicKeyHint?: string;
  secretKeySet: boolean;
  baseUrl?: string;
} {
  const publicKey = cfg?.publicKey?.trim();
  return {
    enabled: cfg?.enabled !== false,
    publicKeySet: Boolean(publicKey),
    publicKeyHint: publicKey
      ? publicKey.length > 8
        ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`
        : "••••"
      : undefined,
    secretKeySet: Boolean(cfg?.secretKey),
    baseUrl: cfg?.baseUrl,
  };
}

/**
 * Merge PUT body with existing Langfuse config.
 * Empty secretKey keeps previous; "__clear__" clears keys.
 */
export function mergeLangfuseSecrets(
  existing: OrgLangfuseConfig | null | undefined,
  incoming: (Partial<OrgLangfuseConfig> & { clear?: boolean }) | null | undefined,
): OrgLangfuseConfig | null {
  if (incoming === null || incoming?.clear === true) {
    return null;
  }
  if (!incoming) return existing ?? null;
  const prev = existing ?? {};
  const nextPublic =
    incoming.publicKey === undefined
      ? prev.publicKey
      : incoming.publicKey === ""
        ? undefined
        : incoming.publicKey.trim();
  const nextSecret =
    incoming.secretKey === undefined || incoming.secretKey === ""
      ? prev.secretKey
      : incoming.secretKey === "__clear__"
        ? undefined
        : incoming.secretKey;
  const nextBase =
    incoming.baseUrl === undefined
      ? prev.baseUrl
      : incoming.baseUrl === ""
        ? undefined
        : incoming.baseUrl.trim();
  const enabled =
    incoming.enabled !== undefined ? incoming.enabled : (prev.enabled ?? true);
  if (!nextPublic && !nextSecret && !nextBase) {
    // Nothing configured — only persist explicit opt-out
    return enabled === false ? { enabled: false } : null;
  }
  return encryptLangfuse({
    enabled,
    publicKey: nextPublic,
    secretKey: nextSecret,
    baseUrl: nextBase,
  });
}

function encryptProviders(
  providers: Partial<Record<ProviderId, OrgProviderConfig>> | undefined,
): Partial<Record<ProviderId, OrgProviderConfig>> | undefined {
  if (!providers) return undefined;
  const out: Partial<Record<ProviderId, OrgProviderConfig>> = {};
  for (const [id, cfg] of Object.entries(providers) as Array<
    [ProviderId, OrgProviderConfig]
  >) {
    if (!cfg) continue;
    out[id] = {
      baseUrl: cfg.baseUrl,
      apiKey:
        cfg.apiKey && !isEncryptedSecret(cfg.apiKey)
          ? encryptSecret(cfg.apiKey)
          : cfg.apiKey,
    };
  }
  return out;
}

/** Decrypt provider secrets for runtime merge (never send to clients). */
export function decryptProvidersForRuntime(
  providers: Partial<Record<ProviderId, OrgProviderConfig>> | undefined,
): Partial<Record<ProviderId, { apiKey?: string; baseUrl?: string }>> {
  if (!providers) return {};
  const out: Partial<Record<ProviderId, { apiKey?: string; baseUrl?: string }>> = {};
  for (const [id, cfg] of Object.entries(providers) as Array<
    [ProviderId, OrgProviderConfig]
  >) {
    if (!cfg) continue;
    let apiKey = cfg.apiKey;
    if (apiKey && isEncryptedSecret(apiKey)) {
      try {
        apiKey = decryptSecret(apiKey) ?? undefined;
      } catch {
        apiKey = undefined;
      }
    }
    out[id as ProviderId] = { apiKey, baseUrl: cfg.baseUrl };
  }
  return out;
}

/** Public view: no secret material */
export function maskProviders(
  providers: Partial<Record<ProviderId, OrgProviderConfig>> | undefined,
): Record<string, { apiKeySet: boolean; baseUrl?: string }> {
  const out: Record<string, { apiKeySet: boolean; baseUrl?: string }> = {};
  if (!providers) return out;
  for (const [id, cfg] of Object.entries(providers)) {
    out[id] = {
      apiKeySet: Boolean(cfg?.apiKey),
      baseUrl: cfg?.baseUrl,
    };
  }
  return out;
}

/**
 * Merge PUT body providers with existing: empty apiKey keeps previous.
 */
export function mergeProviderSecrets(
  existing: Partial<Record<ProviderId, OrgProviderConfig>> | undefined,
  incoming: Partial<Record<ProviderId, OrgProviderConfig>> | undefined,
): Partial<Record<ProviderId, OrgProviderConfig>> {
  const base = { ...(existing ?? {}) };
  if (!incoming) return encryptProviders(base) ?? {};
  for (const [id, cfg] of Object.entries(incoming) as Array<
    [ProviderId, OrgProviderConfig | undefined]
  >) {
    if (!cfg) continue;
    const prev = base[id] ?? {};
    const nextKey =
      cfg.apiKey === undefined || cfg.apiKey === ""
        ? prev.apiKey
        : cfg.apiKey === "__clear__"
          ? undefined
          : cfg.apiKey;
    const nextBase =
      cfg.baseUrl === undefined
        ? prev.baseUrl
        : cfg.baseUrl === ""
          ? undefined
          : cfg.baseUrl;
    if (!nextKey && !nextBase) {
      delete base[id];
    } else {
      base[id] = { apiKey: nextKey, baseUrl: nextBase };
    }
  }
  return encryptProviders(base) ?? {};
}

export class OrgSettingsStore {
  private file(orgId: string) {
    return join(dataDir(), `org-settings-${orgId}.json`);
  }

  async get(orgId: string): Promise<OrgSettingsDoc> {
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          const row = await db.configs.getOrCreate(orgId);
          const mp = row.modelProfiles as unknown as OrgModelMatrix | undefined;
          const settings = (row.settings ?? {}) as Record<string, unknown>;
          const runtimeRaw = settings.runtime;
          const runtime =
            runtimeRaw && typeof runtimeRaw === "object" && !Array.isArray(runtimeRaw)
              ? Object.fromEntries(
                  Object.entries(runtimeRaw as Record<string, unknown>).map(([k, v]) => [
                    k,
                    String(v ?? ""),
                  ]),
                )
              : {};
          const promptPackRaw = settings.promptPack;
          const promptPack =
            promptPackRaw && typeof promptPackRaw === "object"
              ? (promptPackRaw as OrgPromptPackDoc)
              : null;
          const langfuseRaw = settings.langfuse;
          const langfuse =
            langfuseRaw && typeof langfuseRaw === "object"
              ? (langfuseRaw as OrgLangfuseConfig)
              : null;
          const ttlRaw = settings.traceTtlDays;
          const traceTtlDays =
            typeof ttlRaw === "number" && Number.isFinite(ttlRaw)
              ? Math.max(1, Math.min(3650, Math.floor(ttlRaw)))
              : null;
          return {
            orgId,
            modelMatrix:
              mp && typeof mp === "object"
                ? {
                    ...mp,
                    roles: mp.roles ?? {},
                    providers: mp.providers ?? {},
                  }
                : { roles: {}, providers: {} },
            runtime,
            promptPack,
            langfuse,
            traceTtlDays,
            updatedAt: row.updatedAt,
          };
        }
      } catch (err) {
        console.warn("[org-settings] db get failed", err);
      }
    }
    try {
      const doc = JSON.parse(await readFile(this.file(orgId), "utf8")) as OrgSettingsDoc;
      doc.modelMatrix = {
        ...doc.modelMatrix,
        roles: doc.modelMatrix?.roles ?? {},
        providers: doc.modelMatrix?.providers ?? {},
      };
      doc.runtime = doc.runtime ?? {};
      doc.promptPack = doc.promptPack ?? null;
      doc.langfuse = doc.langfuse ?? null;
      doc.traceTtlDays = doc.traceTtlDays ?? null;
      return doc;
    } catch {
      return empty(orgId);
    }
  }

  private settingsBlob(doc: OrgSettingsDoc): Record<string, unknown> {
    return {
      runtime: doc.runtime ?? {},
      promptPack: doc.promptPack ?? null,
      langfuse: doc.langfuse ?? null,
      traceTtlDays: doc.traceTtlDays ?? null,
    };
  }

  async getRuntimeSettings(orgId: string): Promise<Record<string, string>> {
    const doc = await this.get(orgId);
    return { ...(doc.runtime ?? {}) };
  }

  async putRuntimeSettings(
    orgId: string,
    runtime: Record<string, string>,
  ): Promise<OrgSettingsDoc> {
    const prev = await this.get(orgId);
    const next: OrgSettingsDoc = {
      ...prev,
      orgId,
      runtime: { ...runtime },
      promptPack: prev.promptPack ?? null,
      langfuse: prev.langfuse ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          const row = await db.configs.getOrCreate(orgId);
          await db.configs.upsert({
            orgId,
            modelProfiles:
              (next.modelMatrix as unknown as Record<string, unknown>) ??
              row.modelProfiles,
            settings: {
              ...(row.settings ?? {}),
              ...this.settingsBlob(next),
            },
          });
          return next;
        }
      } catch (err) {
        console.warn("[org-settings] db putRuntime failed", err);
      }
    }
    await mkdir(dataDir(), { recursive: true });
    await writeFile(this.file(orgId), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  async putModelMatrix(orgId: string, matrix: OrgModelMatrix): Promise<OrgSettingsDoc> {
    const prev = await this.get(orgId);
    const providers = mergeProviderSecrets(
      prev.modelMatrix.providers,
      matrix.providers,
    );
    // Per-stage: provider/model/baseUrl only — never persist apiKeyRef on org product config
    const roles: Record<string, RoleModelOverride> = {};
    for (const [role, row] of Object.entries(matrix.roles ?? {})) {
      if (!row) continue;
      roles[role] = {
        provider: row.provider,
        model: row.model,
        baseUrl: row.baseUrl,
      };
    }
    const next: OrgSettingsDoc = {
      orgId,
      modelMatrix: {
        roles,
        defaultProvider: matrix.defaultProvider,
        defaultModel: matrix.defaultModel,
        strongModel: matrix.strongModel,
        cheapModel: matrix.cheapModel,
        providers,
      },
      runtime: prev.runtime ?? {},
      promptPack: prev.promptPack ?? null,
      langfuse: prev.langfuse ?? null,
      traceTtlDays: prev.traceTtlDays ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          const row = await db.configs.getOrCreate(orgId);
          await db.configs.upsert({
            orgId,
            modelProfiles: next.modelMatrix as unknown as Record<string, unknown>,
            settings: {
              ...(row.settings ?? {}),
              ...this.settingsBlob(next),
            },
          });
          return next;
        }
      } catch (err) {
        console.warn("[org-settings] db put failed", err);
      }
    }
    await mkdir(dataDir(), { recursive: true });
    await writeFile(this.file(orgId), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  async putPromptPack(
    orgId: string,
    promptPack: OrgPromptPackDoc | null,
  ): Promise<OrgSettingsDoc> {
    const prev = await this.get(orgId);
    const next: OrgSettingsDoc = {
      ...prev,
      orgId,
      promptPack,
      langfuse: prev.langfuse ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          const row = await db.configs.getOrCreate(orgId);
          await db.configs.upsert({
            orgId,
            modelProfiles:
              (next.modelMatrix as unknown as Record<string, unknown>) ??
              row.modelProfiles,
            settings: {
              ...(row.settings ?? {}),
              ...this.settingsBlob(next),
            },
          });
          return next;
        }
      } catch (err) {
        console.warn("[org-settings] db putPromptPack failed", err);
      }
    }
    await mkdir(dataDir(), { recursive: true });
    await writeFile(this.file(orgId), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  async putLangfuse(
    orgId: string,
    langfuse: (Partial<OrgLangfuseConfig> & { clear?: boolean }) | null,
  ): Promise<OrgSettingsDoc> {
    const prev = await this.get(orgId);
    const next: OrgSettingsDoc = {
      ...prev,
      orgId,
      langfuse: mergeLangfuseSecrets(prev.langfuse, langfuse),
      updatedAt: new Date().toISOString(),
    };
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          const row = await db.configs.getOrCreate(orgId);
          await db.configs.upsert({
            orgId,
            modelProfiles:
              (next.modelMatrix as unknown as Record<string, unknown>) ??
              row.modelProfiles,
            settings: {
              ...(row.settings ?? {}),
              ...this.settingsBlob(next),
            },
          });
          return next;
        }
      } catch (err) {
        console.warn("[org-settings] db putLangfuse failed", err);
      }
    }
    await mkdir(dataDir(), { recursive: true });
    await writeFile(this.file(orgId), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  /**
   * Org TTL override for platform ClickHouse rows (days).
   * Pass null to use platform default. Does not enable/disable ingestion.
   */
  async putTraceTtlDays(
    orgId: string,
    traceTtlDays: number | null,
  ): Promise<OrgSettingsDoc> {
    const prev = await this.get(orgId);
    const next: OrgSettingsDoc = {
      ...prev,
      orgId,
      traceTtlDays:
        traceTtlDays == null || !Number.isFinite(traceTtlDays)
          ? null
          : Math.max(1, Math.min(3650, Math.floor(traceTtlDays))),
      updatedAt: new Date().toISOString(),
    };
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          const row = await db.configs.getOrCreate(orgId);
          await db.configs.upsert({
            orgId,
            modelProfiles:
              (next.modelMatrix as unknown as Record<string, unknown>) ??
              row.modelProfiles,
            settings: {
              ...(row.settings ?? {}),
              ...this.settingsBlob(next),
            },
          });
          return next;
        }
      } catch (err) {
        console.warn("[org-settings] db putTraceTtlDays failed", err);
      }
    }
    await mkdir(dataDir(), { recursive: true });
    await writeFile(this.file(orgId), JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

let singleton: OrgSettingsStore | undefined;
export function getOrgSettingsStore(): OrgSettingsStore {
  if (!singleton) singleton = new OrgSettingsStore();
  return singleton;
}

/** Build matrix for mergeRoleOverrides with decrypted provider keys. */
export async function loadOrgMatrixForRuntime(orgId: string): Promise<OrgModelMatrix & {
  providers: ReturnType<typeof decryptProvidersForRuntime>;
}> {
  const doc = await getOrgSettingsStore().get(orgId);
  return {
    ...doc.modelMatrix,
    providers: decryptProvidersForRuntime(doc.modelMatrix.providers),
  };
}

/**
 * Org-only Langfuse credentials (no platform merge).
 * enabled:false → org destination off; platform may still dual-write separately.
 */
export async function loadOrgLangfuseForRuntime(orgId: string): Promise<{
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  enabled: boolean;
  orgId: string;
  source: "org";
} | null> {
  const doc = await getOrgSettingsStore().get(orgId);
  const lf = doc.langfuse;
  if (lf?.enabled === false) {
    return {
      publicKey: "",
      secretKey: "",
      enabled: false,
      orgId,
      source: "org",
    };
  }
  if (lf?.publicKey && lf?.secretKey) {
    let secretKey = lf.secretKey;
    if (isEncryptedSecret(secretKey)) {
      try {
        secretKey = decryptSecret(secretKey) ?? secretKey;
      } catch {
        console.warn("[org-settings] langfuse secret decrypt failed for org", orgId);
        secretKey = "";
      }
    }
    if (secretKey) {
      return {
        publicKey: lf.publicKey,
        secretKey,
        baseUrl: lf.baseUrl,
        enabled: true,
        orgId,
        source: "org",
      };
    }
  }
  return null;
}

/** @deprecated use loadOrgLangfuseForRuntime + loadLangfuseDestinationsForRuntime */
export async function loadLangfuseForRuntime(orgId: string) {
  return loadOrgLangfuseForRuntime(orgId);
}

/**
 * All Langfuse destinations for a review (org and/or platform).
 * Both can be set → dual-write to both projects.
 */
export async function loadLangfuseDestinationsForRuntime(orgId: string): Promise<
  Array<{
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    enabled: boolean;
    orgId?: string;
    source: "org" | "platform";
  }>
> {
  const { resolveLangfuseDestinations } = await import("@codesteward/model-router");
  const org = await loadOrgLangfuseForRuntime(orgId);
  let platform: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    enabled: boolean;
    source: "platform";
  } | null = null;
  try {
    const { loadPlatformLangfuseForRuntime } = await import("./platform-langfuse-store.js");
    platform = await loadPlatformLangfuseForRuntime();
  } catch (err) {
    console.warn("[org-settings] platform langfuse load failed", err);
  }
  return resolveLangfuseDestinations(
    org,
    platform,
    process.env,
  ) as Array<{
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    enabled: boolean;
    orgId?: string;
    source: "org" | "platform";
  }>;
}
