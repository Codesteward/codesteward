import { z } from "zod";

export const SandboxSessionSchema = z.object({
  id: z.string(),
  provider: z.enum(["local", "k8s", "null", "e2b", "docker"]),
  repoPath: z.string().optional(),
  workdir: z.string(),
  sha: z.string().optional(),
  status: z.enum(["creating", "ready", "busy", "destroyed", "error"]),
  createdAt: z.string(),
  metadata: z.record(z.unknown()).default({}),
});
export type SandboxSession = z.infer<typeof SandboxSessionSchema>;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CreateSessionOpts {
  repoPath?: string;
  sha?: string;
  image?: string;
  env?: Record<string, string>;
  workdir?: string;
  network?: "none" | "default" | "mirrors-only";
  labels?: Record<string, string>;
}

export interface Sandbox {
  createSession(opts: CreateSessionOpts): Promise<SandboxSession>;
  exec(
    sessionId: string,
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult>;
  upload(sessionId: string, localPath: string, remotePath: string): Promise<void>;
  download(sessionId: string, remotePath: string, localPath: string): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}

/** Prove-tier job: generate tests, run them, collect artifacts. */
export const ProveJobRequestSchema = z.object({
  sessionId: z.string(),
  findingId: z.string(),
  sandboxSessionId: z.string(),
  generateTests: z.boolean().default(true),
  runTests: z.boolean().default(true),
  collectArtifacts: z.boolean().default(true),
  testCommand: z.string().optional(),
  generatePrompt: z.string().optional(),
  artifactGlobs: z.array(z.string()).default(["**/junit*.xml", "**/coverage/**", "**/prove-*.log"]),
});
export type ProveJobRequest = z.infer<typeof ProveJobRequestSchema>;

export const ProveJobResultSchema = z.object({
  findingId: z.string(),
  status: z.enum(["passed", "failed", "error", "skipped"]),
  exitCode: z.number().optional(),
  summary: z.string(),
  artifacts: z.array(z.string()).default([]),
  logs: z.string().optional(),
});
export type ProveJobResult = z.infer<typeof ProveJobResultSchema>;
