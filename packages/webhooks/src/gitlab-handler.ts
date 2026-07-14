import type { ReviewJob } from "@codesteward/core";
import { jobId, nowIso, sessionId } from "@codesteward/core";
import type { GitLabScm } from "@codesteward/scm";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface GitLabWebhookDeps {
  secret: string;
  scm: GitLabScm;
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
      scmProvider: "gitlab";
      scmFullName: string;
      riskTier: "full" | "lite" | "security" | "thorough" | "trivial";
      depth: "normal" | "fast" | "deep" | "thorough";
      status: "pending";
      stage: "queued";
      paths: string[];
    };
    job: Omit<ReviewJob, "id" | "enqueuedAt" | "attempts">;
  }) => Promise<{ sessionId: string; jobId: string }>;
  resolveRepoPath?: (owner: string, repo: string) => string | undefined;
  defaultRiskTier?: ReviewJob["riskTier"];
}

export interface GitLabHandleResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/**
 * Verify GitLab token header (X-Gitlab-Token) against secret.
 * GitLab uses a shared secret token, not HMAC by default.
 */
export function verifyGitLabToken(
  tokenHeader: string | undefined,
  secret: string,
): boolean {
  if (!tokenHeader || !secret) return false;
  try {
    const a = Buffer.from(tokenHeader);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Optional HMAC if operators set GITLAB_WEBHOOK_HMAC=1 and send X-Gitlab-Signature */
export function verifyGitLabHmac(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader.replace(/^sha256=/, ""));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Handle GitLab Merge Request webhooks (object_kind=merge_request).
 */
export async function handleGitLabWebhook(
  deps: GitLabWebhookDeps,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<GitLabHandleResult> {
  const event =
    headers["x-gitlab-event"] ?? headers["X-Gitlab-Event"] ?? "unknown";
  const delivery =
    headers["x-gitlab-event-uuid"] ??
    headers["X-Gitlab-Event-UUID"] ??
    headers["x-request-id"] ??
    "unknown";
  const token = headers["x-gitlab-token"] ?? headers["X-Gitlab-Token"];
  const hmacSig =
    headers["x-gitlab-signature"] ?? headers["X-Gitlab-Signature"];

  if (deps.secret && deps.secret !== "dev-insecure") {
    const tokenOk = verifyGitLabToken(token, deps.secret);
    const hmacOk =
      process.env.GITLAB_WEBHOOK_HMAC === "1"
        ? verifyGitLabHmac(rawBody, hmacSig, deps.secret)
        : false;
    if (!tokenOk && !hmacOk) {
      return { ok: false, status: 401, body: { error: "invalid gitlab token/signature" } };
    }
  }

  let payload: GitLabMrEvent;
  try {
    payload = JSON.parse(rawBody) as GitLabMrEvent;
  } catch {
    return { ok: false, status: 400, body: { error: "invalid json" } };
  }

  const kind = payload.object_kind ?? payload.event_type;
  if (kind !== "merge_request") {
    return {
      ok: true,
      status: 200,
      body: { ignored: true, event, kind, delivery },
    };
  }

  const action = payload.object_attributes?.action ?? "";
  if (!["open", "update", "reopen", "merge"].includes(action) || action === "merge") {
    // Accept open/update/reopen only
    if (!["open", "update", "reopen"].includes(action)) {
      return { ok: true, status: 200, body: { ignored: true, action, delivery } };
    }
  }

  const attrs = payload.object_attributes;
  if (!attrs) {
    return { ok: false, status: 400, body: { error: "missing object_attributes" } };
  }

  if (attrs.draft || attrs.work_in_progress) {
    return { ok: true, status: 200, body: { ignored: true, reason: "draft", delivery } };
  }

  const pathWithNamespace =
    payload.project?.path_with_namespace ??
    `${payload.project?.namespace ?? "unknown"}/${payload.project?.name ?? "repo"}`;
  const [owner, ...rest] = pathWithNamespace.split("/");
  const repo = rest.join("/") || pathWithNamespace;
  const fullName = pathWithNamespace;
  const prNumber = attrs.iid;
  const baseSha = attrs.diff_refs?.base_sha ?? attrs.oldrev ?? attrs.last_commit?.id ?? "";
  const headSha = attrs.diff_refs?.head_sha ?? attrs.last_commit?.id ?? attrs.sha ?? "";
  const baseBranch = attrs.target_branch;
  const headBranch = attrs.source_branch;

  let paths: string[] = [];
  try {
    const files = await deps.scm.getDiff(owner!, repo, prNumber);
    paths = files.map((f) => f.path);
  } catch (err) {
    paths = ["."];
    console.warn("[webhooks/gitlab] getDiff failed", err);
  }

  const repoPath = deps.resolveRepoPath?.(owner!, repo);
  const sid = sessionId();
  const riskTier = deps.defaultRiskTier ?? "full";

  const result = await deps.enqueueGate({
    session: {
      id: sid,
      repoId: fullName,
      tenantId: process.env.DEFAULT_TENANT_ID ?? "local",
      orgId: owner ?? "local",
      repoPath,
      mode: "gate",
      trigger: "webhook",
      baseSha,
      headSha,
      baseBranch,
      headBranch,
      prNumber,
      scmProvider: "gitlab",
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
      scm: {
        provider: "gitlab",
        owner: owner ?? "local",
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
      event,
      mr: prNumber,
      repo: fullName,
      sessionId: result.sessionId,
      jobId: result.jobId,
      files: paths.length,
    },
  };
}

interface GitLabMrEvent {
  object_kind?: string;
  event_type?: string;
  object_attributes?: {
    iid: number;
    action?: string;
    source_branch: string;
    target_branch: string;
    draft?: boolean;
    work_in_progress?: boolean;
    sha?: string;
    oldrev?: string;
    last_commit?: { id?: string };
    diff_refs?: { base_sha?: string; head_sha?: string };
  };
  project?: {
    name?: string;
    namespace?: string;
    path_with_namespace?: string;
  };
}

export { nowIso, jobId };
