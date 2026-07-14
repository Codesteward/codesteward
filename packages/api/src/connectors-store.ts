/**
 * Connectors store facade: Postgres when DATABASE_URL is set, else connectors.json.
 *
 * SECURITY: secrets AES-GCM at rest; GET masks to last4.
 * Review path uses createOrgScmProvider (in-memory opts) — does NOT require process.env.
 * Env paint is opt-in only: STEW_APPLY_SCM_ENV=1 (local org on boot; never listAll).
 */
import {
  isDatabaseEnabled,
  tryCreateStewardDb,
  type ConnectorsRepository,
} from "@codesteward/db";
import {
  applyConnectorToEnv,
  FileConnectorsStore,
  getFileConnectorsStore,
  maskConnectorConfig,
  type OrgConnector,
} from "./connectors-file.js";

export type { OrgConnector };
export { maskConnectorConfig, applyConnectorToEnv };

export interface PublicConnector {
  type: string;
  status: string;
  enabled: boolean;
  configured: boolean;
  config?: Record<string, unknown>;
  url?: string;
  note?: string;
  updatedAt?: string;
  /** legacy fields for UI */
  hasToken?: boolean;
  tokenMasked?: string;
  baseUrl?: string;
  username?: string;
  org?: string;
  project?: string;
}

type Backend = ConnectorsRepository | FileConnectorsStore;

const KNOWN_TYPES = [
  "graph_mcp",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
  "gitea",
  "jira",
  "mcp",
  "linear",
  "confluence",
];

export class ConnectorsStore {
  private backend: Backend | undefined;
  private file: FileConnectorsStore;
  private envApplied = false;

  constructor(filePath?: string) {
    this.file = filePath
      ? new FileConnectorsStore(filePath)
      : getFileConnectorsStore();
  }

  private getBackend(): Backend {
    if (this.backend) return this.backend;
    if (isDatabaseEnabled()) {
      try {
        const db = tryCreateStewardDb();
        if (db) {
          this.backend = db.connectors;
          return this.backend;
        }
      } catch (err) {
        console.warn("[connectors] DATABASE_URL set but pool failed; using file", err);
      }
    }
    this.backend = this.file;
    return this.backend;
  }

  async ensureLoaded(): Promise<void> {
    const b = this.getBackend();
    if (b instanceof FileConnectorsStore) await b.load();
    // Multi-org safety: never paint connector secrets into process.env on boot
    // unless explicitly opted in. Review path uses createOrgScmProvider (in-memory opts).
    if (!this.envApplied) {
      this.envApplied = true;
      if (process.env.STEW_APPLY_SCM_ENV !== "1") {
        return;
      }
      try {
        // Only apply "local" org even when flag set — never listAll cross-org.
        const rows =
          b instanceof FileConnectorsStore
            ? await b.list("local")
            : await b.list("local");
        for (const c of rows) {
          if (c.enabled) applyConnectorToEnv(c.type, c.config);
        }
        console.warn(
          "[connectors] STEW_APPLY_SCM_ENV=1: applied local org connectors into process.env (single-org dogfood only)",
        );
      } catch (err) {
        console.warn("[connectors] apply env failed", err);
      }
    }
  }

  /** Alias for server startup. */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  get(type: string, orgId = "local"): OrgConnector | undefined {
    // sync access only for file after load
    if (this.file) {
      // best-effort; prefer async getAsync
    }
    return undefined;
  }

  async getAsync(type: string, orgId = "local"): Promise<OrgConnector | undefined> {
    await this.ensureLoaded();
    return this.getBackend().get(orgId, type);
  }

  async upsert(
    type: string,
    body: {
      enabled?: boolean;
      config?: Record<string, unknown>;
      // legacy flat fields
      token?: string;
      baseUrl?: string;
      username?: string;
      org?: string;
      project?: string;
      webhookSecret?: string;
      password?: string;
      note?: string;
      extra?: Record<string, string>;
    },
    orgId = "local",
  ): Promise<OrgConnector> {
    await this.ensureLoaded();
    const config: Record<string, unknown> = { ...(body.config ?? {}) };
    // Merge legacy flat fields into config
    for (const k of [
      "token",
      "baseUrl",
      "username",
      "org",
      "project",
      "webhookSecret",
      "password",
      "note",
    ] as const) {
      if (body[k] !== undefined && config[k] === undefined) {
        config[k] = body[k];
      }
    }
    if (body.extra) Object.assign(config, body.extra);

    // Encrypt secrets for both file and Postgres backends (K6)
    const { encryptConfigSecrets, decryptConfigSecrets } = await import(
      "./connectors-file.js"
    );
    const toStore = encryptConfigSecrets(config);

    const saved = await this.getBackend().upsert({
      orgId,
      type,
      config: toStore,
      enabled: body.enabled,
    });
    if (saved.enabled) {
      const plain = decryptConfigSecrets(saved.config);
      // Multi-org safe default: do NOT force-apply into process.env.
      // Opt-in via STEW_APPLY_SCM_ENV=1 for single-process single-org dogfood only.
      const allowEnvApply =
        process.env.STEW_APPLY_SCM_ENV === "1" ||
        (process.env.STEW_AUTH_STRICT !== "1" &&
          process.env.NODE_ENV !== "production" &&
          orgId === "local");
      if (allowEnvApply) {
        applyConnectorToEnv(type, plain, { force: process.env.STEW_APPLY_SCM_ENV === "1" });
      }
    }
    return saved;
  }

  async delete(type: string, orgId = "local"): Promise<boolean> {
    await this.ensureLoaded();
    return this.getBackend().delete(orgId, type);
  }

  async listPublic(orgId = "local"): Promise<PublicConnector[]> {
    await this.ensureLoaded();
    const stored = await this.getBackend().list(orgId);
    const byType = new Map(stored.map((c) => [c.type, c]));
    const types = [...KNOWN_TYPES];
    for (const c of stored) {
      if (!types.includes(c.type)) types.push(c.type);
    }

    // GitHub App lives in tenancy store — surface as configured without requiring a PAT
    let githubAuth: {
      configured: boolean;
      mode: string;
      detail?: string;
    } = { configured: false, mode: "none" };
    try {
      const { orgHasGithubAuth } = await import("./org-scm.js");
      githubAuth = await orgHasGithubAuth(orgId);
    } catch {
      /* ignore */
    }

    return types.map((type) => {
      const row = byType.get(type);
      const envConfigured = isEnvConfigured(type);
      const plainCfg = row?.config
        ? (() => {
            try {
              return row.config;
            } catch {
              return row.config;
            }
          })()
        : undefined;
      const token =
        (plainCfg?.token as string | undefined) || envToken(type);
      const hasSp =
        type === "azure-devops" &&
        Boolean(
          (plainCfg?.clientId && plainCfg?.clientSecret) ||
            (process.env.AZURE_DEVOPS_CLIENT_ID && process.env.AZURE_DEVOPS_CLIENT_SECRET),
        );
      const hasGithubApp =
        type === "github" &&
        (githubAuth.configured ||
          Boolean(plainCfg?.appId && (plainCfg?.privateKeyPem || plainCfg?.privateKeySet)));
      const baseUrl =
        (plainCfg?.baseUrl as string | undefined) ||
        (plainCfg?.url as string | undefined) ||
        envUrl(type);
      const configured =
        (row?.enabled !== false &&
          Boolean(
            token ||
              hasSp ||
              hasGithubApp ||
              (type === "graph_mcp" && baseUrl) ||
              (type === "jira" && baseUrl) ||
              (type === "confluence" && baseUrl),
          )) ||
        envConfigured ||
        type === "mcp" ||
        (type === "github" && githubAuth.configured);

      let status: string;
      if (type === "graph_mcp") {
        status =
          process.env.GRAPH_MOCK === "1"
            ? "mock"
            : configured
              ? "configured"
              : "not_configured";
      } else if (type === "mcp") {
        status = "available";
      } else if (row && row.enabled === false) {
        status = "disabled";
      } else if (type === "github" && githubAuth.mode === "app_pending_install") {
        status = "app_pending_install";
      } else if (configured) {
        status = "configured";
      } else {
        status =
          type === "github" || type === "gitlab" ? "missing_token" : "not_configured";
      }

      const masked = row ? maskConnectorConfig(row.config) : undefined;
      const tokenStr = typeof token === "string" ? token : undefined;
      const authNote =
        type === "github"
          ? githubAuth.mode === "github_app"
            ? "GitHub App (installation tokens)"
            : githubAuth.mode === "app_pending_install"
              ? githubAuth.detail ?? "GitHub App saved — install on an org next"
              : githubAuth.mode === "pat"
                ? "PAT (dev)"
                : undefined
          : undefined;

      return {
        type,
        status,
        enabled: row?.enabled ?? true,
        configured,
        config: masked,
        url: baseUrl,
        baseUrl,
        username: (row?.config.username as string | undefined),
        org: (row?.config.org as string | undefined),
        project: (row?.config.project as string | undefined),
        hasToken: Boolean(tokenStr) || hasSp || hasGithubApp,
        tokenMasked: tokenStr
          ? tokenStr.length <= 4
            ? "****"
            : `****${tokenStr.slice(-4)}`
          : hasGithubApp
            ? "****App"
            : hasSp
              ? "****SP"
              : undefined,
        note:
          (row?.config.note as string | undefined) ??
          authNote ??
          (type === "mcp"
            ? "Review MCP via @codesteward/mcp-server"
            : type === "graph_mcp" && process.env.GRAPH_MOCK === "1"
              ? "GRAPH_MOCK=1"
              : undefined),
        updatedAt: row?.updatedAt,
      };
    });
  }
}

function envToken(type: string): string | undefined {
  switch (type) {
    case "github":
      return process.env.GITHUB_TOKEN;
    case "gitlab":
      return process.env.GITLAB_TOKEN;
    case "bitbucket":
      return process.env.BITBUCKET_TOKEN;
    case "azure-devops":
      return process.env.AZURE_DEVOPS_TOKEN || process.env.AZDO_PAT;
    case "gitea":
      return process.env.GITEA_TOKEN || process.env.FORGEJO_TOKEN;
    case "jira":
      return process.env.JIRA_TOKEN || process.env.JIRA_API_TOKEN;
    case "linear":
      return process.env.LINEAR_API_KEY;
    case "confluence":
      return process.env.CONFLUENCE_TOKEN;
    default:
      return undefined;
  }
}

function envUrl(type: string): string | undefined {
  switch (type) {
    case "github":
      return process.env.GITHUB_API_URL;
    case "gitlab":
      return process.env.GITLAB_API_URL || process.env.GITLAB_URL;
    case "bitbucket":
      return process.env.BITBUCKET_API_URL;
    case "azure-devops":
      return process.env.AZURE_DEVOPS_API_URL;
    case "gitea":
      return process.env.GITEA_API_URL;
    case "jira":
      return process.env.JIRA_URL;
    case "graph_mcp":
      return process.env.GRAPH_MCP_URL ?? "http://localhost:3000/mcp";
    default:
      return undefined;
  }
}

function isEnvConfigured(type: string): boolean {
  if (type === "mcp") return true;
  if (type === "graph_mcp")
    return Boolean(process.env.GRAPH_MCP_URL) || process.env.GRAPH_MOCK === "1";
  if (type === "jira") return Boolean(process.env.JIRA_URL);
  return Boolean(envToken(type));
}

export const globalConnectorsStore = new ConnectorsStore();
