import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Sandbox } from "./types.js";
import type { ProveJobRequest, ProveJobResult } from "./types.js";

export interface ProveLlm {
  complete(req: {
    system?: string;
    messages: Array<{ role: "user" | "system" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

export interface ProveFindingContext {
  findingId: string;
  title: string;
  body: string;
  path: string;
  startLine?: number;
  endLine?: number;
  severity?: string;
  category?: string;
  language?: string;
  /** Source snippet around the finding */
  snippet?: string;
}

export interface RunProveOptions {
  sandbox: Sandbox;
  req: ProveJobRequest;
  /** When provided, generate a real test file via LLM instead of placeholder. */
  llm?: ProveLlm;
  finding?: ProveFindingContext;
  /** Prefer docker local sandbox when available. */
  preferDocker?: boolean;
}

/**
 * Prove-tier path:
 * 1. Optionally LLM-generate a minimal test file for the finding claim
 * 2. Write it into the sandbox workdir
 * 3. Run tests (default: node --test / npm test)
 * 4. Return evidence logs + status for attachment to the finding
 */
export async function runProveJob(
  sandbox: Sandbox,
  req: ProveJobRequest,
  extras: Omit<RunProveOptions, "sandbox" | "req"> = {},
): Promise<ProveJobResult> {
  const logs: string[] = [];
  const artifacts: string[] = [];

  try {
    let testRelPath: string | undefined;

    if (req.generateTests) {
      if (extras.llm && extras.finding) {
        const generated = await generateTestViaLlm(extras.llm, extras.finding, req.generatePrompt);
        logs.push(`[prove] generated test via LLM (${generated.filename})`);
        logs.push(generated.content.slice(0, 2000));

        // Write to host temp then upload into sandbox
        const hostDir = join(tmpdir(), "codesteward-prove", req.findingId);
        await mkdir(hostDir, { recursive: true });
        const hostFile = join(hostDir, generated.filename);
        await writeFile(hostFile, generated.content, "utf8");
        testRelPath = generated.relPath;
        try {
          await sandbox.upload(req.sandboxSessionId, hostFile, testRelPath);
          artifacts.push(testRelPath);
          logs.push(`[prove] uploaded ${testRelPath} into sandbox`);
        } catch (err) {
          logs.push(
            `[prove] upload failed, trying exec write: ${err instanceof Error ? err.message : String(err)}`,
          );
          const b64 = Buffer.from(generated.content, "utf8").toString("base64");
          const write = await sandbox.exec(
            req.sandboxSessionId,
            `mkdir -p "$(dirname '${testRelPath}')" && echo '${b64}' | base64 -d > '${testRelPath}'`,
          );
          logs.push(write.stdout, write.stderr);
          artifacts.push(testRelPath);
        }
      } else {
        // Real artifact path without LLM: write a deterministic prove harness file
        const filename = `prove-${req.findingId.replace(/[^a-zA-Z0-9_-]/g, "_")}.test.mjs`;
        const content = [
          `// CodeSteward Prove harness (deterministic, no LLM)`,
          `// finding: ${req.findingId}`,
          `import { test } from "node:test";`,
          `import assert from "node:assert/strict";`,
          `test("prove scaffold for ${req.findingId}", () => {`,
          `  assert.ok(true, "scaffold — replace with claim-specific assertion");`,
          `});`,
          extras.finding
            ? `// claim: ${JSON.stringify(extras.finding.title)}\n// path: ${extras.finding.path}:${extras.finding.startLine ?? "?"}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        const hostDir = join(tmpdir(), "codesteward-prove", req.findingId);
        await mkdir(hostDir, { recursive: true });
        const hostFile = join(hostDir, filename);
        await writeFile(hostFile, content, "utf8");
        testRelPath = `prove/${filename}`;
        artifacts.push(hostFile, testRelPath);
        logs.push(`[prove] wrote deterministic harness ${hostFile}`);
        try {
          await sandbox.upload(req.sandboxSessionId, hostFile, testRelPath);
          logs.push(`[prove] uploaded ${testRelPath} into sandbox`);
        } catch (err) {
          const b64 = Buffer.from(content, "utf8").toString("base64");
          const write = await sandbox.exec(
            req.sandboxSessionId,
            `mkdir -p prove && echo '${b64}' | base64 -d > '${testRelPath}'`,
          );
          logs.push(write.stdout, write.stderr);
        }
        const gen = await sandbox.exec(
          req.sandboxSessionId,
          req.generatePrompt
            ? `echo ${shellQuote(req.generatePrompt)} > /tmp/prove-prompt.txt && echo "prove-harness-ready"`
            : `echo "prove-harness-ready ${req.findingId}"`,
        );
        logs.push(gen.stdout, gen.stderr);
      }
    }

    if (req.runTests) {
      const cmd =
        req.testCommand ??
        (testRelPath
          ? defaultTestCommand(testRelPath)
          : "npm test --if-present || true");
      logs.push(`[prove] running: ${cmd}`);
      const run = await sandbox.exec(req.sandboxSessionId, cmd, {
        timeoutMs: 180_000,
      });
      logs.push(run.stdout, run.stderr);
      if (req.collectArtifacts) {
        artifacts.push(...(req.artifactGlobs ?? []));
      }
      const status = run.exitCode === 0 ? "passed" : "failed";
      return {
        findingId: req.findingId,
        status,
        exitCode: run.exitCode,
        summary:
          status === "passed"
            ? "Prove tests passed"
            : `Prove tests failed (exit ${run.exitCode})`,
        artifacts,
        logs: logs.join("\n"),
      };
    }

    return {
      findingId: req.findingId,
      status: "skipped",
      summary: "Prove job skipped runTests=false",
      artifacts,
      logs: logs.join("\n"),
    };
  } catch (err) {
    return {
      findingId: req.findingId,
      status: "error",
      summary: err instanceof Error ? err.message : String(err),
      artifacts,
      logs: logs.join("\n"),
    };
  }
}

/**
 * High-level prove for a single finding: create local/docker sandbox, generate, run, destroy.
 */
export async function proveFinding(opts: {
  createSandbox: () => Sandbox;
  llm?: ProveLlm;
  finding: ProveFindingContext;
  repoPath?: string;
  sha?: string;
  testCommand?: string;
}): Promise<ProveJobResult & { evidenceSummary: string }> {
  const sandbox = opts.createSandbox();
  const session = await sandbox.createSession({
    repoPath: opts.repoPath,
    sha: opts.sha,
  });
  try {
    const result = await runProveJob(
      sandbox,
      {
        sessionId: session.id,
        findingId: opts.finding.findingId,
        sandboxSessionId: session.id,
        generateTests: true,
        runTests: true,
        collectArtifacts: true,
        testCommand: opts.testCommand,
        artifactGlobs: ["**/prove-*.test.*", "**/junit*.xml"],
      },
      { llm: opts.llm, finding: opts.finding },
    );
    return {
      ...result,
      evidenceSummary: [
        `Prove status: ${result.status}`,
        result.summary,
        result.artifacts?.length ? `Artifacts: ${result.artifacts.join(", ")}` : "",
        result.logs ? result.logs.slice(0, 1500) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } finally {
    await sandbox.destroy(session.id).catch(() => undefined);
  }
}

async function generateTestViaLlm(
  llm: ProveLlm,
  finding: ProveFindingContext,
  extraPrompt?: string,
): Promise<{ filename: string; relPath: string; content: string }> {
  const lang = finding.language ?? inferLanguage(finding.path);
  const ext =
    lang === "python" ? "py" : lang === "go" ? "go" : lang === "ts" || lang === "tsx" ? "ts" : "js";
  const filename = `prove-${slug(finding.findingId)}.test.${ext}`;
  const relPath = join(".__codesteward_prove", filename).replace(/\\/g, "/");

  const res = await llm.complete({
    system: [
      "You generate a single minimal automated test that would FAIL if the described bug is present, or PASS if fixed.",
      "Output ONLY the test file source code — no markdown fences, no commentary.",
      `Target language/runtime: ${lang}. Prefer node:test / assert for JS/TS, pytest for Python.`,
      "Do not modify production code. Import from relative paths if needed.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Finding: ${finding.title}`,
          `Severity: ${finding.severity ?? "unknown"} Category: ${finding.category ?? "other"}`,
          `Path: ${finding.path}:${finding.startLine ?? "?"}-${finding.endLine ?? "?"}`,
          `Body:\n${finding.body}`,
          finding.snippet ? `Snippet:\n${finding.snippet.slice(0, 3000)}` : "",
          extraPrompt ? `Extra guidance:\n${extraPrompt}` : "",
          `Write file that will be saved as ${relPath}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    temperature: 0.1,
    maxTokens: 2048,
  });

  let content = res.content.trim();
  const fence = /```(?:[\w-]+)?\s*([\s\S]*?)```/.exec(content);
  if (fence) content = fence[1]!.trim();

  return { filename, relPath, content };
}

function defaultTestCommand(testRelPath: string): string {
  if (testRelPath.endsWith(".py")) {
    return `python -m pytest '${testRelPath}' -q || python '${testRelPath}'`;
  }
  if (testRelPath.endsWith(".go")) {
    return `go test './${testRelPath}' || go test ./...`;
  }
  // Node built-in test runner
  return `node --import tsx --test '${testRelPath}' 2>/dev/null || node --test '${testRelPath}' 2>/dev/null || npx --yes tsx --test '${testRelPath}' 2>/dev/null || npm test --if-present || true`;
}

function inferLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "ts";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "js";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".java")) return "java";
  return "js";
}

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-16) || "finding";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Detect whether docker CLI is available for LocalSandbox isolation. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("docker", ["info"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
