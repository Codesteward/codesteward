import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createId } from "@codesteward/core";
import { DEFAULT_POLICY } from "./defaults.js";
import { parseStewardMd } from "./parse-steward.js";
import type { PathRule, Policy } from "./types.js";

/**
 * Load policy from a repository root.
 *
 * Production note: callers should pass a **base-branch** checkout path
 * (not PR head) so authors cannot relax gates via PR-branch STEWARD.md.
 *
 * Loads:
 * - STEWARD.md (or .codesteward/STEWARD.md)
 * - .codesteward/rules/**\/*.md path-scoped rules
 */
export async function loadPolicyFromDir(repoRoot: string): Promise<Policy> {
  let policy: Policy = { ...DEFAULT_POLICY, skipGlobs: [...DEFAULT_POLICY.skipGlobs] };

  const stewardPaths = [
    join(repoRoot, "STEWARD.md"),
    join(repoRoot, ".codesteward", "STEWARD.md"),
    join(repoRoot, ".steward", "STEWARD.md"),
  ];

  for (const p of stewardPaths) {
    try {
      const md = await readFile(p, "utf8");
      policy = parseStewardMd(md);
      break;
    } catch {
      // try next
    }
  }

  const rulesDir = join(repoRoot, ".codesteward", "rules");
  try {
    const st = await stat(rulesDir);
    if (st.isDirectory()) {
      const ruleFiles = await walkMd(rulesDir);
      const pathRules: PathRule[] = [];
      for (const file of ruleFiles) {
        const guidance = await readFile(file, "utf8");
        const rel = relative(repoRoot, file);
        const pathScope = derivePathScope(rel, guidance);
        pathRules.push({
          id: createId("rule"),
          pathScope,
          title: firstHeading(guidance) ?? relative(rulesDir, file),
          guidance,
          sourcePath: rel,
        });
      }
      policy = {
        ...policy,
        pathRules,
        source: policy.source === "default" ? "default" : "merged",
      };
    }
  } catch {
    // no rules dir
  }

  return policy;
}

function derivePathScope(relPath: string, body: string): string {
  const scopeLine = body.match(/(?:path|scope|glob)\s*:\s*`?([^\n`]+)`?/i);
  if (scopeLine) return scopeLine[1]!.trim();
  // infer from nested path: .codesteward/rules/packages/api/**.md → packages/api/**
  const stripped = relPath
    .replace(/^\.codesteward\/rules\//, "")
    .replace(/\.md$/, "");
  if (stripped.includes("/")) {
    const dir = stripped.split("/").slice(0, -1).join("/");
    return `${dir}/**`;
  }
  return "**/*";
}

function firstHeading(md: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(md);
  return m?.[1]?.trim();
}

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export function policyMatchesPath(policy: Policy, filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  for (const g of policy.skipGlobs) {
    if (simpleGlobMatch(g, norm)) return false;
  }
  if (!policy.includeGlobs.length) return true;
  return policy.includeGlobs.some((g) => simpleGlobMatch(g, norm));
}

/** Minimal glob: ** and * only. */
export function simpleGlobMatch(glob: string, path: string): boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${re}$`).test(path) || new RegExp(re).test(path);
}
