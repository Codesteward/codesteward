import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createId, nowIso } from "@codesteward/core";
import type { CreateSessionOpts, ExecResult, Sandbox, SandboxSession } from "./types.js";

export interface LocalSandboxOptions {
  /** Docker image for isolated runs; if unset, exec runs on host in a workdir copy. */
  image?: string;
  useDocker?: boolean;
}

/**
 * LocalSandbox — preferred demo/GA Prove path.
 * - With Docker: `docker run --rm` per exec (simple isolation) — fully working.
 * - Without Docker: host workdir under os.tmpdir() — fully working for Prove.
 * Supports upload/download via hostDir mirroring.
 */
export class LocalSandbox implements Sandbox {
  private sessions = new Map<string, SandboxSession & { hostDir: string }>();
  private readonly image: string;
  private readonly useDocker: boolean;

  constructor(opts: LocalSandboxOptions = {}) {
    this.image =
      opts.image ??
      process.env.STEW_SANDBOX_IMAGE ??
      "node:22-bookworm-slim";
    this.useDocker =
      opts.useDocker ?? process.env.STEW_SANDBOX_PROVIDER === "docker";
  }

  async createSession(opts: CreateSessionOpts): Promise<SandboxSession> {
    const id = createId("sbx");
    const hostDir = join(tmpdir(), "codesteward-sandbox", id);
    const repoDir = join(hostDir, "repo");
    // Always create repoDir — spawn(cwd) throws ENOENT if cwd is missing
    await mkdir(repoDir, { recursive: true });
    if (opts.repoPath) {
      try {
        await cp(opts.repoPath, repoDir, {
          recursive: true,
          filter: (src) => !src.includes("node_modules") && !src.includes(".git"),
        });
      } catch {
        // leave empty workdir
      }
    }
    const session: SandboxSession & { hostDir: string } = {
      id,
      provider: this.useDocker ? "docker" : "local",
      repoPath: opts.repoPath,
      workdir: this.useDocker ? "/workspace" : repoDir,
      sha: opts.sha,
      status: "ready",
      createdAt: nowIso(),
      metadata: { hostDir, image: this.image },
      hostDir,
    };
    this.sessions.set(id, session);
    return session;
  }

  async exec(
    sessionId: string,
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    s.status = "busy";
    const start = Date.now();
    try {
      if (this.useDocker) {
        return await this.dockerExec(s, command, opts);
      }
      return await runShell(command, {
        cwd: opts?.cwd ?? s.workdir,
        timeoutMs: opts?.timeoutMs ?? 120_000,
        env: opts?.env,
      });
    } finally {
      s.status = "ready";
      void start;
    }
  }

  private async dockerExec(
    s: SandboxSession & { hostDir: string },
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    // Explicit env only — never inherit host secrets (GITHUB_TOKEN, STEW_API_KEY, …)
    const envArgs: string[] = [];
    const allowEnv = opts?.env ?? {};
    for (const [k, v] of Object.entries(allowEnv)) {
      envArgs.push("-e", `${k}=${v}`);
    }
    const network =
      process.env.STEW_SANDBOX_NETWORK === "bridge"
        ? "bridge"
        : process.env.STEW_SANDBOX_NETWORK === "host"
          ? "host"
          : "none";
    const args = [
      "run",
      "--rm",
      "--network",
      network,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      process.env.STEW_SANDBOX_USER ?? "65534:65534",
      "-v",
      `${s.hostDir}:/workspace:rw`,
      "-w",
      opts?.cwd ?? "/workspace/repo",
      ...envArgs,
      this.image,
      "bash",
      "-lc",
      command,
    ];
    const dockerEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };
    if (process.env.HOME) dockerEnv.HOME = process.env.HOME;
    if (process.env.DOCKER_HOST) dockerEnv.DOCKER_HOST = process.env.DOCKER_HOST;
    return runCommand(
      "docker",
      args,
      opts?.timeoutMs ?? 180_000,
      undefined,
      dockerEnv,
      true,
    );
  }

  async upload(sessionId: string, localPath: string, remotePath: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const dest = remotePath.startsWith("/")
      ? join(s.hostDir, remotePath.replace(/^\//, ""))
      : join(s.hostDir, "repo", remotePath);
    await mkdir(dirnameSafe(dest), { recursive: true });
    await cp(localPath, dest, { recursive: true });
  }

  async download(sessionId: string, remotePath: string, localPath: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
    const src = remotePath.startsWith("/")
      ? join(s.hostDir, remotePath.replace(/^\//, ""))
      : join(s.hostDir, "repo", remotePath);
    await mkdir(dirnameSafe(localPath), { recursive: true });
    await cp(src, localPath, { recursive: true });
  }

  async destroy(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

function dirnameSafe(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}

function resolveShell(): { cmd: string; argsPrefix: string[] } {
  // Prefer absolute paths — slim images may lack `bash` on PATH for restricted envs.
  const absolute = [
    { cmd: "/bin/bash", argsPrefix: ["-lc"] },
    { cmd: "/usr/bin/bash", argsPrefix: ["-lc"] },
    { cmd: "/bin/sh", argsPrefix: ["-c"] },
  ];
  for (const c of absolute) {
    try {
      accessSync(c.cmd, constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return { cmd: "sh", argsPrefix: ["-c"] };
}

function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ExecResult> {
  // Host exec: only pass explicit env + PATH — never full process.env (SCM/model keys)
  const safeEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(opts.env ?? {}),
  };
  const shell = resolveShell();
  return runCommand(
    shell.cmd,
    [...shell.argsPrefix, command],
    opts.timeoutMs,
    opts.cwd,
    safeEnv,
    true,
  );
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
  env?: Record<string, string>,
  /** When true, use env as-is; else merge with process.env (legacy). Prefer true. */
  replaceEnv = false,
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: replaceEnv
          ? (env as NodeJS.ProcessEnv)
          : env
            ? ({ ...process.env, ...env } as NodeJS.ProcessEnv)
            : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        exitCode: 127,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr + "\n[timeout]",
        durationMs: Date.now() - start,
      });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    // Critical: without this, spawn ENOENT (missing binary or cwd) crashes the whole worker.
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        exitCode: 127,
        stdout,
        stderr:
          stderr +
          (stderr ? "\n" : "") +
          `[spawn error] ${err.message}` +
          (cwd ? ` (cwd=${cwd})` : ""),
        durationMs: Date.now() - start,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}
