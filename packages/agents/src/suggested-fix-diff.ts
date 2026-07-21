/**
 * Normalize specialist suggestedFix payloads into unified git-style diffs so
 * SCM/UI can always render ```diff (consistent GFM highlighting).
 */

/** Strip a single outer markdown fence if the model wrapped the fix. */
export function stripOuterCodeFence(code: string): string {
  let body = (code ?? "").trim();
  const wrapped = /^```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(body);
  if (wrapped) body = wrapped[1]!.trimEnd();
  return body;
}

/**
 * True when the text already looks like a unified / git diff (headers or @@ hunks
 * or only +/- body lines).
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  const t = stripOuterCodeFence(text);
  if (!t) return false;
  if (/^diff --git /m.test(t)) return true;
  if (/^--- [^\n]+\n\+\+\+ /m.test(t)) return true;
  if (/^@@\s+-\d/.test(t) || /^@@ /m.test(t)) return true;
  const lines = t.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  // Entire body is +/- (or space context) lines — treat as diff body
  const allDiffish = lines.every(
    (l) =>
      l.startsWith("+") ||
      l.startsWith("-") ||
      l.startsWith(" ") ||
      l.startsWith("\\"),
  );
  const hasPlusOrMinus = lines.some(
    (l) =>
      (l.startsWith("+") || l.startsWith("-")) &&
      !l.startsWith("+++") &&
      !l.startsWith("---"),
  );
  return allDiffish && hasPlusOrMinus;
}

function normalizePathForDiff(path: string): string {
  const p = (path ?? "file").replace(/\\/g, "/").replace(/^\.\//, "").trim() || "file";
  return p;
}

/**
 * Ensure a unified-diff body has ---/+++ headers for `path` when missing.
 * Leaves full `diff --git` patches alone.
 */
export function ensureDiffFileHeaders(diffBody: string, path: string): string {
  const body = stripOuterCodeFence(diffBody).replace(/\r\n/g, "\n");
  if (/^diff --git /m.test(body)) return body.trimEnd() + "\n";
  const rel = normalizePathForDiff(path);
  if (/^--- /m.test(body) && /^\+\+\+ /m.test(body)) {
    return body.trimEnd() + "\n";
  }
  // Hunk-only or +/- only: wrap with file headers
  let core = body.trim();
  if (!/^@@ /m.test(core)) {
    // Pure +/- lines without @@ — add a simple hunk header
    const lines = core.split("\n");
    const oldCount = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    const newCount = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const start = 1;
    core = `@@ -${start},${oldCount} +${start},${newCount} @@\n${core}`;
  }
  return `--- a/${rel}\n+++ b/${rel}\n${core.trimEnd()}\n`;
}

/**
 * Build a minimal unified diff that replaces existingCode with the fix snippet
 * (or pure addition when existingCode is absent).
 */
export function snippetToUnifiedDiff(opts: {
  path: string;
  suggestedFix: string;
  existingCode?: string;
  startLine?: number;
}): string {
  const rel = normalizePathForDiff(opts.path);
  const start = Math.max(1, opts.startLine ?? 1);
  const newRaw = stripOuterCodeFence(opts.suggestedFix).replace(/\r\n/g, "\n");
  const oldRaw = (opts.existingCode ?? "").replace(/\r\n/g, "\n").trimEnd();
  const newLines = newRaw === "" ? [] : newRaw.split("\n");
  const oldLines = oldRaw === "" ? [] : oldRaw.split("\n");

  const oldCount = oldLines.length;
  const newCount = newLines.length;
  // Pure addition when no old context: use 0-length old range at start-1 for git-ish form
  const oldStart = oldCount === 0 ? Math.max(0, start - 1) : start;
  const newStart = start;
  const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  const bodyLines = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ];
  return `--- a/${rel}\n+++ b/${rel}\n${hunkHeader}\n${bodyLines.join("\n")}\n`;
}

export type NormalizeSuggestedFixOpts = {
  path: string;
  suggestedFix: string;
  existingCode?: string;
  startLine?: number;
};

/**
 * Always return a unified git-style diff string for proposed fixes.
 * - If the model already emitted a diff → normalize headers / strip fences
 * - If it emitted a plain snippet → synthesize a minimal unified diff
 */
export function normalizeSuggestedFixAsDiff(
  opts: NormalizeSuggestedFixOpts,
): string {
  const raw = (opts.suggestedFix ?? "").trim();
  if (!raw) return "";
  const stripped = stripOuterCodeFence(raw);
  if (looksLikeUnifiedDiff(stripped)) {
    return ensureDiffFileHeaders(stripped, opts.path);
  }
  return snippetToUnifiedDiff({
    path: opts.path,
    suggestedFix: stripped,
    existingCode: opts.existingCode,
    startLine: opts.startLine,
  });
}
