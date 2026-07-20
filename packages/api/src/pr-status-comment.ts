/**
 * Visible PR progress comments for webhook-triggered reviews.
 * Start: "Re-reviewing now…" / "Reviewing…"
 * Fail: update same comment or post a new one so users who never open the UI see the error.
 */
import type { ScmProvider } from "@codesteward/scm";

const MARKER = "<!-- codesteward-status -->";

export function reviewStartedCommentBody(input: {
  sessionId: string;
  action?: string;
}): string {
  const verb =
    input.action === "synchronize" || input.action === "mentioned"
      ? "Re-reviewing"
      : "Reviewing";
  return [
    MARKER,
    `### 🔄 Codesteward — ${verb} now`,
    "",
    `Session \`${input.sessionId}\` is queued / running.`,
    "",
    "_This comment updates when the review finishes or fails._",
  ].join("\n");
}

export function reviewFailedCommentBody(input: {
  sessionId: string;
  error: string;
  uiBase?: string;
}): string {
  const short =
    input.error.length > 1200
      ? input.error.slice(0, 1200) + "…"
      : input.error;
  const link = input.uiBase
    ? `\n\nOpen in UI: ${input.uiBase.replace(/\/$/, "")}/sessions?session=${encodeURIComponent(input.sessionId)}`
    : "";
  return [
    MARKER,
    `### ❌ Codesteward — review failed`,
    "",
    `Session \`${input.sessionId}\` **failed** before/during the review.`,
    "",
    "```",
    short,
    "```",
    "",
    "Common causes: GitHub App not installed on this repository, missing **Contents: Read**, or wrong installation for the org.",
    link,
  ].join("\n");
}

export function reviewCompletedCommentBody(input: {
  sessionId: string;
  verdict?: string;
  findingCount?: number;
  uiBase?: string;
  /** When the review finished but PR review publish failed */
  published?: boolean;
  publishError?: string;
}): string {
  const link = input.uiBase
    ? `\n\nOpen in UI: ${input.uiBase.replace(/\/$/, "")}/sessions?session=${encodeURIComponent(input.sessionId)}`
    : "";
  const published =
    input.published === false
      ? "\n\n⚠️ Findings are in the Codesteward UI, but posting the GitHub review failed" +
        (input.publishError
          ? `:\n\n\`\`\`\n${input.publishError.slice(0, 400)}\n\`\`\``
          : ".")
      : input.published
        ? "\n\nA pull request review with inline comments was posted."
        : "";
  const icon =
    input.published === false ? "⚠️" : input.verdict === "request_changes" ? "🔴" : "✅";
  return [
    MARKER,
    `### ${icon} Codesteward — review finished`,
    "",
    `Session \`${input.sessionId}\` completed` +
      (input.verdict ? ` (verdict: **${input.verdict}**)` : "") +
      (input.findingCount != null ? ` · **${input.findingCount}** finding(s)` : "") +
      ".",
    published,
    link,
  ].join("\n");
}

/**
 * Post a new status comment or PATCH an existing one (by id).
 */
export async function upsertPrStatusComment(opts: {
  scm: ScmProvider;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  existingCommentId?: string | number;
}): Promise<{ id: string } | undefined> {
  if (process.env.STEW_PR_STATUS_COMMENT === "0") return undefined;
  try {
    if (
      opts.existingCommentId != null &&
      typeof opts.scm.updateComment === "function"
    ) {
      const updated = await opts.scm.updateComment(
        opts.owner,
        opts.repo,
        opts.existingCommentId,
        opts.body,
      );
      return { id: updated.id };
    }
    const posted = await opts.scm.postComment(
      opts.owner,
      opts.repo,
      opts.prNumber,
      opts.body,
    );
    return { id: posted.id };
  } catch (err) {
    console.warn(
      "[pr-status-comment] failed:",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
