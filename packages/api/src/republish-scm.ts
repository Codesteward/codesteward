/**
 * Republish a completed gate session's findings to the PR without re-running agents.
 * Uses owner-matched GitHub App install + diff-aware finding comments.
 */
import type { ReviewJob, ReviewSession } from "@codesteward/core";
import {
  buildPartialReviewSummary,
  buildReviewMermaid,
  evaluateGate,
  publishFindingsToPullRequest,
  type HealPublishStats,
} from "@codesteward/agents";
import { DEFAULT_POLICY } from "@codesteward/policy";
import { parseOwnerRepo } from "@codesteward/scm";
import { findingsStore } from "./shared-stores.js";
import { createOrgScmProvider } from "./org-scm.js";
import {
  reviewCompletedCommentBody,
  reviewFailedCommentBody,
  upsertPrStatusComment,
} from "./pr-status-comment.js";
import { globalSessionStore } from "./store.js";

export type RepublishResult = {
  ok: boolean;
  sessionId: string;
  publishedReviewId?: string;
  htmlUrl?: string;
  inlineCount: number;
  conversationCount?: number;
  findingCount: number;
  summaryOnly: boolean;
  statusCommentId?: string;
  error?: string;
};

function parseOwnerRepoFromSession(session: ReviewSession): {
  owner: string;
  repo: string;
  prNumber: number;
} | null {
  const full =
    session.scmFullName ||
    session.repoId ||
    (session.metadata?.scmFullName as string | undefined);
  const parsed = full ? parseOwnerRepo(full) : null;
  const owner =
    (session.metadata?.scmOwner as string | undefined) || parsed?.owner;
  const repo =
    (session.metadata?.scmRepo as string | undefined) || parsed?.repo;
  const prNumber = session.prNumber;
  if (!owner || !repo || prNumber == null) return null;
  return { owner, repo, prNumber };
}

function sessionStatusForPublish(
  status: string,
): "completed" | "completed_with_errors" | "failed" {
  if (status === "failed") return "failed";
  if (status === "completed_with_errors") return "completed_with_errors";
  return "completed";
}

function healStatsFromSession(session: ReviewSession): HealPublishStats {
  const hs = session.metadata?.healStats as
    | {
        totalUnits?: number;
        completedUnits?: number;
        recoveredUnits?: number;
        skippedUnits?: number;
        failedUnits?: number;
      }
    | undefined;
  const units = session.units ?? [];
  return {
    totalUnits: hs?.totalUnits ?? units.length,
    completedUnits:
      hs?.completedUnits ??
      units.filter((u) => u.status === "completed").length,
    recoveredUnits: hs?.recoveredUnits ?? 0,
    skippedUnits:
      hs?.skippedUnits ?? units.filter((u) => u.status === "skipped").length,
    failedUnits:
      hs?.failedUnits ?? units.filter((u) => u.status === "failed").length,
    failureLog: session.failureLog ?? [],
  };
}

/**
 * Publish (or re-publish) PR review + per-finding comments for a finished gate session.
 */
export async function republishSessionToScm(input: {
  sessionId: string;
  orgId: string;
  /** Prefer summary-only (no per-finding posts). */
  summaryOnly?: boolean;
  /** Kept for API compat; finding placement is driven by PR diff hunks. */
  cloneForGrounding?: boolean;
}): Promise<RepublishResult> {
  const session = await globalSessionStore.getLive(input.sessionId);
  if (!session) {
    return {
      ok: false,
      sessionId: input.sessionId,
      inlineCount: 0,
      findingCount: 0,
      summaryOnly: true,
      error: "session not found",
    };
  }
  if ((session.orgId ?? "local") !== input.orgId) {
    return {
      ok: false,
      sessionId: input.sessionId,
      inlineCount: 0,
      findingCount: 0,
      summaryOnly: true,
      error: "session not in active org",
    };
  }

  const terminal = new Set([
    "completed",
    "completed_with_errors",
    "failed",
  ]);
  if (!terminal.has(session.status)) {
    return {
      ok: false,
      sessionId: input.sessionId,
      inlineCount: 0,
      findingCount: 0,
      summaryOnly: true,
      error: `session status ${session.status} is not terminal — wait for the review to finish or use cancel`,
    };
  }

  const coords = parseOwnerRepoFromSession(session);
  if (!coords) {
    return {
      ok: false,
      sessionId: input.sessionId,
      inlineCount: 0,
      findingCount: 0,
      summaryOnly: true,
      error: "session missing PR coordinates (scmFullName / prNumber)",
    };
  }

  const findings = await findingsStore.list({ sessionId: session.id });
  const { owner, repo, prNumber } = coords;
  const scm = await createOrgScmProvider(
    input.orgId,
    session.scmProvider ?? "github",
    owner,
  );

  const jobLike = {
    id: `republish_${session.id}`,
    sessionId: session.id,
    mode: session.mode,
    tenantId: session.tenantId,
    orgId: session.orgId,
    repoId: session.repoId,
    repoPath: session.repoPath,
    baseSha: session.baseSha,
    headSha: session.headSha,
    baseBranch: session.baseBranch,
    headBranch: session.headBranch,
    prNumber,
    riskTier: session.riskTier,
    depth: session.depth,
    paths: (session.metadata?.paths as string[] | undefined) ?? undefined,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    scm: {
      provider: (session.scmProvider ?? "github") as "github",
      owner,
      repo,
      prNumber,
      publish: true,
    },
  } as ReviewJob;

  const stats = healStatsFromSession(session);
  const sessStatus = sessionStatusForPublish(session.status);
  const summaryBase = buildPartialReviewSummary({
    job: jobLike,
    findings: findings.map((f) => ({
      path: f.path,
      startLine: f.startLine,
      title: f.title,
      severity: f.severity,
    })),
    stats,
    sessionStatus: sessStatus,
  });
  const trailer = [
    "",
    "---",
    `STW-REVIEWED: session=${session.id}`,
    `STW-REVIEWED-SHA: ${session.headSha ?? "unknown"}`,
    `STW-REVIEWED-STATUS: ${sessStatus}`,
    `STW-REVIEWED-FINDINGS: ${findings.length}`,
    "STW-REPUBLISH: 1",
  ].join("\n");
  const diagram = buildReviewMermaid({
    repoId: session.repoId,
    mode: session.mode,
    paths: jobLike.paths ?? [],
    findings: findings.map((f) => ({
      path: f.path,
      severity: f.severity,
      title: f.title,
    })),
  });
  let summary =
    summaryBase +
    `\n\n### Change map\n\n${diagram}` +
    trailer +
    `\n\n_Republished from Codesteward UI/API without re-running agents._`;

  const gate = evaluateGate({
    policy: DEFAULT_POLICY,
    findings,
    sessionStatus: sessStatus,
    riskTier: session.riskTier,
    depth: session.depth,
    findingCount: findings.length,
  });
  summary +=
    `\n\n### Merge gate\n\n- **Mode:** ${gate.advisory ? "advisory" : "enforce"}\n` +
    `- **Check:** ${gate.checkTitle}\n` +
    `- **Reasons:** ${gate.reasons.join("; ") || "—"}\n`;

  let publishedReviewId: string | undefined;
  let htmlUrl: string | undefined;
  let inlineCount = 0;
  let conversationCount = 0;
  let publishError: string | undefined;

  if (input.summaryOnly) {
    try {
      const posted = await scm.postReview(
        owner,
        repo,
        prNumber,
        summary,
        [],
        gate.reviewEvent,
      );
      publishedReviewId = posted.id;
      htmlUrl = posted.htmlUrl;
    } catch (err) {
      publishError = err instanceof Error ? err.message : String(err);
    }
  } else {
    const pub = await publishFindingsToPullRequest({
      scm,
      owner,
      repo,
      prNumber,
      headSha: session.headSha,
      summaryBody: summary,
      reviewEvent: gate.reviewEvent,
      findings: findings.map((f) => ({
        id: f.id,
        path: f.path,
        startLine: f.startLine,
        endLine: f.endLine,
        title: f.title,
        body: f.body,
        severity: f.severity,
        category: f.category,
        suggestion: f.suggestion,
        suggestedFix: f.suggestedFix,
        existingCode: f.existingCode,
        evidence: f.evidence,
        fingerprint: f.fingerprint,
      })),
    });
    publishedReviewId = pub.reviewId;
    htmlUrl = pub.reviewHtmlUrl;
    inlineCount = pub.inlineCount;
    conversationCount = pub.conversationCount;
    if (pub.errors.length) {
      publishError = pub.errors.slice(0, 3).join("; ");
    }
    for (const [fid, cid] of Object.entries(pub.postedByFindingId)) {
      try {
        await findingsStore.update(fid, { scmCommentId: cid });
      } catch {
        /* optional */
      }
    }
    if (!publishedReviewId && conversationCount === 0) {
      publishError = publishError ?? "SCM publish produced no review or comments";
    } else if (!publishedReviewId && conversationCount > 0) {
      // Conversation comments alone still count as a successful publish
      publishedReviewId = `conversation:${conversationCount}`;
    }
  }

  const existingId =
    (session.metadata?.statusCommentId as string | undefined) ||
    (session.metadata?.prStatusCommentId as string | undefined);
  const uiBase =
    process.env.STEW_PUBLIC_URL ||
    process.env.STEW_UI_PUBLIC_URL ||
    process.env.STEW_API_PUBLIC_URL;
  const body =
    session.status === "failed" && !publishedReviewId
      ? reviewFailedCommentBody({
          sessionId: session.id,
          error: publishError ?? session.error ?? "publish failed",
          uiBase,
        })
      : reviewCompletedCommentBody({
          sessionId: session.id,
          verdict: session.verdict,
          findingCount: findings.length,
          uiBase,
          published: Boolean(publishedReviewId),
          publishError:
            publishedReviewId && publishError ? undefined : publishError,
        });

  let statusCommentId: string | undefined;
  try {
    const posted = await upsertPrStatusComment({
      scm,
      owner,
      repo,
      prNumber,
      body,
      existingCommentId: existingId,
    });
    statusCommentId = posted?.id;
  } catch {
    /* best-effort */
  }

  if (publishedReviewId || statusCommentId) {
    globalSessionStore.update(session.id, {
      metadata: {
        ...session.metadata,
        publishedReviewId:
          publishedReviewId ?? session.metadata?.publishedReviewId,
        lastRepublishAt: new Date().toISOString(),
        lastRepublishReviewId: publishedReviewId,
        lastRepublishInline: inlineCount,
        lastRepublishConversation: conversationCount,
        statusCommentId: statusCommentId ?? existingId,
        prStatusCommentId: statusCommentId ?? existingId,
      },
    });
    globalSessionStore.pushEvent(session.id, {
      type: "log",
      sessionId: session.id,
      level: publishError && !publishedReviewId ? "warn" : "info",
      message: publishedReviewId
        ? `Republished PR review id=${publishedReviewId} findings=${findings.length} inline=${inlineCount} conversation=${conversationCount}`
        : `Republish failed: ${publishError ?? "unknown"}`,
      ts: new Date().toISOString(),
    });
  }

  if (!publishedReviewId) {
    return {
      ok: false,
      sessionId: session.id,
      inlineCount: 0,
      conversationCount: 0,
      findingCount: findings.length,
      summaryOnly: true,
      statusCommentId,
      error: publishError ?? "SCM postReview failed",
    };
  }

  return {
    ok: true,
    sessionId: session.id,
    publishedReviewId,
    htmlUrl,
    inlineCount,
    conversationCount,
    findingCount: findings.length,
    summaryOnly: inlineCount === 0 && conversationCount === 0,
    statusCommentId,
  };
}

/** Best-effort delete of a PR review (only works for *pending* reviews on GitHub). */
export async function deletePrReview(input: {
  orgId: string;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: string | number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const { pickGithubInstallation } = await import(
      "./github-installation-pick.js"
    );
    const { getInstallationAccessToken } = await import("@codesteward/scm");
    const store = getTenancyStore();
    const installs = await store.listInstallations(input.orgId);
    const gh = pickGithubInstallation(
      installs.map((i) => ({
        provider: i.provider,
        installationId: String(i.installationId ?? ""),
        accountLogin: i.accountLogin,
        status: i.status,
      })),
      input.owner,
    );
    const cfg = await store.getGitHubAppConfig(input.orgId);
    const creds = store.resolveGitHubAppCredentials(cfg);
    if (!creds || !gh?.installationId) {
      return { ok: false, error: "no github app credentials" };
    }
    const inst = await getInstallationAccessToken({
      credentials: {
        appId: creds.appId,
        privateKeyPem: creds.privateKey,
        baseUrl: creds.baseUrl ?? cfg?.baseUrl,
      },
      installationId: gh.installationId,
    });
    const res = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/reviews/${input.reviewId}`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${inst.token}`,
          "User-Agent": "codesteward-cleanup",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
