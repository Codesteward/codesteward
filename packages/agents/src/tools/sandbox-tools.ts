import type { Sandbox } from "@codesteward/sandbox";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveInsideRoot, tenantIsolationMode } from "../path-jail.js";

export interface SandboxToolsOpts {
  /**
   * Host path of the review workspace (clone/mount). Required for multi-tenant
   * path jailing when the sandbox is local/in-place.
   */
  workspaceRoot?: string;
}

/**
 * Sandbox tools for DeepAgents / specialists.
 * Requires a ready SandboxSession (create once per review unit).
 *
 * Multi-tenant: sandbox_read resolves paths under workspaceRoot only.
 * sandbox_exec is only safe on docker/k8s (bind-mount jail). Local host shells
 * cannot prevent `cat ../other-session` — use STEW_TENANT_ISOLATION=strict.
 */
export function createSandboxTools(
  sandbox: Sandbox,
  sessionId: string,
  opts: SandboxToolsOpts = {},
) {
  const workspaceRoot = opts.workspaceRoot?.trim() || undefined;
  const mode = tenantIsolationMode();

  const sandbox_exec = tool(
    async ({ command, timeoutMs }) => {
      // Block obvious sibling escapes in the command string (best-effort, not a security boundary)
      if (mode !== "off" && /(?:^|[\s;'"`])\.\.(\/|\\)/.test(command)) {
        return JSON.stringify({
          exitCode: 1,
          stdout: "",
          stderr:
            "refused: relative parent paths (`..`) are not allowed in sandbox_exec under multi-tenant isolation",
          durationMs: 0,
        });
      }
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
        "Run a shell command in the isolated review sandbox (typecheck, tests, scripts). Stay inside the review workspace; network is restricted.",
      schema: z.object({
        command: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
  );

  const sandbox_read = tool(
    async ({ path }) => {
      let readPath = path;
      if (workspaceRoot && mode !== "off") {
        try {
          // Resolve on host for jail; docker sessions still receive the relative path
          const abs = resolveInsideRoot(workspaceRoot, path);
          // Prefer path relative to workspace for portable docker cwd
          readPath = abs.startsWith(workspaceRoot)
            ? abs.slice(workspaceRoot.length).replace(/^[/\\]+/, "") || "."
            : path;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }
      const r = await sandbox.exec(
        sessionId,
        `head -c 50000 ${JSON.stringify(readPath)}`,
      );
      return r.stdout || r.stderr;
    },
    {
      name: "sandbox_read",
      description:
        "Read a file from the sandbox workspace only (truncated). Absolute paths outside the review tree are refused.",
      schema: z.object({ path: z.string() }),
    },
  );

  return [sandbox_exec, sandbox_read];
}
