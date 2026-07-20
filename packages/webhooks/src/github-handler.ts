import type { ReviewJob } from "@codesteward/core";
import { jobId, nowIso, sessionId } from "@codesteward/core";
import type { GitHubScm } from "@codesteward/scm";
import { verifyGitHubSignature } from "./github-verify.js";

export interface CommentTriageHookResult {
  intent: "review" | "learn" | "ignore" | "clarify";
  /** When intent is review (or dual), enqueue a gate job. */
  shouldReview: boolean;
  /** Optional focus string stored on the job / session metadata. */
  reviewFocus?: string;
  /** Optional reply posted back on the PR. */
  reply?: string;
}

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
      metadata?: Record<string, unknown>;
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
  /**
   * Optional cheap-model / heuristic triage for @mention comments.
   * When set, non-review intents can still save learnings without enqueueing.
   */
  triageComment?: (input: {
    commentBody: string;
    repoId: string;
    prNumber: number;
    author?: string;
    prTitle?: string;
    orgId: string;
  }) => Promise<CommentTriageHookResult>;
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
 * - pull_request (closed + merged) → pr_outcome job (indirect eval)
 * - issue_comment (created) when body mentions @codesteward
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

  // Merged PR → outcome analysis (accepted / ignored / agent-miss candidates)
  if (action === "closed" && payload.pull_request.merged === true) {
    return enqueuePrOutcome(deps, payload, delivery, "merged");
  }

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

  const result = await enqueueFromPr(deps, payload, delivery, action);
  // SCM-only signal: react on the PR when a repo-triggered review was accepted
  if (result.ok && result.status === 202) {
    await ackWebhookReviewStarted(deps, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.pull_request.number,
      kind: "pull_request",
      action,
    });
  }
  return result;
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
  const bodyRaw = payload.comment?.body ?? "";
  const body = bodyRaw.toLowerCase();
  if (!body.includes(mention)) {
    return {
      ok: true,
      status: 200,
      body: { ignored: true, reason: "no_mention", delivery },
    };
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const fullName = payload.repository.full_name;
  const prNumber = payload.issue.number;

  const installationId = payload.installation?.id
    ? String(payload.installation.id)
    : undefined;
  const productOrgId = deps.resolveProductOrgId
    ? await deps.resolveProductOrgId({
        installationId,
        ownerLogin: owner,
      })
    : process.env.DEFAULT_ORG_ID ?? "local";

  // Cheap-model triage when available; else legacy keyword match
  let triage: CommentTriageHookResult | undefined;
  if (deps.triageComment) {
    try {
      triage = await deps.triageComment({
        commentBody: bodyRaw,
        repoId: fullName,
        prNumber,
        author: payload.comment?.user?.login,
        orgId: productOrgId,
      });
    } catch (err) {
      console.warn(
        "[webhooks] triageComment failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!triage) {
    // Legacy: only trigger on explicit review keywords
    const triggers = [
      `${mention} review`,
      `${mention} please review`,
      `${mention} re-review`,
      `${mention} rereview`,
    ];
    const matched =
      triggers.some((t) => body.includes(t)) ||
      (body.includes(mention) && body.includes("review"));
    if (!matched) {
      return {
        ok: true,
        status: 200,
        body: { ignored: true, reason: "no_mention_trigger", delivery },
      };
    }
    triage = { intent: "review", shouldReview: true };
  }

  // Post optional reply (learn/clarify/ack)
  if (triage.reply) {
    try {
      await deps.scm.postComment(owner, repo, prNumber, triage.reply);
    } catch (err) {
      console.warn(
        "[webhooks] postComment (triage reply) failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!triage.shouldReview) {
    return {
      ok: true,
      status: 200,
      body: {
        accepted: true,
        delivery,
        intent: triage.intent,
        reviewed: false,
        learning: triage.intent === "learn",
        pr: prNumber,
        repo: fullName,
      },
    };
  }

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
      title: pr.title,
      body: pr.body,
    },
    repository: {
      name: repo,
      full_name: fullName,
      owner: { login: owner },
    },
    installation: payload.installation,
  };

  const result = await enqueueFromPr(deps, synthetic, delivery, "mentioned", {
    reviewFocus: triage.reviewFocus,
    orgId: productOrgId,
  });
  if (result.ok && result.status === 202) {
    await ackWebhookReviewStarted(deps, {
      owner,
      repo,
      prNumber,
      kind: "mention",
      commentId: payload.comment?.id,
    });
  }
  return result;
}

/**
 * Visible "we saw this" feedback on SCM-triggered reviews only.
 * Never called for UI/API-started sessions (those never enter this webhook path).
 *
 * - @mention → 👀 on the triggering comment
 * - PR open/sync/… → 👀 on the PR itself
 */
async function ackWebhookReviewStarted(
  deps: GitHubWebhookDeps,
  opts: {
    owner: string;
    repo: string;
    prNumber: number;
    kind: "mention" | "pull_request";
    commentId?: number | string;
    action?: string;
  },
): Promise<void> {
  if (process.env.STEW_PR_REACT === "0" || process.env.STEW_PR_REACT === "false") {
    return;
  }
  const react = deps.scm.createReaction?.bind(deps.scm);
  if (!react) return;
  try {
    if (opts.kind === "mention" && opts.commentId != null) {
      await react(opts.owner, opts.repo, { commentId: opts.commentId }, "eyes");
    } else {
      // PR-level reaction (GitHub treats PRs as issues for this API)
      await react(opts.owner, opts.repo, { issueNumber: opts.prNumber }, "eyes");
    }
  } catch (err) {
    console.warn(
      "[webhooks] start reaction failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function enqueueFromPr(
  deps: GitHubWebhookDeps,
  payload: GitHubPullRequestEvent,
  delivery: string,
  action: string,
  extra?: { reviewFocus?: string; orgId?: string },
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
  const productOrgId =
    extra?.orgId ??
    (deps.resolveProductOrgId
      ? await deps.resolveProductOrgId({
          installationId,
          ownerLogin: owner,
        })
      : process.env.DEFAULT_ORG_ID ?? "local");

  const metadata: Record<string, unknown> = {};
  if (extra?.reviewFocus) metadata.reviewFocus = extra.reviewFocus;
  if (payload.pull_request.title) metadata.prTitle = payload.pull_request.title;
  if (payload.pull_request.body) metadata.prBody = payload.pull_request.body;

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
      metadata: Object.keys(metadata).length ? metadata : undefined,
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
      metadata: Object.keys(metadata).length ? metadata : undefined,
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
      reviewFocus: extra?.reviewFocus,
    },
  };
}

interface GitHubPullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    draft?: boolean;
    merged?: boolean;
    merge_commit_sha?: string | null;
    title?: string;
    body?: string;
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

/** Enqueue lightweight session + pr_outcome job (no agent review). */
async function enqueuePrOutcome(
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
  const mergeSha =
    payload.pull_request.merge_commit_sha || headSha || undefined;
  const baseBranch = payload.pull_request.base.ref;
  const headBranch = payload.pull_request.head.ref;

  let paths: string[] = [];
  let patches: ReviewJob["patches"];
  try {
    const files = await deps.scm.getDiff(owner, repo, prNumber);
    paths = files.map((f) => f.path);
    patches = files.map((f) => ({
      path: f.path,
      patch: f.patch,
      status: f.status as "added" | "modified" | "removed" | "renamed" | undefined,
      additions: f.additions,
      deletions: f.deletions,
      previousPath: f.previousPath,
    }));
  } catch (err) {
    console.warn("[webhooks] getDiff for merge outcome failed", err);
    paths = [];
  }

  const repoPath = deps.resolveRepoPath?.(owner, repo);
  const sid = sessionId();
  const installationId = payload.installation?.id
    ? String(payload.installation.id)
    : undefined;
  const productOrgId = deps.resolveProductOrgId
    ? await deps.resolveProductOrgId({
        installationId,
        ownerLogin: owner,
      })
    : process.env.DEFAULT_ORG_ID ?? "local";

  const metadata: Record<string, unknown> = {
    jobKind: "pr_outcome",
    mergeSha,
    pathsChanged: paths,
    prTitle: payload.pull_request.title,
  };

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
      headSha: mergeSha ?? headSha,
      baseBranch,
      headBranch,
      prNumber,
      scmProvider: "github",
      scmFullName: fullName,
      riskTier: deps.defaultRiskTier ?? "full",
      depth: "normal",
      status: "pending",
      stage: "queued",
      paths,
      metadata,
    },
    job: {
      sessionId: sid,
      mode: "gate",
      jobKind: "pr_outcome",
      tenantId: process.env.DEFAULT_TENANT_ID ?? "local",
      orgId: productOrgId,
      repoId: fullName,
      repoPath,
      baseSha,
      headSha: mergeSha ?? headSha,
      baseBranch,
      prNumber,
      riskTier: deps.defaultRiskTier ?? "full",
      depth: "normal",
      paths,
      crossRepo: false,
      webhookDeliveryId: delivery,
      installationId,
      patches,
      scm: {
        provider: "github",
        owner,
        repo,
        prNumber,
        publish: false,
      },
      metadata,
    },
  });

  return {
    ok: true,
    status: 202,
    body: {
      accepted: true,
      delivery,
      action,
      jobKind: "pr_outcome",
      pr: prNumber,
      repo: fullName,
      sessionId: result.sessionId,
      jobId: result.jobId,
      files: paths.length,
      mergeSha,
    },
  };
}

interface GitHubIssueCommentEvent {
  action: string;
  comment?: { id?: number; body?: string; user?: { login?: string } };
  issue: {
    number: number;
    pull_request?: { url?: string };
  };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
  installation?: { id: number };
}

export function createWebhookJobId(delivery: string): string {
  return delivery ? `job_wh_${delivery.replace(/-/g, "").slice(0, 24)}` : jobId();
}

export { nowIso };
