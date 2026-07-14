import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface MaterializeGitOpts {
  provider: string;
  owner: string;
  repo: string;
  workdir: string;
  token?: string;
  /** API base for enterprise hosts (e.g. https://github.example.com) */
  host?: string;
  headSha?: string;
  headBranch?: string;
  /** Wipe workdir if it exists */
  force?: boolean;
}

export interface MaterializeGitResult {
  ok: boolean;
  workdir: string;
  verified: boolean;
  verifiedSha?: string;
  error?: string;
  cloneUrlHost?: string;
}

/**
 * Shallow clone (or fetch into existing dir) of owner/repo at optional SHA/branch.
 * Never logs the token.
 */
export async function materializeGitWorkspace(
  opts: MaterializeGitOpts,
): Promise<MaterializeGitResult> {
  const cloneUrl = buildAuthenticatedCloneUrl(opts);
  if (!cloneUrl) {
    return {
      ok: false,
      workdir: opts.workdir,
      verified: false,
      error: `Unsupported provider for clone: ${opts.provider}`,
    };
  }

  try {
    if (opts.force) {
      await rm(opts.workdir, { recursive: true, force: true });
    }
    await mkdir(opts.workdir, { recursive: true });

    // If not a git repo yet, clone
    const isGit = await runGit(opts.workdir, ["rev-parse", "--git-dir"]);
    if (!isGit.ok) {
      // clone into parent then we need empty dir
      await rm(opts.workdir, { recursive: true, force: true });
      await mkdir(join(opts.workdir, ".."), { recursive: true });
      const parent = join(opts.workdir, "..");
      const name = opts.workdir.split(/[/\\]/).pop()!;
      const clone = await runGit(parent, [
        "clone",
        "--depth",
        "50",
        "--no-single-branch",
        cloneUrl.url,
        name,
      ]);
      if (!clone.ok) {
        await scrubRemote(opts.workdir, opts);
        return {
          ok: false,
          workdir: opts.workdir,
          verified: false,
          error: scrubGitError(clone.stderr).slice(0, 400),
          cloneUrlHost: cloneUrl.host,
        };
      }
    } else {
      // fetch updates
      await runGit(opts.workdir, ["remote", "set-url", "origin", cloneUrl.url]);
      await runGit(opts.workdir, ["fetch", "--depth", "50", "origin"]);
    }

    const ref = opts.headSha || opts.headBranch;
    if (ref) {
      const co = await runGit(opts.workdir, ["checkout", "--force", ref]);
      if (!co.ok && opts.headSha) {
        // try fetch that sha
        await runGit(opts.workdir, ["fetch", "--depth", "1", "origin", opts.headSha]);
        const co2 = await runGit(opts.workdir, ["checkout", "--force", opts.headSha]);
        if (!co2.ok) {
          await scrubRemote(opts.workdir, opts);
          return {
            ok: false,
            workdir: opts.workdir,
            verified: false,
            error: scrubGitError(co2.stderr).slice(0, 400),
            cloneUrlHost: cloneUrl.host,
          };
        }
      }
    }

    const head = await runGit(opts.workdir, ["rev-parse", "HEAD"]);
    const verifiedSha = head.ok ? head.stdout.trim() : undefined;
    // Only "verified" when an expected headSha was provided and matches
    const verified = Boolean(
      opts.headSha &&
        verifiedSha &&
        (verifiedSha === opts.headSha ||
          verifiedSha.startsWith(opts.headSha) ||
          opts.headSha.startsWith(verifiedSha)),
    );

    await scrubRemote(opts.workdir, opts);

    return {
      ok: true,
      workdir: opts.workdir,
      verified,
      verifiedSha,
      cloneUrlHost: cloneUrl.host,
    };
  } catch (err) {
    await scrubRemote(opts.workdir, opts).catch(() => undefined);
    return {
      ok: false,
      workdir: opts.workdir,
      verified: false,
      error: scrubGitError(err instanceof Error ? err.message : String(err)),
    };
  }
}

function scrubGitError(s: string): string {
  return s
    .replace(/https?:\/\/[^/\s]*:[^@/\s]+@/gi, "https://***@")
    .replace(/x-access-token:[^@\s]+/gi, "x-access-token:***")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/glpat-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_TOKEN]");
}

async function scrubRemote(
  workdir: string,
  opts: MaterializeGitOpts,
): Promise<void> {
  const publicUrl = buildPublicCloneUrl(opts);
  if (publicUrl) {
    await runGit(workdir, ["remote", "set-url", "origin", publicUrl]);
  }
}

export function buildAuthenticatedCloneUrl(opts: {
  provider: string;
  owner: string;
  repo: string;
  token?: string;
  host?: string;
}): { url: string; host: string } | null {
  const p = opts.provider.toLowerCase();
  const token = opts.token;
  if (p === "github" || p === "github_enterprise") {
    const host = (opts.host ?? "https://github.com")
      .replace(/\/api\/v3\/?$/, "")
      .replace(/\/$/, "");
    const ghHost = host.includes("github.com")
      ? "https://github.com"
      : host;
    if (!token) {
      return { url: `${ghHost}/${opts.owner}/${opts.repo}.git`, host: ghHost };
    }
    // x-access-token works for classic PAT and installation tokens
    const u = new URL(`${ghHost}/${opts.owner}/${opts.repo}.git`);
    u.username = "x-access-token";
    u.password = token;
    return { url: u.toString(), host: ghHost };
  }
  if (p === "gitlab") {
    const host = (opts.host ?? "https://gitlab.com").replace(/\/$/, "");
    if (!token) return { url: `${host}/${opts.owner}/${opts.repo}.git`, host };
    const u = new URL(`${host}/${opts.owner}/${opts.repo}.git`);
    u.username = "oauth2";
    u.password = token;
    return { url: u.toString(), host };
  }
  if (p === "gitea" || p === "forgejo") {
    const host = (opts.host ?? "").replace(/\/$/, "");
    if (!host) return null;
    if (!token) return { url: `${host}/${opts.owner}/${opts.repo}.git`, host };
    const u = new URL(`${host}/${opts.owner}/${opts.repo}.git`);
    u.username = "oauth2";
    u.password = token;
    return { url: u.toString(), host };
  }
  return null;
}

function buildPublicCloneUrl(opts: MaterializeGitOpts): string | null {
  const built = buildAuthenticatedCloneUrl({ ...opts, token: undefined });
  return built?.url ?? null;
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? " — git binary not found in PATH (install git in the worker/API image)"
          : "";
      resolve({ ok: false, stdout, stderr: msg + hint });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

/** Parse owner/repo from repoId or scm full name. */
export function parseOwnerRepo(
  repoId: string,
): { owner: string; repo: string } | null {
  const cleaned = repoId.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { owner: parts[0]!, repo: parts[1]! };
  }
  return null;
}
