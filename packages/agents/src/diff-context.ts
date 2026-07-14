import type { DiffFile } from "@codesteward/scm";

export interface DiffPackOptions {
  /** Approximate token budget for packed patch text (default 12_000). */
  tokenBudget?: number;
  /** Chars per token estimate (default 4). */
  charsPerToken?: number;
  /** Prefer files matching these path prefixes/substrings. */
  prioritize?: string[];
  /** Skip globs / path substrings. */
  skip?: string[];
  /** Max lines of patch per file before truncating (default 400). */
  maxLinesPerFile?: number;
  /** Include a short file list header (default true). */
  includeIndex?: boolean;
}

export interface PackedDiff {
  text: string;
  filesIncluded: string[];
  filesOmitted: string[];
  estimatedTokens: number;
  truncated: boolean;
}

/**
 * PR-Agent style diff packing: pack patches under a token budget,
 * prioritizing smaller / higher-signal files and path filters.
 */
export function packDiffContext(
  files: DiffFile[],
  opts: DiffPackOptions = {},
): PackedDiff {
  const tokenBudget = opts.tokenBudget ?? 12_000;
  const cpt = opts.charsPerToken ?? 4;
  const charBudget = tokenBudget * cpt;
  const maxLines = opts.maxLinesPerFile ?? 400;
  const skip = opts.skip ?? [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "go.sum",
    ".min.js",
    ".map",
    "node_modules/",
    "dist/",
  ];
  const prioritize = opts.prioritize ?? [];

  const usable = files.filter((f) => {
    if (!f.patch) return false;
    const p = f.path.toLowerCase();
    return !skip.some((s) => p.includes(s.toLowerCase()));
  });

  // Score: smaller patches + prioritized paths first; deleted files last
  const scored = usable
    .map((f) => {
      const patchLen = f.patch?.length ?? 0;
      const prio = prioritize.some((x) => f.path.includes(x)) ? 1000 : 0;
      const churn = f.additions + f.deletions;
      const statusPenalty = f.status === "removed" ? 50 : 0;
      // Prefer moderate churn over huge generated dumps
      const sizePenalty = Math.log10(Math.max(patchLen, 10));
      return {
        file: f,
        score: prio - sizePenalty - statusPenalty + Math.min(churn, 80) * 0.01,
      };
    })
    .sort((a, b) => b.score - a.score);

  const included: string[] = [];
  const omitted: string[] = [];
  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  if (opts.includeIndex !== false) {
    const index = [
      `# Diff pack (${files.length} files, budget ~${tokenBudget} tokens)`,
      ...files.map(
        (f) =>
          `- ${f.status} ${f.path} (+${f.additions}/-${f.deletions})${f.patch ? "" : " [no patch]"}`,
      ),
      "",
    ].join("\n");
    if (index.length < charBudget * 0.15) {
      parts.push(index);
      used += index.length;
    }
  }

  for (const { file } of scored) {
    let patch = file.patch ?? "";
    const lines = patch.split("\n");
    if (lines.length > maxLines) {
      patch =
        lines.slice(0, maxLines).join("\n") +
        `\n… truncated ${lines.length - maxLines} lines`;
      truncated = true;
    }
    const block = [
      `*** ${file.path} (${file.status}, +${file.additions}/-${file.deletions})`,
      patch,
      "",
    ].join("\n");

    if (used + block.length > charBudget) {
      // Try a short summary for this file instead of full omit
      const summary = `*** ${file.path} (${file.status}, +${file.additions}/-${file.deletions}) [omitted: over budget]\n`;
      if (used + summary.length <= charBudget) {
        parts.push(summary);
        used += summary.length;
      }
      omitted.push(file.path);
      truncated = true;
      continue;
    }
    parts.push(block);
    used += block.length;
    included.push(file.path);
  }

  // Files that had no patch
  for (const f of files) {
    if (!f.patch && !included.includes(f.path) && !omitted.includes(f.path)) {
      omitted.push(f.path);
    }
  }

  const text = parts.join("\n");
  return {
    text,
    filesIncluded: included,
    filesOmitted: omitted,
    estimatedTokens: Math.ceil(text.length / cpt),
    truncated,
  };
}

/**
 * Pack an arbitrary list of path→content excerpts under budget
 * (for stewardship / non-PR context).
 */
export function packFileExcerpts(
  excerpts: Array<{ path: string; content: string }>,
  opts: DiffPackOptions = {},
): PackedDiff {
  const asDiff: DiffFile[] = excerpts.map((e) => ({
    path: e.path,
    status: "modified",
    patch: e.content
      .split("\n")
      .map((l) => ` ${l}`)
      .join("\n"),
    additions: e.content.split("\n").length,
    deletions: 0,
  }));
  return packDiffContext(asDiff, opts);
}

/** Rough token estimate helper. */
export function estimateTokens(text: string, charsPerToken = 4): number {
  return Math.ceil(text.length / charsPerToken);
}
