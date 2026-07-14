import type { Sandbox } from "@codesteward/sandbox";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Sandbox tools for DeepAgents / specialists.
 * Requires a ready SandboxSession (create once per review unit).
 */
export function createSandboxTools(sandbox: Sandbox, sessionId: string) {
  const sandbox_exec = tool(
    async ({ command, timeoutMs }) => {
      const r = await sandbox.exec(sessionId, command, {
        timeoutMs: timeoutMs ?? 60_000,
      });
      return JSON.stringify({
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, 8000),
        stderr: r.stderr.slice(0, 4000),
        durationMs: r.durationMs,
      });
    },
    {
      name: "sandbox_exec",
      description:
        "Run a shell command in the isolated review sandbox (typecheck, tests, scripts). Network is restricted.",
      schema: z.object({
        command: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
  );

  const sandbox_read = tool(
    async ({ path }) => {
      // Local sandboxes store workdir; use cat via exec for portability
      const r = await sandbox.exec(sessionId, `head -c 50000 ${JSON.stringify(path)}`);
      return r.stdout || r.stderr;
    },
    {
      name: "sandbox_read",
      description: "Read a file from the sandbox workspace (truncated).",
      schema: z.object({ path: z.string() }),
    },
  );

  return [sandbox_exec, sandbox_read];
}
