/**
 * Publish gate findings to the PR with full UI-style bodies.
 * - Inline review comments when the line is in the PR diff (GitHub requires this).
 * - Otherwise dedicated PR conversation comments so findings are never dropped silently.
 */
import type { Severity } from "@codesteward/core";
import type { DiffFile, ReviewComment, ScmProvider } from "@codesteward/scm";
import { capComments } from "./noise.js";

export type PublishableFinding = {
  id?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  title: string;
  body: string;
  severity: string;
  category?: string;
  suggestion?: string;
  suggestedFix?: string;
  existingCode?: string;
  evidence?: Array<{ snippet?: string; summary?: string }>;
  fingerprint?: string;
  scmCommentId?: string;
};

export type FindingPublishResult = {
  /** Review id for the summary event (APPROVE / COMMENT / REQUEST_CHANGES) */
  reviewId?: string;
  reviewHtmlUrl?: string;
  inlineCount: number;
  conversationCount: number;
  skippedCount: number;
  /** finding id → scm comment id */
  postedByFindingId: Record<string, string>;
  errors: string[];
};

const MARKER = "<!-- codesteward-finding -->";

/** Parse RIGHT-side line numbers present in a unified diff patch (GitHub comment targets). */
export function parseDiffRightLines(patch?: string): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let newLine = 0;
  for (const row of patch.split("\n")) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (
      row.startsWith("\\") ||
      row.startsWith("diff ") ||
      row.startsWith("index ") ||
      row.startsWith("---") ||
      row.startsWith("+++")
    ) {
      continue;
    }
    if (row.startsWith("+")) {
      lines.add(newLine);
      newLine += 1;
    } else if (row.startsWith("-")) {
      // deletion only on LEFT — not a RIGHT comment target
    } else {
      // context line exists on both sides
      lines.add(newLine);
      newLine += 1;
    }
  }
  return lines;
}

export function buildDiffLineIndex(
  files: DiffFile[],
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of files) {
    // Fully added files: any line in the new file is commentable if we have the patch;
    // still prefer patch-derived lines (GitHub may truncate huge patches).
    map.set(f.path, parseDiffRightLines(f.patch));
  }
  return map;
}

/**
 * Map a source path to a GitHub-flavored Markdown fence language id.
 * Empty string → untagged fence (still valid GFM).
 */
export function markdownLanguageFromPath(path?: string): string {
  if (!path) return "";
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const lower = base.toLowerCase();

  // Multi-dot / special basenames first
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "makefile";
  if (lower.endsWith(".tf") || lower.endsWith(".tfvars")) return "hcl";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";

  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = lower.slice(dot + 1);

  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    go: "go",
    rs: "rust",
    py: "python",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    scala: "scala",
    cs: "csharp",
    fs: "fsharp",
    php: "php",
    swift: "swift",
    c: "c",
    h: "c",
    cc: "cpp",
    cxx: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    hh: "cpp",
    m: "objectivec",
    mm: "objectivec",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "bash",
    ps1: "powershell",
    psm1: "powershell",
    json: "json",
    jsonc: "json",
    json5: "json",
    toml: "toml",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    env: "bash",
    md: "markdown",
    mdx: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xml: "xml",
    svg: "xml",
    graphql: "graphql",
    gql: "graphql",
    proto: "protobuf",
    proto3: "protobuf",
    r: "r",
    lua: "lua",
    pl: "perl",
    pm: "perl",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    clj: "clojure",
    cljs: "clojure",
    dart: "dart",
    groovy: "groovy",
    gradle: "groovy",
    vue: "vue",
    svelte: "svelte",
    sol: "solidity",
    zig: "zig",
    nim: "nim",
    bicep: "bicep",
    cue: "cue",
    nix: "nix",
  };
  return map[ext] ?? "";
}

/** Fenced block with language tag when known; strips accidental outer fences from content. */
export function fencedCodeBlock(code: string, language = ""): string {
  let body = code.trim();
  // Drop a single outer fence if the model already wrapped the snippet
  const wrapped = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\s*$/.exec(body);
  if (wrapped) body = wrapped[1]!.trimEnd();
  // Avoid breaking the outer fence if content contains ```
  if (body.includes("```")) {
    body = body.replace(/```/g, "'''");
  }
  const lang = language.trim();
  return lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\``;
}

/**
 * Format a finding the way the UI surfaces it: severity, path, explanation,
 * suggestion, and proposed fix code block (with GFM language highlighting).
 */
export function formatFindingPrCommentBody(
  f: PublishableFinding,
  opts?: { inline?: boolean },
): string {
  const lang = markdownLanguageFromPath(f.path);
  const loc =
    f.path != null
      ? `\`${f.path}${f.startLine != null ? `:${f.startLine}` : ""}${
          f.endLine != null && f.endLine !== f.startLine ? `-${f.endLine}` : ""
        }\``
      : "";
  const parts = [
    MARKER,
    `### ${severityEmoji(f.severity)} ${f.title}`,
    "",
    `**${f.severity}** · ${f.category ?? "other"}${loc ? ` · ${loc}` : ""}`,
    "",
    f.body?.trim() || "_No description._",
  ];
  if (f.existingCode?.trim()) {
    parts.push("", "**Context:**", fencedCodeBlock(f.existingCode, lang));
  }
  if (f.suggestion?.trim()) {
    parts.push("", `**Suggestion:** ${f.suggestion.trim()}`);
  }
  if (f.suggestedFix?.trim()) {
    parts.push("", "**Proposed fix:**", fencedCodeBlock(f.suggestedFix, lang));
  }
  if (f.fingerprint) {
    parts.push("", `<!-- fingerprint:${f.fingerprint} -->`);
  }
  if (f.id) {
    parts.push(`<!-- finding:${f.id} -->`);
  }
  if (!opts?.inline) {
    parts.push(
      "",
      "_Posted as a conversation comment because this line is outside the PR diff hunks (GitHub cannot attach an inline review comment)._",
    );
  }
  return parts.join("\n");
}

function severityEmoji(sev: string): string {
  switch (sev) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
    default:
      return "⚪";
  }
}

function pickLine(
  f: PublishableFinding,
  valid: Set<number> | undefined,
): number | undefined {
  if (f.startLine == null || !valid || valid.size === 0) return undefined;
  if (valid.has(f.startLine)) return f.startLine;
  if (f.endLine != null && valid.has(f.endLine)) return f.endLine;
  // nearest line in the same vicinity (helps when relocate drifts by a few lines)
  let best: number | undefined;
  let bestDist = Infinity;
  for (const n of valid) {
    const d = Math.abs(n - f.startLine);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  // only snap within 20 lines — otherwise prefer conversation comment
  if (best != null && bestDist <= 20) return best;
  return undefined;
}

/**
 * Post summary review + per-finding comments (inline when possible).
 */
export async function publishFindingsToPullRequest(opts: {
  scm: ScmProvider;
  owner: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  summaryBody: string;
  reviewEvent?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  findings: PublishableFinding[];
  /** Max findings to post (inline + conversation). Default STEW_COMMENT_CAP or 40. */
  commentCap?: number;
}): Promise<FindingPublishResult> {
  const cap = Math.max(
    1,
    opts.commentCap ?? Number(process.env.STEW_COMMENT_CAP ?? 40),
  );
  const capped = capComments(
    opts.findings as Array<PublishableFinding & { severity: Severity }>,
    cap,
  );

  let diffIndex = new Map<string, Set<number>>();
  try {
    const files = await opts.scm.getDiff(opts.owner, opts.repo, opts.prNumber);
    diffIndex = buildDiffLineIndex(files);
  } catch {
    diffIndex = new Map();
  }

  const inline: ReviewComment[] = [];
  const conversation: PublishableFinding[] = [];
  const skipped: PublishableFinding[] = [];

  for (const f of capped) {
    if (!f.path) {
      conversation.push(f);
      continue;
    }
    const valid = diffIndex.get(f.path);
    const line = pickLine(f, valid);
    if (line != null) {
      inline.push({
        path: f.path,
        line,
        side: "RIGHT",
        body: formatFindingPrCommentBody(f, { inline: true }),
      });
    } else {
      conversation.push(f);
    }
  }

  const result: FindingPublishResult = {
    inlineCount: 0,
    conversationCount: 0,
    skippedCount: 0,
    postedByFindingId: {},
    errors: [],
  };

  // 1) Summary review — try with all inlines; on 422, binary-search / drop inlines
  let reviewId: string | undefined;
  let reviewHtmlUrl: string | undefined;
  let acceptedInline = [...inline];

  const tryReview = async (comments: ReviewComment[]) => {
    return opts.scm.postReview(
      opts.owner,
      opts.repo,
      opts.prNumber,
      opts.summaryBody,
      comments,
      opts.reviewEvent ?? "COMMENT",
    );
  };

  try {
    const posted = await tryReview(acceptedInline);
    reviewId = posted.id;
    reviewHtmlUrl = posted.htmlUrl;
    result.inlineCount = acceptedInline.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fall back: summary only, then post inlines one-by-one if API supports it
    try {
      const posted = await tryReview([]);
      reviewId = posted.id;
      reviewHtmlUrl = posted.htmlUrl;
    } catch (err2) {
      result.errors.push(
        `summary review failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
      );
      // still try conversation comments below
    }

    // One-by-one review posts (each creates its own mini-review) for inlines that batch-failed
    if (msg.includes("422") || msg.toLowerCase().includes("line")) {
      let okInline = 0;
      for (const c of acceptedInline) {
        try {
          await opts.scm.postReview(
            opts.owner,
            opts.repo,
            opts.prNumber,
            "", // empty body — finding is the comment
            [c],
            "COMMENT",
          );
          okInline += 1;
        } catch {
          // demote to conversation
          const match = capped.find(
            (f) =>
              f.path === c.path &&
              formatFindingPrCommentBody(f, { inline: true }) === c.body,
          );
          if (match) conversation.push(match);
        }
      }
      result.inlineCount = okInline;
    } else {
      result.errors.push(`inline batch failed: ${msg.slice(0, 240)}`);
      // demote all to conversation
      for (const c of acceptedInline) {
        const match = capped.find((f) => f.path === c.path);
        if (match && !conversation.includes(match)) conversation.push(match);
      }
    }
  }

  result.reviewId = reviewId;
  result.reviewHtmlUrl = reviewHtmlUrl;

  // 2) Conversation comments for findings not placeable on the diff
  // Deduplicate by finding id/title+path
  const seen = new Set<string>();
  for (const f of conversation) {
    const key = f.id ?? `${f.path}:${f.startLine}:${f.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const posted = await opts.scm.postComment(
        opts.owner,
        opts.repo,
        opts.prNumber,
        formatFindingPrCommentBody(f, { inline: false }),
      );
      result.conversationCount += 1;
      if (f.id) result.postedByFindingId[f.id] = posted.id;
    } catch (err) {
      result.skippedCount += 1;
      result.errors.push(
        `conversation comment failed (${f.title.slice(0, 40)}): ${
          err instanceof Error ? err.message.slice(0, 120) : String(err)
        }`,
      );
      skipped.push(f);
    }
  }

  // 3) Map inline review comments → finding ids via body markers (for resolve on re-review)
  if (
    result.inlineCount > 0 &&
    typeof opts.scm.listPullReviewComments === "function"
  ) {
    try {
      const listed = await opts.scm.listPullReviewComments(
        opts.owner,
        opts.repo,
        opts.prNumber,
      );
      for (const f of capped) {
        if (!f.id || result.postedByFindingId[f.id]) continue;
        const hit = listed.find((c) => {
          if (f.id && c.body.includes(`<!-- finding:${f.id} -->`)) return true;
          if (
            f.fingerprint &&
            c.body.includes(`<!-- fingerprint:${f.fingerprint} -->`)
          ) {
            return true;
          }
          return false;
        });
        if (hit) result.postedByFindingId[f.id] = hit.id;
      }
    } catch (err) {
      result.errors.push(
        `list review comments for id map: ${
          err instanceof Error ? err.message.slice(0, 120) : String(err)
        }`,
      );
    }
  }

  void skipped;
  return result;
}

/**
 * After re-review auto-fix, resolve matching GitHub review threads (when possible).
 */
export async function resolveFixedFindingsOnScm(opts: {
  scm: ScmProvider;
  owner: string;
  repo: string;
  prNumber: number;
  findings: Array<{
    id: string;
    fingerprint?: string;
    scmCommentId?: string;
  }>;
}): Promise<{ resolved: number; failed: number; errors: string[] }> {
  const out = { resolved: 0, failed: 0, errors: [] as string[] };
  if (typeof opts.scm.resolveReviewThreadForComment !== "function") {
    return out;
  }
  for (const f of opts.findings) {
    try {
      const r = await opts.scm.resolveReviewThreadForComment!(
        opts.owner,
        opts.repo,
        opts.prNumber,
        {
          commentId: f.scmCommentId,
          fingerprint: f.fingerprint,
          findingId: f.id,
        },
      );
      if (r.resolved) out.resolved += 1;
      else out.failed += 1;
    } catch (err) {
      out.failed += 1;
      out.errors.push(
        `${f.id}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }
  return out;
}
