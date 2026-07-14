import { createId, nowIso } from "@codesteward/core";
import type { CreateSessionOpts, ExecResult, Sandbox, SandboxSession } from "./types.js";

/** No-op sandbox for CI/demo without Docker. */
export class NullSandbox implements Sandbox {
  private sessions = new Map<string, SandboxSession>();

  async createSession(opts: CreateSessionOpts): Promise<SandboxSession> {
    const s: SandboxSession = {
      id: createId("sbx"),
      provider: "null",
      repoPath: opts.repoPath,
      workdir: opts.workdir ?? opts.repoPath ?? "/tmp/null-sandbox",
      sha: opts.sha,
      status: "ready",
      createdAt: nowIso(),
      metadata: { note: "NullSandbox — exec is a no-op" },
    };
    this.sessions.set(s.id, s);
    return s;
  }

  async exec(sessionId: string, command: string): Promise<ExecResult> {
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown session ${sessionId}`);
    return {
      exitCode: 0,
      stdout: `[null-sandbox] skipped: ${command}`,
      stderr: "",
      durationMs: 0,
    };
  }

  async upload(): Promise<void> {
    /* no-op */
  }

  async download(): Promise<void> {
    /* no-op */
  }

  async destroy(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = "destroyed";
      this.sessions.delete(sessionId);
    }
  }
}
