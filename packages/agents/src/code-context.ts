import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, resolve } from "node:path";
import { isPathInsideRoot, resolveInsideRoot } from "./path-jail.js";

const DEFAULT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".scala",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".graphql",
  ".yml",
  ".yaml",
  ".toml",
  ".json",
  ".md",
]);

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "target",
  "__pycache__",
  ".steward-data",
  "research", // huge vendored trees in this monorepo
]);

export interface PackRepoContextResult {
  text: string;
  filesIncluded: string[];
  filesOmitted: string[];
  estimatedTokens: number;
  truncated: boolean;
}

/**
 * Pack source files from a local tree for specialist LLM context.
 * Used when stewardship/gate has paths but no PR patches.
 */
export async function packRepoContext(opts: {
  repoPath: string;
  paths?: string[];
  /** ~4 chars per token heuristic */
  tokenBudget?: number;
  maxFiles?: number;
  maxFileBytes?: number;
}): Promise<PackRepoContextResult> {
  const tokenBudget = opts.tokenBudget ?? Number(process.env.STEW_CODE_TOKEN_BUDGET ?? 14000);
  const maxFiles = opts.maxFiles ?? 40;
  const maxFileBytes = opts.maxFileBytes ?? 24_000;
  const charBudget = tokenBudget * 4;

  const repoRoot = resolve(opts.repoPath);
  const roots = opts.paths?.length ? opts.paths : ["."];
  const files: string[] = [];
  for (const p of roots) {
    let abs: string;
    try {
      abs =
        p === "." || p === ""
          ? repoRoot
          : resolveInsideRoot(repoRoot, p);
    } catch {
      /* path escape — skip */
      continue;
    }
    try {
      const st = await stat(abs);
      if (st.isFile()) {
        files.push(relative(repoRoot, abs) || p);
      } else if (st.isDirectory()) {
        await walk(abs, repoRoot, files, maxFiles * 3);
      }
    } catch {
      /* skip missing */
    }
  }

  // Prefer source over pure docs when budget tight
  files.sort((a, b) => scorePath(a) - scorePath(b));

  const included: string[] = [];
  const omitted: string[] = [];
  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const rel of files) {
    if (included.length >= maxFiles) {
      omitted.push(rel);
      truncated = true;
      continue;
    }
    let abs: string;
    try {
      abs = resolveInsideRoot(repoRoot, rel);
    } catch {
      omitted.push(rel);
      continue;
    }
    if (!isPathInsideRoot(repoRoot, abs)) {
      omitted.push(rel);
      continue;
    }
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > maxFileBytes * 2) {
        omitted.push(rel);
        continue;
      }
      let body = await readFile(abs, "utf8");
      if (body.length > maxFileBytes) {
        body = body.slice(0, maxFileBytes) + "\n/* … truncated … */\n";
      }
      const chunk = `### FILE: ${rel}\n\`\`\`\n${body}\n\`\`\`\n`;
      if (used + chunk.length > charBudget) {
        omitted.push(rel);
        truncated = true;
        // still try smaller files later
        continue;
      }
      parts.push(chunk);
      included.push(rel);
      used += chunk.length;
    } catch {
      omitted.push(rel);
    }
  }

  const header = [
    `Repository path: ${opts.repoPath}`,
    `Files in context: ${included.length}${truncated ? " (truncated by budget)" : ""}`,
    `Paths requested: ${roots.join(", ")}`,
    "",
    "Review the following source files for bugs, security issues, and missing tests.",
    "Cite FILE paths and line numbers in findings.",
    "",
  ].join("\n");

  const text = header + parts.join("\n");
  return {
    text,
    filesIncluded: included,
    filesOmitted: omitted.slice(0, 200),
    estimatedTokens: Math.ceil(text.length / 4),
    truncated,
  };
}

async function walk(
  dir: string,
  root: string,
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= limit) return;
    if (ent.name.startsWith(".") && ent.name !== ".github") continue;
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      await walk(join(dir, ent.name), root, out, limit);
    } else if (ent.isFile()) {
      const ext = extname(ent.name).toLowerCase();
      if (!DEFAULT_EXTS.has(ext) && !ent.name.endsWith("Dockerfile")) continue;
      out.push(relative(root, join(dir, ent.name)));
    }
  }
}

function scorePath(p: string): number {
  // lower = earlier
  if (p.includes("src/") || p.includes("packages/")) return 0;
  if (/\.(ts|tsx|js|py|go|rs)$/.test(p)) return 1;
  if (p.endsWith(".md")) return 5;
  return 3;
}
