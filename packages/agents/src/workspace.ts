import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  nowIso,
  type ContextReceipt,
  type ReviewJob,
  type CodeSource,
} from "@codesteward/core";
import {
  materializeGitWorkspace,
  parseOwnerRepo,
} from "@codesteward/scm";
import { spawn } from "node:child_process";

export interface PrepareWorkspaceOpts {
  job: ReviewJob;
  sessionId: string;
  orgId?: string;
  /** SCM credentials for clone (token never stored in audit) */
  cloneAuth?: {
    provider: string;
    token?: string;
    host?: string;
  } | null;
  /** Prefer patches-only without tree (gate) */
  preferScmDiff?: boolean;
}

export interface PrepareWorkspaceResult {
  job: ReviewJob;
  context: ContextReceipt;
}

/**
 * Bind a review job to a concrete code tree and return a context receipt.
 * Prefer session-scoped SCM clone when credentials + owner/repo are available.
 */
export async function prepareSessionWorkspace(
  opts: PrepareWorkspaceOpts,
): Promise<PrepareWorkspaceResult> {
  const { job, sessionId, orgId } = opts;
  const notes: string[] = [];
  const pathsRequested = job.paths?.length ? [...job.paths] : ["."];
  let source: CodeSource = "unverified_mount";
  let repoPath = job.repoPath ?? process.env.REPO_PATH;
  let workdir: string | undefined;
  let verified = false;
  let verifiedSha: string | undefined;

  const ownerRepo =
    parseOwnerRepo(job.scm?.owner && job.scm?.repo
      ? `${job.scm.owner}/${job.scm.repo}`
      : job.repoId) ??
    (job.scm ? { owner: job.scm.owner, repo: job.scm.repo } : null);

  // Clone when credentials exist. STEW_WORKSPACE_CLONE=0 forces mount-only (dev).
  // Default: attempt clone for owner/repo jobs so we never silently review REPO_PATH.
  const cloneForcedOff = process.env.STEW_WORKSPACE_CLONE === "0";
  const cloneEnabled =
    !cloneForcedOff &&
    (process.env.STEW_WORKSPACE_CLONE === "1" ||
      process.env.STEW_WORKSPACE_CLONE === "auto" ||
      // Auto-on when reviewing a named SCM repo (owner/repo) with auth available
      Boolean(ownerRepo && opts.cloneAuth?.token));
  const allowUnrelatedMount =
    process.env.STEW_ALLOW_UNRELATED_MOUNT === "1" ||
    process.env.STEW_ALLOW_UNRELATED_MOUNT === "true";
  const diffOnly =
    opts.preferScmDiff ||
    process.env.STEW_SCM_DIFF_ONLY === "1" ||
    (Boolean(job.patches?.length) && !job.repoPath && !cloneEnabled);

  if (diffOnly && job.patches?.length) {
    source = "scm_diff";
    notes.push("Using SCM diff patches only (no full tree checkout)");
    const files = job.patches.map((p) => p.path);
    return {
      job: { ...job, repoPath },
      context: {
        repoId: job.repoId,
        tenantId: job.tenantId,
        orgId,
        baseSha: job.baseSha,
        headSha: job.headSha,
        baseBranch: job.baseBranch,
        prNumber: job.prNumber,
        mode: job.mode,
        source,
        repoPath,
        verified: false,
        pathsRequested,
        pathsEffective: pathsRequested,
        filesIncluded: files.slice(0, 500),
        filesOmitted: [],
        notes,
        preparedAt: nowIso(),
      },
    };
  }

  // Attempt clone when owner/repo + auth (and clone not forced off)
  if (
    cloneEnabled &&
    ownerRepo &&
    opts.cloneAuth?.token &&
    (opts.cloneAuth.provider || job.scm?.provider || true)
  ) {
    const root =
      process.env.STEW_WORKSPACE_DIR ??
      join(process.env.STEW_DATA_DIR ?? ".steward-data", "workspaces");
    workdir = join(root, sessionId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const provider = opts.cloneAuth.provider || job.scm?.provider || "github";
    const mat = await materializeGitWorkspace({
      provider,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      workdir,
      token: opts.cloneAuth.token,
      host: opts.cloneAuth.host,
      headSha: job.headSha,
      // Prefer head SHA; branch name only as clone ref when SHA unknown
      headBranch: job.baseBranch,
      force: true,
    });
    if (mat.ok) {
      source = "clone";
      repoPath = mat.workdir;
      verified = mat.verified;
      verifiedSha = mat.verifiedSha;
      notes.push(
        `Cloned ${ownerRepo.owner}/${ownerRepo.repo}` +
          (mat.verifiedSha ? ` @ ${mat.verifiedSha.slice(0, 12)}` : "") +
          (verified ? " (SHA verified)" : " (SHA not verified — set headSha)"),
      );
    } else {
      notes.push(`SCM clone failed: ${mat.error ?? "unknown"}`);
    }
  } else if (cloneForcedOff) {
    notes.push("Workspace clone forced off (STEW_WORKSPACE_CLONE=0)");
  } else if (!opts.cloneAuth?.token && ownerRepo) {
    notes.push(
      "No SCM token for clone — cannot checkout target repo (configure GitHub App / connector)",
    );
  }

  // Mount / REPO_PATH fallback — only safe for local/dev when not targeting a remote owner/repo
  if (source !== "clone") {
    const remoteTarget = Boolean(ownerRepo);
    if (remoteTarget && !allowUnrelatedMount) {
      const why =
        notes.join("; ") ||
        "no clone performed";
      throw new Error(
        `Refusing to review ${ownerRepo!.owner}/${ownerRepo!.repo} against a local mount. ` +
          `That path is usually the platform monorepo (REPO_PATH), not the target repository — ` +
          `findings would be about the wrong codebase. ${why}. ` +
          `Fix: ensure SCM connector/GitHub App token is available so clone can run, ` +
          `or set STEW_ALLOW_UNRELATED_MOUNT=1 only for intentional local-path reviews.`,
      );
    }
    const explicit = job.repoPath || process.env.REPO_PATH;
    repoPath = explicit ?? process.cwd();
    if (job.repoPath || process.env.REPO_PATH) {
      source = "mount";
      notes.push(`Using mount path ${repoPath}`);
    } else {
      source = "unverified_mount";
      notes.push(`Using process.cwd() as repoPath (${repoPath}) — unverified`);
    }
    if (remoteTarget && allowUnrelatedMount) {
      notes.push(
        `WARNING: STEW_ALLOW_UNRELATED_MOUNT=1 — reviewing mount ${repoPath} for remote ${ownerRepo!.owner}/${ownerRepo!.repo}`,
      );
    }
    const head = await gitRevParse(repoPath);
    if (head) {
      verifiedSha = head;
      if (job.headSha && (head === job.headSha || head.startsWith(job.headSha) || job.headSha.startsWith(head))) {
        verified = true;
        notes.push(`Local HEAD matches headSha (${head.slice(0, 12)})`);
      } else if (job.headSha) {
        verified = false;
        notes.push(
          `Local HEAD ${head.slice(0, 12)} does not match job headSha ${job.headSha.slice(0, 12)}`,
        );
      } else {
        verified = true; // no expected sha — treat as intentional mount
      }
    } else {
      verified = false;
      notes.push("No .git at mount path — cannot verify SHA");
    }
  }

  return {
    job: { ...job, repoPath },
    context: {
      repoId: job.repoId,
      tenantId: job.tenantId,
      orgId,
      baseSha: job.baseSha,
      headSha: job.headSha,
      baseBranch: job.baseBranch,
      prNumber: job.prNumber,
      mode: job.mode,
      source,
      repoPath,
      workdir: source === "clone" ? workdir : undefined,
      verified,
      verifiedSha,
      pathsRequested,
      pathsEffective: pathsRequested,
      filesIncluded: [],
      filesOmitted: [],
      notes,
      preparedAt: nowIso(),
    },
  };
}

function gitRevParse(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() : null);
    });
  });
}
