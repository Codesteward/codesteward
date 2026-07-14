import type { ReviewJob } from "@codesteward/core";
import { jobId, nowIso, sessionId } from "@codesteward/core";
import type { GitHubScm } from "@codesteward/scm";
import { verifyGitHubSignature } from "./github-verify.js";

export interface GitHubWebhookDeps {
  secret: string;
  scm: GitHubScm;
  /** Create session + enqueue job */
  enqueueGate: (input: {
    session: {
      id: string;
      repoId: string;
      tenantId: string;
      orgId: string;
      repoPath?: string;
      mode: "gate";
      trigger: "webhook";
      baseSha: string;
      headSha: string;
      baseBranch: string;
      headBranch: string;
      prNumber: number;
      scmProvider: "github";
      scmFullName: string;
      riskTier: "full" | "lite" | "security" | "thorough" | "trivial";
      depth: "normal" | "fast" | "deep" | "thorough";
      status: "pending";
      stage: "queued";
      paths: string[];
    };
    job: Omit<ReviewJob, "id" | "enqueuedAt" | "attempts">;
  }) => Promise<{ sessionId: string; jobId: string }>;
  /** Resolve local clone path for owner/repo if available */
  resolveRepoPath?: (owner: string, repo: string) => string | undefined;
  /**
   * Map SCM installation / owner to product org id.
   * Must NOT default to SCM owner login (breaks multi-tenant isolation).
   */
  resolveProductOrgId?: (ctx: {
    installationId?: string;
    ownerLogin?: string;
  }) => string | Promise<string>;
  defaultRiskTier?: ReviewJob["riskTier"];
  /** Mention string that triggers review (default @codesteward) */
  mentionToken?: string;
}

export interface HandleResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handle GitHub webhook events for PR Gate path.
 * Supported:
 * - pull_request (opened, synchronize, reopened, ready_for_review)
 * - issue_comment (created) when body mentions @codesteward review
 */
export async function handleGitHubWebhook(
  deps: GitHubWebhookDeps,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<HandleResult> {
  const event = headers["x-github-event"] ?? headers["X-GitHub-Event"];
  const delivery =
    headers["x-github-delivery"] ?? headers["X-GitHub-Delivery"] ?? "unknown";
  const signature =
    headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];

  const requireSig =
    process.env.STEW_AUTH_STRICT === "1" ||
    process.env.NODE_ENV === "production" ||
    process.env.STEW_REQUIRE_WEBHOOK_SIG === "1";
  if (!deps.secret || deps.secret === "dev-insecure") {
    if (requireSig) {
      return {
        ok: false,
        status: 500,
        body: { error: "webhook_secret_required", message: "Set GITHUB_WEBHOOK_SECRET" },
      };
    }
  } else if (!verifyGitHubSignature(rawBody, signature, deps.secret)) {
    return { ok: false, status: 401, body: { error: "invalid signature" } };
  }

  if (event === "ping") {
    return { ok: true, status: 200, body: { message: "pong", delivery } };
  }

  if (event === "issue_comment") {
    return handleIssueCommentMention(deps, rawBody, delivery);
  }

  if (event !== "pull_request") {
    return {
      ok: true,
      status: 200,
      body: { ignored: true, event, delivery },
    };
  }

  let payload: GitHubPullRequestEvent;
  try {
    payload = JSON.parse(rawBody) as GitHubPullRequestEvent;
  } catch {
    return { ok: false, status: 400, body: { error: "invalid json" } };
  }

  const action = payload.action;
  if (
    !["opened", "synchronize", "reopened", "ready_for_review"].includes(action)
  ) {
    return {
      ok: true,
      status: 200,
      body: { ignored: true, action, delivery },
    };
  }

  if (payload.pull_request.draft && action !== "ready_for_review") {
    return {
      ok: true,
      status: 200,
      body: { ignored: true, reason: "draft", delivery },
    };
  }

  return enqueueFromPr(deps, payload, delivery, action);
}

async function handleIssueCommentMention(
  deps: GitHubWebhookDeps,
  rawBody: string,
  delivery: string,
): Promise<HandleResult> {
  let payload: GitHubIssueCommentEvent;
  try {
    payload = JSON.parse(rawBody) as GitHubIssueCommentEvent;
  } catch {
    return { ok: false, status: 400, body: { error: "invalid json" } };
  }

  if (payload.action !== "created") {
    return { ok: true, status: 200, body: { ignored: true, action: payload.action, delivery } };
  }

  // Only PR comments (issues have no pull_request)
  if (!payload.issue?.pull_request) {
    return { ok: true, status: 200, body: { ignored: true, reason: "not_pr_comment", delivery } };
  }

  const mention = (
    deps.mentionToken ??
    process.env.STEW_MENTION_TOKEN ??
    "@codesteward"
  ).toLowerCase();
  const body = (payload.comment?.body ?? "").toLowerCase();
  // Match "@codesteward review" or bare mention token + review keyword
  const triggers = [
    `${mention} review`,
    `${mention} please review`,
    `${mention} re-review`,
    `${mention} rereview`,
  ];
  const matched = triggers.some((t) => body.includes(t)) || (body.includes(mention) && body.includes("review"));
  if (!matched) {
    return {
      ok: true,
      status: 200,
      body: { ignored: true, reason: "no_mention_trigger", delivery },
    };
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const fullName = payload.repository.full_name;
  const prNumber = payload.issue.number;

  let pr;
  try {
    pr = await deps.scm.getPullRequest(owner, repo, prNumber);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "failed to load PR for mention trigger",
        detail: err instanceof Error ? err.message : String(err),
        delivery,
      },
    };
  }

  const synthetic: GitHubPullRequestEvent = {
    action: "mentioned",
    number: prNumber,
    pull_request: {
      number: prNumber,
      draft: false,
      base: { ref: pr.baseBranch, sha: pr.baseSha },
      head: { ref: pr.headBranch, sha: pr.headSha },
    },
    repository: {
      name: repo,
      full_name: fullName,
      owner: { login: owner },
    },
  };

  return enqueueFromPr(deps, synthetic, delivery, "mentioned");
}

async function enqueueFromPr(
  deps: GitHubWebhookDeps,
  payload: GitHubPullRequestEvent,
  delivery: string,
  action: string,
): Promise<HandleResult> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const fullName = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const baseSha = payload.pull_request.base.sha;
  const headSha = payload.pull_request.head.sha;
  const baseBranch = payload.pull_request.base.ref;
  const headBranch = payload.pull_request.head.ref;

  let paths: string[] = [];
  try {
    const files = await deps.scm.getDiff(owner, repo, prNumber);
    paths = files.map((f) => f.path);
  } catch (err) {
    paths = ["."];
    console.warn("[webhooks] getDiff failed", err);
  }

  const repoPath = deps.resolveRepoPath?.(owner, repo);
  const sid = sessionId();
  const riskTier = deps.defaultRiskTier ?? "full";
  const installationId = payload.installation?.id
    ? String(payload.installation.id)
    : undefined;
  const productOrgId = deps.resolveProductOrgId
    ? await deps.resolveProductOrgId({
        installationId,
        ownerLogin: owner,
      })
    : process.env.DEFAULT_ORG_ID ?? "local";

  const result = await deps.enqueueGate({
    session: {
      id: sid,
      repoId: fullName,
      tenantId: process.env.DEFAULT_TENANT_ID ?? "local",
      orgId: productOrgId,
      repoPath,
      mode: "gate",
      trigger: "webhook",
      baseSha,
      headSha,
      baseBranch,
      headBranch,
      prNumber,
      scmProvider: "github",
      scmFullName: fullName,
      riskTier,
      depth: "normal",
      status: "pending",
      stage: "queued",
      paths,
    },
    job: {
      sessionId: sid,
      mode: "gate",
      tenantId: process.env.DEFAULT_TENANT_ID ?? "local",
      repoId: fullName,
      repoPath,
      baseSha,
      headSha,
      baseBranch,
      prNumber,
      riskTier,
      depth: "normal",
      paths,
      crossRepo: true,
      webhookDeliveryId: delivery,
      installationId,
      scm: {
        provider: "github",
        owner,
        repo,
        prNumber,
        publish: true,
      },
    },
  });

  return {
    ok: true,
    status: 202,
    body: {
      accepted: true,
      delivery,
      action,
      pr: prNumber,
      repo: fullName,
      sessionId: result.sessionId,
      jobId: result.jobId,
      files: paths.length,
      trigger: action === "mentioned" ? "mention" : "pull_request",
    },
  };
}

interface GitHubPullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    draft?: boolean;
    base: { ref: string; sha: string };
    head: { ref: string; sha: string };
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
  installation?: { id: number };
}

interface GitHubIssueCommentEvent {
  action: string;
  comment?: { body?: string; user?: { login?: string } };
  issue: {
    number: number;
    pull_request?: { url?: string };
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
}

export function createWebhookJobId(delivery: string): string {
  return delivery ? `job_wh_${delivery.replace(/-/g, "").slice(0, 24)}` : jobId();
}

export { nowIso };
