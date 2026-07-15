/**
 * Per-org SCM client factory — credentials from org connector store + GitHub App tenancy.
 * Does not require process.env pollution for the review / list-repos path.
 */
import { createScmProvider, type CreateScmOptions, type ScmProvider } from "@codesteward/scm";
import { globalConnectorsStore } from "./connectors-store.js";
import { decryptConfigSecrets } from "./connectors-file.js";

const SCM_TYPES = new Set([
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
  "ado",
  "gitea",
  "forgejo",
]);

function normalizeProvider(name: string): string {
  const p = name.toLowerCase();
  if (p === "ado" || p === "azuredevops" || p === "azdo") return "azure-devops";
  if (p === "forgejo") return "gitea";
  return p;
}

function envFallbackOpts(provider: string): CreateScmOptions {
  switch (provider) {
    case "github": {
      const pem = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
      const canApp =
        Boolean(process.env.GITHUB_APP_ID) &&
        Boolean(process.env.GITHUB_APP_INSTALLATION_ID) &&
        Boolean(pem || process.env.GITHUB_APP_PRIVATE_KEY_REF);
      return {
        token: process.env.GITHUB_TOKEN,
        baseUrl: process.env.GITHUB_API_URL,
        githubApp: canApp
          ? {
              appId: process.env.GITHUB_APP_ID!,
              privateKeyPem: pem || " ", // factory falls through to KEY_REF when blank-ish via env
              installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
              baseUrl: process.env.GITHUB_API_URL,
            }
          : undefined,
      };
    }
    case "gitlab":
      return {
        token: process.env.GITLAB_TOKEN,
        baseUrl: process.env.GITLAB_API_URL ?? process.env.GITLAB_URL,
      };
    case "bitbucket":
      return {
        token: process.env.BITBUCKET_TOKEN,
        username: process.env.BITBUCKET_USERNAME,
        baseUrl: process.env.BITBUCKET_API_URL,
      };
    case "azure-devops":
      return {
        token: process.env.AZURE_DEVOPS_TOKEN ?? process.env.AZDO_PAT,
        org: process.env.AZURE_DEVOPS_ORG,
        project: process.env.AZURE_DEVOPS_PROJECT,
        baseUrl: process.env.AZURE_DEVOPS_API_URL,
        tenantId: process.env.AZURE_DEVOPS_TENANT_ID,
        clientId: process.env.AZURE_DEVOPS_CLIENT_ID,
        clientSecret: process.env.AZURE_DEVOPS_CLIENT_SECRET,
      };
    case "gitea":
      return {
        token: process.env.GITEA_TOKEN ?? process.env.FORGEJO_TOKEN,
        baseUrl: process.env.GITEA_API_URL ?? process.env.FORGEJO_API_URL,
      };
    default:
      return {};
  }
}

/**
 * Build CreateScmOptions from decrypted org connector config.
 */
export function connectorConfigToScmOpts(
  provider: string,
  config: Record<string, unknown>,
): CreateScmOptions {
  const plain = decryptConfigSecrets(config);
  const opts: CreateScmOptions = {
    provider,
    token: typeof plain.token === "string" && plain.token ? plain.token : undefined,
    baseUrl:
      typeof plain.baseUrl === "string"
        ? plain.baseUrl
        : typeof plain.apiUrl === "string"
          ? plain.apiUrl
          : typeof plain.url === "string"
            ? plain.url
            : undefined,
    username: typeof plain.username === "string" ? plain.username : undefined,
    org:
      typeof plain.org === "string"
        ? plain.org
        : typeof plain.organization === "string"
          ? plain.organization
          : undefined,
    project: typeof plain.project === "string" ? plain.project : undefined,
    tenantId:
      typeof plain.tenantId === "string"
        ? plain.tenantId
        : typeof plain.aadTenantId === "string"
          ? plain.aadTenantId
          : undefined,
    clientId: typeof plain.clientId === "string" ? plain.clientId : undefined,
    clientSecret:
      typeof plain.clientSecret === "string" ? plain.clientSecret : undefined,
  };

  // GitHub App fields on connector row (when mirrored from tenancy save)
  if (
    provider === "github" &&
    plain.appId &&
    (plain.privateKeyPem || plain.privateKey) &&
    plain.installationId
  ) {
    opts.githubApp = {
      appId: String(plain.appId),
      privateKeyPem: String(plain.privateKeyPem ?? plain.privateKey),
      installationId: String(plain.installationId),
      baseUrl: opts.baseUrl,
    };
  }
  return opts;
}

/**
 * Resolve GitHub App credentials for an org.
 * Prefer platform-enforced App (shared PEM) + org installation; else per-org tenancy.
 */
async function githubAppOptsFromTenancy(
  orgId: string,
): Promise<CreateScmOptions | null> {
  try {
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const store = getTenancyStore();
    const installs = await store.listInstallations(orgId);
    // Prefer real numeric installation IDs; skip pending/state placeholders
    const gh =
      installs.find(
        (i) =>
          i.provider === "github" &&
          i.status !== "suspended" &&
          i.status !== "deleted" &&
          /^\d+$/.test(String(i.installationId ?? "")),
      ) ??
      installs.find(
        (i) =>
          i.provider === "github" &&
          i.status !== "suspended" &&
          i.status !== "deleted" &&
          i.installationId &&
          !String(i.installationId).startsWith("pending:"),
      );
    const installationId =
      gh?.installationId ?? process.env.GITHUB_APP_INSTALLATION_ID;

    // Platform-enforced / shared App credentials
    const { resolvePlatformGithubAppPolicy } = await import(
      "./platform-github-app-store.js"
    );
    const platform = await resolvePlatformGithubAppPolicy();
    if (platform.configured && platform.appId && platform.privateKey) {
      if (!installationId) {
        return {
          provider: "github",
          baseUrl: platform.baseUrl,
        };
      }
      return {
        provider: "github",
        baseUrl: platform.baseUrl,
        githubApp: {
          appId: platform.appId,
          privateKeyPem: platform.privateKey,
          installationId,
          baseUrl: platform.baseUrl,
        },
      };
    }

    const cfg = await store.getGitHubAppConfig(orgId);
    const creds = store.resolveGitHubAppCredentials(cfg);
    if (!creds) return null;
    if (!installationId) {
      // App credentials without installation — cannot mint token yet
      return {
        provider: "github",
        baseUrl: creds.baseUrl ?? cfg?.baseUrl,
        // leave without githubApp so caller can surface "pending install"
      };
    }
    return {
      provider: "github",
      baseUrl: creds.baseUrl ?? cfg?.baseUrl,
      githubApp: {
        appId: creds.appId,
        privateKeyPem: creds.privateKey,
        installationId,
        baseUrl: creds.baseUrl ?? cfg?.baseUrl,
      },
    };
  } catch (err) {
    console.warn("[org-scm] tenancy GitHub App resolve failed", err);
    return null;
  }
}

function hasAuth(opts: CreateScmOptions): boolean {
  return Boolean(
    opts.token ||
      opts.githubApp?.appId ||
      (opts.clientId && opts.clientSecret),
  );
}

/**
 * Create an SCM provider using org-scoped connector + GitHub App credentials.
 */
export async function createOrgScmProvider(
  orgId: string,
  providerName?: string,
): Promise<ScmProvider> {
  const provider = normalizeProvider(
    providerName ?? process.env.SCM_PROVIDER ?? "github",
  );
  if (!SCM_TYPES.has(provider) && provider !== "github_enterprise") {
    return createScmProvider(provider);
  }

  await globalConnectorsStore.ensureLoaded();
  const connectorType = provider === "github_enterprise" ? "github" : provider;
  const row = await globalConnectorsStore.getAsync(connectorType, orgId);

  const strict =
    process.env.STEW_AUTH_STRICT === "1" ||
    process.env.NODE_ENV === "production" ||
    process.env.STEW_MULTI_ORG === "1";

  let opts: CreateScmOptions = { provider };

  // Platform enforce: strip org PAT unless explicitly allowed
  let platformPolicy: Awaited<
    ReturnType<
      typeof import("./platform-github-app-store.js").resolvePlatformGithubAppPolicy
    >
  > | null = null;
  if (provider === "github" || provider === "github_enterprise") {
    try {
      const { resolvePlatformGithubAppPolicy } = await import(
        "./platform-github-app-store.js"
      );
      platformPolicy = await resolvePlatformGithubAppPolicy();
    } catch {
      platformPolicy = null;
    }
  }

  if (row?.enabled !== false && row?.config && Object.keys(row.config).length > 0) {
    const fromConnector = connectorConfigToScmOpts(provider, row.config);
    if (
      platformPolicy?.enforce &&
      !platformPolicy.allowOrgPat &&
      fromConnector.token &&
      !fromConnector.githubApp
    ) {
      // Drop PAT under enforced platform App
      opts = { ...opts, ...fromConnector, token: undefined };
    } else {
      opts = { ...opts, ...fromConnector };
    }
  }

  // GitHub App (platform-enforced or org tenancy) — prefer over connector PAT when complete
  if (provider === "github" || provider === "github_enterprise") {
    const appOpts = await githubAppOptsFromTenancy(orgId);
    if (appOpts?.githubApp) {
      opts = {
        ...opts,
        githubApp: appOpts.githubApp,
        baseUrl: appOpts.baseUrl ?? opts.baseUrl,
        // Prefer installation token; keep PAT only as fallback if no app
        token: undefined,
      };
    } else if (appOpts && !opts.token && !opts.githubApp) {
      // Credentials partial — still try env installation if present
      const envApp = envFallbackOpts("github");
      if (envApp.githubApp) {
        opts = { ...opts, ...envApp, token: undefined };
      }
    }
  }

  if (hasAuth(opts)) {
    return createScmProvider(provider, { ...opts, provider });
  }

  // Dogfood: fill from env when not strict
  if (!strict || process.env.STEW_ALLOW_ENV_SCM === "1") {
    const envOpts = envFallbackOpts(provider);
    const merged: CreateScmOptions = {
      ...envOpts,
      ...Object.fromEntries(
        Object.entries(opts).filter(([, v]) => v !== undefined && v !== ""),
      ),
      provider,
    };
    if (hasAuth(merged)) {
      return createScmProvider(provider, merged);
    }
  }

  if (strict && process.env.STEW_ALLOW_ENV_SCM !== "1") {
    throw new Error(
      `No SCM connector configured for org=${orgId} provider=${provider}. ` +
        (provider === "github"
          ? "Save a GitHub App (Connectors → Advanced) with installation ID, or a PAT, or set STEW_ALLOW_ENV_SCM=1."
          : "Configure via Connectors UI or set STEW_ALLOW_ENV_SCM=1 for single-tenant env tokens."),
    );
  }
  return createScmProvider(provider, envFallbackOpts(provider));
}

/** Whether the org has usable GitHub auth (App+install or PAT). */
export async function orgHasGithubAuth(orgId: string): Promise<{
  configured: boolean;
  mode: "github_app" | "pat" | "app_pending_install" | "none";
  detail?: string;
  platformEnforced?: boolean;
}> {
  await globalConnectorsStore.ensureLoaded();
  let platformEnforced = false;
  try {
    const { resolvePlatformGithubAppPolicy } = await import(
      "./platform-github-app-store.js"
    );
    const platform = await resolvePlatformGithubAppPolicy();
    platformEnforced = platform.enforce && platform.configured;
    if (platform.configured && platform.appId && platform.privateKey) {
      const { getTenancyStore } = await import("./tenancy/orgs.js");
      const installs = await getTenancyStore().listInstallations(orgId);
      const active = installs.find(
        (i) =>
          i.provider === "github" &&
          i.status !== "suspended" &&
          /^\d+$/.test(String(i.installationId ?? "")),
      );
      if (active?.installationId || process.env.GITHUB_APP_INSTALLATION_ID) {
        return {
          configured: true,
          mode: "github_app",
          platformEnforced,
          detail: platform.enforce
            ? "Platform GitHub App + org installation"
            : undefined,
        };
      }
      return {
        configured: true,
        mode: "app_pending_install",
        platformEnforced,
        detail: platform.enforce
          ? "Platform GitHub App is configured — install it on your GitHub org/account"
          : "GitHub App credentials saved — install the app on an org/account",
      };
    }
  } catch {
    /* ignore */
  }

  const row = await globalConnectorsStore.getAsync("github", orgId);
  const plain = row?.config ? decryptConfigSecrets(row.config) : {};
  if (typeof plain.token === "string" && plain.token) {
    if (platformEnforced) {
      // PAT present but platform App enforced without allowOrgPat — treat as none for product path
      try {
        const { resolvePlatformGithubAppPolicy } = await import(
          "./platform-github-app-store.js"
        );
        const p = await resolvePlatformGithubAppPolicy();
        if (p.enforce && !p.allowOrgPat) {
          return {
            configured: false,
            mode: "none",
            platformEnforced: true,
            detail: "PAT ignored — platform GitHub App is enforced",
          };
        }
      } catch {
        /* fall through */
      }
    }
    return { configured: true, mode: "pat", platformEnforced };
  }
  try {
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const store = getTenancyStore();
    const cfg = await store.getGitHubAppConfig(orgId);
    const creds = store.resolveGitHubAppCredentials(cfg);
    if (creds) {
      const installs = await store.listInstallations(orgId);
      const active = installs.find(
        (i) =>
          i.provider === "github" &&
          i.status !== "suspended" &&
          /^\d+$/.test(String(i.installationId ?? "")),
      );
      if (active?.installationId || process.env.GITHUB_APP_INSTALLATION_ID) {
        return { configured: true, mode: "github_app", platformEnforced };
      }
      return {
        configured: true,
        mode: "app_pending_install",
        platformEnforced,
        detail: "GitHub App credentials saved — install the app on an org/account",
      };
    }
  } catch {
    /* ignore */
  }
  if (process.env.GITHUB_TOKEN) {
    return { configured: true, mode: "pat", platformEnforced };
  }
  if (
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID &&
    (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_REF)
  ) {
    return { configured: true, mode: "github_app", platformEnforced };
  }
  return { configured: false, mode: "none", platformEnforced };
}
