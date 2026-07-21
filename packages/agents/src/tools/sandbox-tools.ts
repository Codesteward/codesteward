import type { Sandbox } from "@codesteward/sandbox";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  normalizeReviewToolPath,
  rewriteShellCommandPaths,
  tenantIsolationMode,
} from "../path-jail.js";

export interface SandboxToolsOpts {
  /**
   * Host path of this unit's review workspace (primary clone or cross-repo clone).
   * Required for multi-tenant path jailing when the sandbox is local/in-place.
   */
  workspaceRoot?: string;
}

/**
 * Sandbox tools for DeepAgents / specialists.
 * Requires a ready SandboxSession (create once per review unit).
 *
 * Multi-tenant: all paths are normalized + jailed under workspaceRoot.
 * sandbox_exec is only a hard boundary on docker/k8s — use STEW_TENANT_ISOLATION=strict in prod.
 */
export function createSandboxTools(
  sandbox: Sandbox,
  sessionId: string,
  opts: SandboxToolsOpts = {},
) {
  const workspaceRoot = opts.workspaceRoot?.trim() || undefined;
  const mode = tenantIsolationMode();

  const jailRel = (raw: string | undefined, fallback = "."): string => {
    const p = (raw ?? fallback).trim() || fallback;
    if (!workspaceRoot || mode === "off") {
      // Still strip virtual leading /
      return p.replace(/^\/+/, "") || ".";
    }
    return normalizeReviewToolPath(p, workspaceRoot);
  };

  const sandbox_exec = tool(
    async ({ command, timeoutMs }) => {
      let execCmd = command;
      if (mode !== "off" && workspaceRoot) {
        const rewritten = rewriteShellCommandPaths(command, workspaceRoot);
        if (!rewritten.ok) {
          return JSON.stringify({
            exitCode: 1,
            stdout: "",
            stderr: rewritten.reason,
            durationMs: 0,
          });
        }
        execCmd = rewritten.command;
      } else if (mode !== "off" && /(?:^|[\s;'"`])\.\.(\/|\\)/.test(command)) {
        return JSON.stringify({
          exitCode: 1,
          stdout: "",
          stderr:
            "refused: relative parent paths (`..`) are not allowed in sandbox_exec under multi-tenant isolation",
          durationMs: 0,
        });
      }
      const r = await sandbox.exec(sessionId, execCmd, {
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
        "Run a shell command in this unit's workspace only (cwd = unit root). Use relative paths (e.g. ls ., cat src/foo.ts) — never host/session/cross prefixes.",
      schema: z.object({
        command: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
  );

  const sandbox_read = tool(
    async ({ path: rawPath }) => {
      let readPath: string;
      try {
        readPath = jailRel(rawPath, ".");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const r = await sandbox.exec(
        sessionId,
        `head -c 50000 ${JSON.stringify(readPath)}`,
      );
      if (!r.stdout && r.stderr) return r.stderr;
      if (!r.stdout) {
        return `empty or missing file: ${readPath} (unit workspace relative; use paths from Diff/context or ls /)`;
      }
      return r.stdout;
    },
    {
      name: "sandbox_read",
      description:
        "Read a file from this unit's workspace (first ~50KB). Paths are relative to the unit root (or virtual /src/foo.ts). Host paths like /workspace/…/cross/… are rewritten when they map into this unit; paths outside the unit are refused.",
      schema: z.object({ path: z.string() }),
    },
  );

  const sandbox_ls = tool(
    async ({ path: rawPath }) => {
      let listPath: string;
      try {
        listPath = jailRel(rawPath ?? ".", ".");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const r = await sandbox.exec(
        sessionId,
        `ls -la ${JSON.stringify(listPath)} 2>&1 | head -n 200`,
      );
      return r.stdout || r.stderr || `empty listing: ${listPath}`;
    },
    {
      name: "sandbox_ls",
      description:
        "List files in this unit's workspace. Use `.` or `/` for the unit root — not session/cross host paths.",
      schema: z.object({ path: z.string().optional() }),
    },
  );

  return [sandbox_exec, sandbox_read, sandbox_ls];
}
