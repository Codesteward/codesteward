/**
 * GitHub App Manifest builder (create-from-manifest flow).
 * @see https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 *
 * Rules GitHub enforces (and that previously broke our form):
 * - hook_attributes.url must be publicly reachable (no localhost / private IPs)
 * - default_events must be repository webhook events that match default_permissions
 *   (installation / installation_repositories are NOT valid manifest default_events)
 * - name is shown on the create page; brand as Codesteward (not CodeSteward)
 */

export type GitHubAppManifest = {
  name: string;
  url: string;
  description?: string;
  public: boolean;
  redirect_url: string;
  callback_urls: string[];
  setup_url?: string;
  hook_attributes?: {
    url: string;
    active: boolean;
  };
  default_permissions: Record<string, "read" | "write" | "admin">;
  default_events: string[];
};

export type BuildManifestResult = {
  manifest: GitHubAppManifest;
  warnings: string[];
  webhookPublic: boolean;
  webhookUrl: string | null;
  createUrl: string;
};

const LOOPBACK =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i;

/** True when hostname is acceptable as a GitHub App webhook target. */
export function isPublicWebhookHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK.test(h)) return false;
  if (h.endsWith(".local") || h.endsWith(".internal")) return false;
  // RFC1918 + link-local
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return false;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return false;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return false;
  return true;
}

export function isPublicHttpUrl(raw: string | undefined | null): boolean {
  if (!raw?.trim()) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    // GitHub requires public internet; https preferred but http tunnels (smee) ok
    return isPublicWebhookHost(u.hostname);
  } catch {
    return false;
  }
}

function stripSlash(u: string): string {
  return u.replace(/\/$/, "");
}

/**
 * Resolve API / UI / webhook bases from env.
 * Prefer explicit webhook tunnel for local dogfood (smee.io, ngrok, cloudflared).
 */
export function resolvePublicBases(env: NodeJS.ProcessEnv = process.env): {
  uiBase: string;
  apiBase: string;
  webhookBase: string;
} {
  const uiBase = stripSlash(env.STEW_PUBLIC_URL ?? "http://localhost:8080");
  // API must be the real API host (8081 by default) — never fall back to UI :8080
  // or GitHub will redirect the manifest code to nginx/static.
  const apiBase = stripSlash(env.STEW_API_PUBLIC_URL ?? "http://localhost:8081");
  const webhookBase = stripSlash(
    env.STEW_WEBHOOK_PUBLIC_URL ??
      env.GITHUB_WEBHOOK_URL?.replace(/\/v1\/webhooks\/github\/?$/, "") ??
      env.STEW_API_PUBLIC_URL ??
      apiBase,
  );
  return { uiBase, apiBase, webhookBase };
}

/** Repository events that map to our permissions — never include installation*. */
export const MANIFEST_DEFAULT_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
  "check_run",
  "check_suite",
  // Optional coverage / FN signal (global + repo advisories when available)
  "security_advisory",
] as const;

export const MANIFEST_DEFAULT_PERMISSIONS: Record<
  string,
  "read" | "write" | "admin"
> = {
  contents: "read",
  metadata: "read",
  pull_requests: "write",
  checks: "write",
  issues: "read",
  // Needed so the app can post commit statuses when checks aren't used
  statuses: "write",
};

export function buildGitHubAppManifest(opts: {
  orgId?: string;
  /** Override displayed app name */
  name?: string;
  env?: NodeJS.ProcessEnv;
  /** GitHub org login for org-owned app create URL */
  githubOrg?: string;
}): BuildManifestResult {
  const env = opts.env ?? process.env;
  const { uiBase, apiBase, webhookBase } = resolvePublicBases(env);
  const warnings: string[] = [];

  const name =
    opts.name?.trim() ||
    env.GITHUB_APP_NAME?.trim() ||
    "Codesteward";

  const webhookPath = `${webhookBase}/v1/webhooks/github`;
  const webhookPublic = isPublicHttpUrl(webhookPath);
  const redirectBase = isPublicHttpUrl(apiBase) ? apiBase : apiBase; // localhost OK for redirect

  const manifest: GitHubAppManifest = {
    name,
    url: uiBase,
    description:
      env.GITHUB_APP_DESCRIPTION?.trim() ||
      "Codesteward — agentic PR gate and branch stewardship with structural graph evidence.",
    public: env.GITHUB_APP_PUBLIC === "1",
    redirect_url: `${stripSlash(redirectBase)}/v1/scm/github/manifest/callback`,
    callback_urls: [
      `${stripSlash(redirectBase)}/v1/scm/github/manifest/callback`,
    ],
    setup_url: `${stripSlash(redirectBase)}/v1/scm/github/setup`,
    default_permissions: { ...MANIFEST_DEFAULT_PERMISSIONS },
    default_events: [...MANIFEST_DEFAULT_EVENTS],
  };

  if (webhookPublic) {
    manifest.hook_attributes = {
      url: webhookPath,
      active: true,
    };
  } else {
    warnings.push(
      `Webhook URL is not public (${webhookPath}). GitHub rejects localhost/private hosts. ` +
        `Manifest omits hook_attributes so Create App succeeds. Set STEW_WEBHOOK_PUBLIC_URL ` +
        `(smee.io / ngrok / cloudflared HTTPS URL to your API) then re-create or add the webhook in App settings.`,
    );
  }

  if (!isPublicHttpUrl(apiBase)) {
    warnings.push(
      `redirect_url uses ${apiBase} — fine for local create; GitHub will POST the one-time code there. ` +
        `Ensure the API is reachable from your browser after Create.`,
    );
  }

  const githubOrg = opts.githubOrg ?? env.GITHUB_APP_OWNER_ORG;
  const createUrl = githubOrg
    ? `https://github.com/organizations/${encodeURIComponent(githubOrg)}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  return {
    manifest,
    warnings,
    webhookPublic,
    webhookUrl: webhookPublic ? webhookPath : null,
    createUrl,
  };
}
