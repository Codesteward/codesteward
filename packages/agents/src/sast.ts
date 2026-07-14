import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  evidenceId,
  type FindingCandidate,
} from "@codesteward/core";

export interface SastRunOptions {
  repoPath: string;
  paths?: string[];
  /** timeout per tool ms */
  timeoutMs?: number;
}

/**
 * Run optional SAST tools when binaries are on PATH:
 * - semgrep --json
 * - gitleaks detect --no-git -f json
 * Convert results to FindingCandidates (category security / secret).
 */
export async function runSastAdapters(
  opts: SastRunOptions,
): Promise<FindingCandidate[]> {
  const out: FindingCandidate[] = [];
  const timeout = opts.timeoutMs ?? 120_000;
  const cwd = opts.repoPath;

  if (await which("semgrep")) {
    try {
      const args = ["--json", "--quiet", "--error", "--disable-version-check"];
      if (opts.paths?.length) {
        for (const p of opts.paths.slice(0, 50)) args.push(p);
      } else {
        args.push(".");
      }
      const { stdout, exitCode } = await runCmd("semgrep", args, cwd, timeout);
      // semgrep exits 1 when findings exist
      if (stdout.trim()) {
        out.push(...parseSemgrep(stdout, cwd));
      }
      void exitCode;
    } catch (err) {
      console.warn(
        "[sast] semgrep failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (await which("gitleaks")) {
    try {
      const args = [
        "detect",
        "--no-git",
        "--source",
        cwd,
        "-f",
        "json",
        "--no-banner",
        "--exit-code",
        "0",
      ];
      const { stdout } = await runCmd("gitleaks", args, cwd, timeout);
      if (stdout.trim()) {
        out.push(...parseGitleaks(stdout, cwd));
      }
    } catch (err) {
      console.warn(
        "[sast] gitleaks failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return out;
}

function parseSemgrep(jsonText: string, repoPath: string): FindingCandidate[] {
  try {
    const data = JSON.parse(jsonText) as {
      results?: Array<{
        check_id?: string;
        path?: string;
        start?: { line?: number };
        end?: { line?: number };
        extra?: {
          message?: string;
          severity?: string;
          metadata?: Record<string, unknown>;
        };
      }>;
    };
    return (data.results ?? []).map((r) => {
      const path = normalizePath(r.path ?? "unknown", repoPath);
      const title = r.extra?.message?.slice(0, 200) ?? r.check_id ?? "semgrep finding";
      const severity = mapSemgrepSeverity(r.extra?.severity);
      const ruleId = r.check_id ?? "semgrep";
      const body = r.extra?.message ?? title;
      return {
        path,
        startLine: r.start?.line,
        endLine: r.end?.line,
        title: `[semgrep] ${title}`,
        body,
        category: "security" as const,
        severity,
        confidence: 0.85,
        agents: ["security" as const],
        ruleIds: [ruleId],
        evidence: [
          {
            id: evidenceId(),
            type: "sast" as const,
            summary: `semgrep ${ruleId}`,
            payload: { tool: "semgrep", check_id: r.check_id },
          },
        ],
        tags: ["sast", "semgrep"],
      };
    });
  } catch {
    return [];
  }
}

function parseGitleaks(jsonText: string, repoPath: string): FindingCandidate[] {
  try {
    const data = JSON.parse(jsonText) as
      | Array<{
          RuleID?: string;
          Description?: string;
          File?: string;
          StartLine?: number;
          EndLine?: number;
          Match?: string;
          Secret?: string;
        }>
      | { findings?: unknown[] };
    const rows = Array.isArray(data) ? data : [];
    return rows.map((r) => {
      const path = normalizePath(r.File ?? "unknown", repoPath);
      const ruleId = r.RuleID ?? "gitleaks";
      const title = r.Description ?? `Secret detected (${ruleId})`;
      const body = `gitleaks rule ${ruleId} matched in ${path}${r.StartLine ? `:${r.StartLine}` : ""}`;
      return {
        path,
        startLine: r.StartLine,
        endLine: r.EndLine,
        title: `[gitleaks] ${title}`,
        body,
        category: "security" as const,
        severity: "critical" as const,
        confidence: 0.9,
        agents: ["security" as const],
        ruleIds: [ruleId],
        evidence: [
          {
            id: evidenceId(),
            type: "sast" as const,
            summary: `gitleaks ${ruleId}`,
            payload: { tool: "gitleaks", rule: ruleId },
          },
        ],
        tags: ["sast", "gitleaks", "secret"],
      };
    });
  } catch {
    return [];
  }
}

function mapSemgrepSeverity(
  s?: string,
): "critical" | "high" | "medium" | "low" | "info" | "nit" {
  const v = (s ?? "WARNING").toUpperCase();
  if (v === "ERROR" || v === "CRITICAL") return "high";
  if (v === "WARNING" || v === "MEDIUM") return "medium";
  if (v === "INFO" || v === "LOW") return "low";
  return "medium";
}

function normalizePath(p: string, repoPath: string): string {
  if (p.startsWith(repoPath)) {
    return p.slice(repoPath.length).replace(/^\//, "");
  }
  return p.replace(/^\.\//, "");
}

async function which(bin: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + "\n[timeout]", exitCode: 124 });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
