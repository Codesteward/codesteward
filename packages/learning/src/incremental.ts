import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LearningStore } from "./store.js";

const execFileAsync = promisify(execFile);

/**
 * Compute paths changed since last_reviewed_sha for incremental re-review.
 * Falls back to all provided paths when no prior SHA or git fails.
 */
export async function resolveIncrementalPaths(opts: {
  learning: LearningStore;
  repoId: string;
  orgId?: string;
  repoPath?: string;
  headSha?: string;
  /** Full candidate path list (e.g. from SCM PR files). */
  allPaths: string[];
  /** Force full review. */
  full?: boolean;
}): Promise<{
  paths: string[];
  incremental: boolean;
  lastReviewedSha?: string;
  baseForDiff?: string;
}> {
  if (opts.full || !opts.repoPath) {
    return { paths: opts.allPaths, incremental: false };
  }

  const state = await opts.learning.getRepoState(opts.repoId, {
    orgId: opts.orgId ?? "local",
  });
  const last = state?.lastReviewedSha;
  if (!last) {
    return { paths: opts.allPaths, incremental: false };
  }

  // If head equals last, nothing new
  if (opts.headSha && opts.headSha === last) {
    return { paths: [], incremental: true, lastReviewedSha: last, baseForDiff: last };
  }

  try {
    const range = opts.headSha ? `${last}...${opts.headSha}` : `${last}...HEAD`;
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", range],
      { cwd: opts.repoPath, maxBuffer: 10 * 1024 * 1024 },
    );
    const changed = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!changed.length) {
      return { paths: [], incremental: true, lastReviewedSha: last, baseForDiff: last };
    }

    // Intersect with known PR paths when provided; otherwise use git list
    const set = new Set(opts.allPaths);
    const paths =
      opts.allPaths.length && opts.allPaths[0] !== "."
        ? changed.filter((p) => set.has(p) || [...set].some((a) => a.endsWith(p) || p.endsWith(a)))
        : changed;

    return {
      paths: paths.length ? paths : changed,
      incremental: true,
      lastReviewedSha: last,
      baseForDiff: last,
    };
  } catch {
    return { paths: opts.allPaths, incremental: false, lastReviewedSha: last };
  }
}

export async function markReviewed(
  learning: LearningStore,
  opts: {
    repoId: string;
    orgId?: string;
    headSha?: string;
    sessionId?: string;
    prNumber?: number;
  },
): Promise<void> {
  if (!opts.headSha) return;
  await learning.setRepoState({
    repoId: opts.repoId,
    orgId: opts.orgId ?? "local",
    lastReviewedSha: opts.headSha,
    lastSessionId: opts.sessionId,
    lastPrNumber: opts.prNumber,
  });
}
