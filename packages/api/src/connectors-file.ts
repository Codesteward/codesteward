/**
 * File-backed org connector config when DATABASE_URL is unset.
 * Path: `.steward-data/connectors.json`
 *
 * Secrets are AES-GCM encrypted at rest via encryptSecret (enc:v1:…).
 * GET APIs mask secrets (last4 only). Prefer STEW_SECRETS_KEY in production.
 */
import { nowIso } from "@codesteward/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secrets.js";

export interface OrgConnector {
  orgId: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

function dataDir(): string {
  return process.env.STEW_DATA_DIR ?? ".steward-data";
}

const SECRET_KEY_RE =
  /^(token|password|secret|pat|api_?key|webhook_?secret|access_?token|private_?token|client_?secret|private_?key|private_?key_?pem)$/i;

export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || /secret|token|password|pat/i.test(key);
}

export function maskSecret(value: string): string {
  if (!value) return "";
  try {
    const plain = isEncryptedSecret(value) ? decryptSecret(value) ?? value : value;
    if (plain.length <= 4) return "****";
    return `****${plain.slice(-4)}`;
  } catch {
    return "****";
  }
}

export function encryptConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && isSecretConfigKey(k) && v && !isEncryptedSecret(v)) {
      out[k] = encryptSecret(v);
    }
  }
  return out;
}

/** Decrypt secret fields for runtime use (never return raw to clients). */
export function decryptConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && isSecretConfigKey(k) && isEncryptedSecret(v)) {
      try {
        out[k] = decryptSecret(v);
      } catch {
        /* leave encrypted if key missing */
      }
    }
  }
  return out;
}

/** Mask secret fields; expose last4 + *Set flags. */
export function maskConnectorConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v == null) {
      out[k] = v;
      continue;
    }
    if (isSecretConfigKey(k) && typeof v === "string") {
      out[k] = maskSecret(v);
      out[`${k}Last4`] = v.length >= 4 ? v.slice(-4) : v;
      out[`${k}Set`] = v.length > 0;
    } else if (typeof v === "object" && !Array.isArray(v)) {
      out[k] = maskConnectorConfig(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Apply connector tokens into process.env when not already set.
 */
export function applyConnectorToEnv(
  type: string,
  config: Record<string, unknown>,
  opts: { force?: boolean } = {},
): void {
  // Multi-org safety: never force-apply into process.env unless explicitly allowed
  if (opts.force && process.env.STEW_APPLY_SCM_ENV !== "1" && process.env.STEW_AUTH_STRICT === "1") {
    console.warn(
      "[connectors] skip process.env apply under STEW_AUTH_STRICT without STEW_APPLY_SCM_ENV=1",
    );
    return;
  }
  const plain = decryptConfigSecrets(config);
  const setIf = (envKey: string, value: unknown) => {
    if (value == null || value === "") return;
    if (!opts.force && process.env[envKey]) return;
    process.env[envKey] = String(value);
  };

  switch (type) {
    case "github":
      setIf("GITHUB_TOKEN", plain.token);
      setIf("GITHUB_API_URL", plain.baseUrl ?? plain.apiUrl);
      setIf("GITHUB_WEBHOOK_SECRET", plain.webhookSecret);
      break;
    case "gitlab":
      setIf("GITLAB_TOKEN", plain.token);
      setIf("GITLAB_API_URL", plain.baseUrl ?? plain.apiUrl);
      setIf("GITLAB_URL", plain.baseUrl ?? plain.apiUrl);
      setIf("GITLAB_WEBHOOK_SECRET", plain.webhookSecret);
      break;
    case "bitbucket":
      setIf("BITBUCKET_TOKEN", plain.token);
      setIf("BITBUCKET_USERNAME", plain.username);
      setIf("BITBUCKET_API_URL", plain.baseUrl ?? plain.apiUrl);
      break;
    case "azure-devops":
    case "azuredevops":
    case "azdo":
      setIf("AZURE_DEVOPS_TOKEN", plain.token);
      setIf("AZDO_PAT", plain.token);
      setIf("AZURE_DEVOPS_ORG", plain.org ?? plain.organization);
      setIf("AZURE_DEVOPS_PROJECT", plain.project);
      setIf("AZURE_DEVOPS_API_URL", plain.baseUrl ?? plain.apiUrl);
      break;
    case "gitea":
    case "forgejo":
      setIf("GITEA_TOKEN", plain.token);
      setIf("GITEA_API_URL", plain.baseUrl ?? plain.apiUrl);
      break;
    case "jira":
      setIf("JIRA_URL", plain.baseUrl ?? plain.url);
      setIf("JIRA_TOKEN", plain.token);
      setIf("JIRA_EMAIL", plain.email ?? plain.username);
      break;
    case "graph_mcp":
      setIf("GRAPH_MCP_URL", plain.url ?? plain.baseUrl);
      break;
    case "linear":
      setIf("LINEAR_API_KEY", plain.token);
      break;
    case "confluence":
      setIf("CONFLUENCE_URL", plain.baseUrl ?? plain.url);
      setIf("CONFLUENCE_TOKEN", plain.token);
      setIf("CONFLUENCE_EMAIL", plain.email ?? plain.username);
      setIf("CONFLUENCE_SPACE", plain.spaceKey);
      break;
    default:
      break;
  }
}

export class FileConnectorsStore {
  private rows: OrgConnector[] = [];
  private loaded = false;
  readonly path: string;

  constructor(filePath?: string) {
    this.path =
      filePath ??
      process.env.CONNECTORS_STORE_PATH ??
      `${dataDir()}/connectors.json`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        // Support both OrgConnector[] and legacy flat ConnectorConfig[]
        this.rows = parsed.map((item) => normalizeRow(item));
      } else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { connectors?: unknown }).connectors)
      ) {
        this.rows = (
          (parsed as { connectors: unknown[] }).connectors
        ).map(normalizeRow);
      } else {
        this.rows = [];
      }
    } catch {
      this.rows = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.rows, null, 2), "utf8");
  }

  async list(orgId: string): Promise<OrgConnector[]> {
    await this.load();
    return this.rows
      .filter((c) => c.orgId === orgId)
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  async get(orgId: string, type: string): Promise<OrgConnector | undefined> {
    await this.load();
    return this.rows.find((c) => c.orgId === orgId && c.type === type);
  }

  async listAll(): Promise<OrgConnector[]> {
    await this.load();
    return [...this.rows];
  }

  async upsert(input: {
    orgId: string;
    type: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<OrgConnector> {
    await this.load();
    const idx = this.rows.findIndex(
      (c) => c.orgId === input.orgId && c.type === input.type,
    );
    const existing = idx >= 0 ? this.rows[idx] : undefined;
    const mergedConfig = {
      ...(existing?.config ?? {}),
      ...(input.config ?? {}),
    };
    // Preserve secrets when empty string provided
    if (input.config) {
      for (const [k, v] of Object.entries(input.config)) {
        if ((v === "" || v === null) && existing?.config?.[k] != null) {
          mergedConfig[k] = existing.config[k];
        }
      }
    }
    const next: OrgConnector = {
      orgId: input.orgId,
      type: input.type,
      config: encryptConfigSecrets(mergedConfig),
      enabled: input.enabled ?? existing?.enabled ?? true,
      updatedAt: nowIso(),
    };
    if (idx >= 0) this.rows[idx] = next;
    else this.rows.push(next);
    await this.save();
    return next;
  }

  async delete(orgId: string, type: string): Promise<boolean> {
    await this.load();
    const before = this.rows.length;
    this.rows = this.rows.filter((c) => !(c.orgId === orgId && c.type === type));
    if (this.rows.length === before) return false;
    await this.save();
    return true;
  }
}

function normalizeRow(item: unknown): OrgConnector {
  const r = item as Record<string, unknown>;
  // Already OrgConnector shape
  if (r.config && typeof r.config === "object") {
    return {
      orgId: String(r.orgId ?? "local"),
      type: String(r.type),
      config: r.config as Record<string, unknown>,
      enabled: r.enabled !== false,
      updatedAt: String(r.updatedAt ?? nowIso()),
    };
  }
  // Legacy flat shape from earlier connectors-store
  const {
    type,
    enabled,
    updatedAt,
    note,
    ...rest
  } = r;
  const config: Record<string, unknown> = { ...rest };
  if (note) config.note = note;
  delete config.orgId;
  return {
    orgId: String(r.orgId ?? "local"),
    type: String(type),
    config,
    enabled: enabled !== false,
    updatedAt: String(updatedAt ?? nowIso()),
  };
}

let shared: FileConnectorsStore | undefined;
export function getFileConnectorsStore(): FileConnectorsStore {
  if (!shared) shared = new FileConnectorsStore();
  return shared;
}

export async function loadAndApplyAllConnectors(
  store: FileConnectorsStore,
): Promise<void> {
  const all = await store.listAll();
  for (const c of all) {
    if (c.enabled) applyConnectorToEnv(c.type, c.config);
  }
}
