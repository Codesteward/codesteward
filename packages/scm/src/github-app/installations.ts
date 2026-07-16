/**
 * List GitHub App installations (JWT-authenticated as the App).
 * Used to populate org/account selectors after App credentials are known.
 */
import { createGitHubAppJwt } from "./jwt.js";
import type { GitHubAppCredentials } from "./tokens.js";

export interface GitHubAppInstallationSummary {
  installationId: string;
  accountLogin: string;
  accountType: "Organization" | "User" | string;
  accountId?: number;
  targetType?: string;
  repositorySelection?: string;
  htmlUrl?: string;
  suspended: boolean;
}

function isGithubDotComApiHost(baseUrl: string): boolean {
  try {
    const u = baseUrl.includes("://") ? new URL(baseUrl) : new URL(`https://${baseUrl}`);
    return u.hostname === "github.com" || u.hostname === "api.github.com";
  } catch {
    return false;
  }
}

function apiRoot(baseUrl?: string): string {
  if (!baseUrl || isGithubDotComApiHost(baseUrl)) return "https://api.github.com";
  return baseUrl.replace(/\/$/, "").endsWith("/api/v3")
    ? baseUrl.replace(/\/$/, "")
    : `${baseUrl.replace(/\/$/, "")}/api/v3`;
}

export async function listGitHubAppInstallations(input: {
  credentials: GitHubAppCredentials;
  fetchImpl?: typeof fetch;
}): Promise<GitHubAppInstallationSummary[]> {
  const jwt = createGitHubAppJwt({
    appId: input.credentials.appId,
    privateKeyPem: input.credentials.privateKeyPem,
  });
  const root = apiRoot(input.credentials.baseUrl);
  const fetchFn = input.fetchImpl ?? fetch;
  const out: GitHubAppInstallationSummary[] = [];
  let page = 1;
  while (page <= 20) {
    const res = await fetchFn(`${root}/app/installations?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codesteward-review",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub list installations failed (${res.status}): ${text.slice(0, 400)}`,
      );
    }
    const batch = (await res.json()) as Array<{
      id: number;
      account?: { login?: string; type?: string; id?: number; html_url?: string };
      target_type?: string;
      repository_selection?: string;
      html_url?: string;
      suspended_at?: string | null;
    }>;
    for (const row of batch) {
      out.push({
        installationId: String(row.id),
        accountLogin: row.account?.login ?? `installation-${row.id}`,
        accountType: row.account?.type ?? row.target_type ?? "Organization",
        accountId: row.account?.id,
        targetType: row.target_type,
        repositorySelection: row.repository_selection,
        htmlUrl: row.html_url ?? row.account?.html_url,
        suspended: Boolean(row.suspended_at),
      });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return out.filter((i) => !i.suspended);
}
