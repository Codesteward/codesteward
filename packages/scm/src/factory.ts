import { GitHubScm } from "./github.js";
import { GitLabScm } from "./gitlab.js";
import { BitbucketScm } from "./bitbucket.js";
import { AzureDevOpsScm } from "./azure-devops.js";
import { GiteaScm } from "./gitea.js";
import {
  getInstallationAccessToken,
  resolveSecretRef,
  type GitHubAppCredentials,
} from "./github-app/index.js";
import type { ScmProvider } from "./types.js";

export interface CreateScmOptions {
  provider?: string;
  token?: string;
  baseUrl?: string;
  username?: string;
  org?: string;
  project?: string;
  /** Azure AD tenant for Service Principal auth */
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  githubApp?: {
    appId: string;
    privateKeyPem: string;
    installationId: string | number;
    baseUrl?: string;
  };
}

/**
 * Create an SCM provider.
 * Prefer explicit opts (per-org connector) over process.env — never requires env pollution.
 * GitHub enterprise: prefer GitHub App installation tokens over PAT.
 */
export function createScmProvider(
  name: string = process.env.SCM_PROVIDER ?? "github",
  opts: CreateScmOptions = {},
): ScmProvider {
  const provider = (opts.provider ?? name).toLowerCase();

  if (provider === "github" || provider === "github_enterprise") {
    const app = opts.githubApp;
    const creds = resolveGitHubAppCredentials(app);
    const installationId =
      app?.installationId ?? process.env.GITHUB_APP_INSTALLATION_ID;
    if (creds && installationId) {
      return new GitHubScm({
        authMode: "github_app",
        baseUrl: opts.baseUrl ?? app?.baseUrl ?? process.env.GITHUB_API_URL,
        tokenProvider: async () => {
          const tok = await getInstallationAccessToken({
            credentials: creds,
            installationId,
          });
          return tok.token;
        },
      });
    }
    return new GitHubScm({
      token: opts.token ?? process.env.GITHUB_TOKEN,
      baseUrl: opts.baseUrl ?? process.env.GITHUB_API_URL,
      authMode: "pat",
    });
  }

  if (provider === "gitlab") {
    return new GitLabScm({
      token: opts.token,
      baseUrl: opts.baseUrl,
    });
  }

  if (provider === "bitbucket") {
    return new BitbucketScm({
      token: opts.token,
      username: opts.username,
      baseUrl: opts.baseUrl,
    });
  }

  if (provider === "azure-devops" || provider === "ado" || provider === "azdo") {
    return new AzureDevOpsScm({
      token: opts.token,
      org: opts.org,
      project: opts.project,
      baseUrl: opts.baseUrl,
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
    });
  }

  if (provider === "gitea" || provider === "forgejo") {
    return new GiteaScm({
      token: opts.token,
      baseUrl: opts.baseUrl,
    });
  }

  return new GitHubScm({
    token: opts.token ?? process.env.GITHUB_TOKEN,
    baseUrl: opts.baseUrl ?? process.env.GITHUB_API_URL,
  });
}

function resolveGitHubAppCredentials(
  override?: CreateScmOptions["githubApp"],
): GitHubAppCredentials | null {
  const appId = override?.appId ?? process.env.GITHUB_APP_ID;
  const fromOverride = override?.privateKeyPem?.trim();
  const pem =
    (fromOverride && fromOverride.length > 10 ? fromOverride : undefined) ??
    resolveSecretRef(process.env.GITHUB_APP_PRIVATE_KEY_REF) ??
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !pem) return null;
  return {
    appId,
    privateKeyPem: pem,
    baseUrl: override?.baseUrl ?? process.env.GITHUB_API_URL,
  };
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_REF) &&
      process.env.GITHUB_APP_INSTALLATION_ID,
  );
}
