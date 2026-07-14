import { readFileSync } from "node:fs";
import { createGitHubAppJwt } from "./jwt.js";

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  permissions?: Record<string, string>;
  repositorySelection?: string;
}

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
  baseUrl?: string; // default https://api.github.com
}

const memoryCache = new Map<string, InstallationToken>();

function apiRoot(baseUrl?: string): string {
  if (!baseUrl || baseUrl.includes("github.com")) return "https://api.github.com";
  // GHE: https://ghe.example.com/api/v3
  return baseUrl.replace(/\/$/, "").endsWith("/api/v3")
    ? baseUrl.replace(/\/$/, "")
    : `${baseUrl.replace(/\/$/, "")}/api/v3`;
}

/**
 * Mint a short-lived installation access token for a GitHub App installation.
 * Caches in-memory until 2 minutes before expiry.
 */
export async function getInstallationAccessToken(input: {
  credentials: GitHubAppCredentials;
  installationId: string | number;
  fetchImpl?: typeof fetch;
}): Promise<InstallationToken> {
  const cacheKey = `${input.credentials.appId}:${input.installationId}:${input.credentials.baseUrl ?? "github"}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expiresAt.getTime() - Date.now() > 120_000) {
    return cached;
  }

  const jwt = createGitHubAppJwt({
    appId: input.credentials.appId,
    privateKeyPem: input.credentials.privateKeyPem,
  });
  const root = apiRoot(input.credentials.baseUrl);
  const fetchFn = input.fetchImpl ?? fetch;
  const res = await fetchFn(
    `${root}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codesteward-review",
      },
      body: "{}",
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub App installation token failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  const data = (await res.json()) as {
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
    repository_selection?: string;
  };
  const token: InstallationToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at),
    permissions: data.permissions,
    repositorySelection: data.repository_selection,
  };
  memoryCache.set(cacheKey, token);
  return token;
}

/** Resolve private key from env:NAME, file:/path, or raw PEM. */
export function resolveSecretRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("env:")) return process.env[ref.slice(4)];
  if (ref.startsWith("file:")) {
    try {
      return readFileSync(ref.slice(5), "utf8");
    } catch {
      return undefined;
    }
  }
  // raw PEM or literal
  return ref.includes("BEGIN") ? ref.replace(/\\n/g, "\n") : ref;
}

export function clearInstallationTokenCache(): void {
  memoryCache.clear();
}
