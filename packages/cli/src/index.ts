#!/usr/bin/env node
import { Command } from "commander";
import { createGraphClient } from "@codesteward/graph-client";
import { loadEnvModelConfig, createModelRouter } from "@codesteward/model-router";
import { loadPolicyFromDir, DEFAULT_POLICY } from "@codesteward/policy";
import { createFindingsStore, findingsToSarifJson } from "@codesteward/findings";
import { createOrchestrator } from "@codesteward/agents";
import { createLearningStore } from "@codesteward/learning";
import { createScmProvider } from "@codesteward/scm";
import { createSandbox, dockerAvailable } from "@codesteward/sandbox";
import {
  jobId,
  nowIso,
  sessionId,
  type ReviewSession,
} from "@codesteward/core";
import { readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient } from "./api-client.js";

const program = new Command();
program
  .name("stew")
  .description("CodeSteward Review CLI — gate + stewardship")
  .version("0.1.0");

const api = () => new ApiClient(process.env.STEW_API_URL);

program
  .command("review")
  .description("Run a gate-mode review (local or via API)")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .option("-r, --repo-id <id>", "repo id", "local")
  .option("--pr <n>", "PR number", (v) => Number(v))
  .option("--remote", "enqueue via API instead of local run")
  .option("--tier <tier>", "risk tier", "full")
  .option("--depth <depth>", "review depth", "normal")
  .option("--full", "force full review (ignore last_reviewed_sha)")
  .option("--publish", "publish review to SCM when --pr set")
  .option("--scm <provider>", "SCM provider", process.env.SCM_PROVIDER ?? "github")
  .option("--owner <owner>", "SCM owner/org")
  .option("--repo <repo>", "SCM repo name")
  .action(async (opts) => {
    if (opts.pr == null || !Number.isFinite(opts.pr) || opts.pr < 1) {
      console.error(
        "Gate requires --pr <n>. Gate is PR-only. For a single-branch audit use: stew steward. To compare two branches, open a PR first.",
      );
      process.exitCode = 1;
      return;
    }
    if (opts.remote) {
      const res = await api().startGate({
        repoId: opts.repoId,
        repoPath: opts.path,
        prNumber: opts.pr,
        riskTier: opts.tier,
        depth: opts.depth,
        paths: await listSourceFiles(opts.path),
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    await runLocal("gate", opts);
  });

program
  .command("steward")
  .description("Run stewardship scan on a single branch tip / paths (not a PR)")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .option("-r, --repo-id <id>", "repo id", "local")
  .option("--remote", "enqueue via API")
  .option("--tier <tier>", "risk tier", "full")
  .option("--depth <depth>", "review depth", "normal")
  .option("--branch <ref>", "branch tip to audit (default: current HEAD / main)")
  .action(async (opts) => {
    if (opts.remote) {
      const res = await api().startSteward({
        repoId: opts.repoId,
        repoPath: opts.path,
        riskTier: opts.tier,
        depth: opts.depth,
        headBranch: opts.branch,
        baseBranch: opts.branch,
        paths: await listSourceFiles(opts.path),
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    await runLocal("stewardship", { ...opts, from: undefined, to: undefined });
  });

program
  .command("scan")
  .description("Alias for steward with lite tier (single branch tip, not a PR compare)")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .option("-r, --repo-id <id>", "repo id", "local")
  .option("--branch <ref>", "branch tip to audit")
  .action(async (opts) => {
    await runLocal("stewardship", { ...opts, tier: "lite", from: undefined, to: undefined });
  });

program
  .command("resume")
  .description("Resume a failed/cancelled session via API")
  .argument("<sessionId>", "session id to resume")
  .option("--full", "force full review")
  .action(async (sessionIdArg: string, opts) => {
    const res = await api().resumeSession(sessionIdArg, { fullReview: opts.full });
    console.log(JSON.stringify(res, null, 2));
  });

const findingsCmd = program.command("findings").description("Findings operations");
findingsCmd
  .command("list")
  .description("List findings from API")
  .option("-s, --session <id>", "session id")
  .action(async (opts) => {
    console.log(JSON.stringify(await api().findings(opts.session), null, 2));
  });

findingsCmd
  .command("export")
  .description("Export findings as SARIF 2.1.0")
  .option("-s, --session <id>", "session id (API)")
  .option("--sarif", "output SARIF (default)", true)
  .option("-o, --output <file>", "write to file instead of stdout")
  .option("-f, --file <path>", "local findings JSON file")
  .action(async (opts) => {
    let findings: unknown[] = [];
    if (opts.file) {
      const raw = await readFile(opts.file, "utf8");
      const parsed = JSON.parse(raw);
      findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
    } else if (opts.session) {
      const res = await api().findings(opts.session);
      findings = res.findings;
    } else {
      // default local store
      const store = createFindingsStore({
        filePath:
          process.env.FINDINGS_STORE_PATH ??
          `${process.env.STEW_DATA_DIR ?? ".steward-data"}/findings.json`,
      });
      // allow load
      await new Promise((r) => setTimeout(r, 50));
      findings = await store.list();
    }
    const sarif = findingsToSarifJson(findings as never);
    if (opts.output) {
      await writeFile(opts.output, sarif, "utf8");
      console.error(`Wrote SARIF to ${opts.output}`);
    } else {
      console.log(sarif);
    }
  });

program
  .command("export")
  .description("Export artifacts (SARIF)")
  .argument("[format]", "sarif", "sarif")
  .option("-s, --session <id>", "session id")
  .option("-o, --output <file>", "output file")
  .option("-f, --file <path>", "local findings JSON")
  .action(async (format: string, opts) => {
    if (format !== "sarif") {
      console.error(`Unknown format: ${format}. Supported: sarif`);
      process.exit(1);
    }
    // delegate
    const args = ["findings", "export", "--sarif"];
    if (opts.session) args.push("-s", opts.session);
    if (opts.output) args.push("-o", opts.output);
    if (opts.file) args.push("-f", opts.file);
    await program.parseAsync(["node", "stew", ...args], { from: "node" });
  });

const graphCmd = program.command("graph").description("Graph substrate commands");
graphCmd
  .command("status")
  .option("-r, --repo-id <id>", "repo id")
  .action(async (opts) => {
    const client = createGraphClient({ repoId: opts.repoId });
    console.log(JSON.stringify(await client.status({ repoId: opts.repoId }), null, 2));
  });
graphCmd
  .command("rebuild")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .option("-r, --repo-id <id>", "repo id", "local")
  .action(async (opts) => {
    const client = createGraphClient({ repoId: opts.repoId });
    console.log(
      JSON.stringify(
        await client.rebuild({ repoPath: opts.path, repoId: opts.repoId }),
        null,
        2,
      ),
    );
  });
graphCmd
  .command("query")
  .argument("<type>", "lexical|referential|semantic|dependency")
  .argument("[query]", "filter", "")
  .option("-r, --repo-id <id>", "repo id")
  .action(async (type, query, opts) => {
    const client = createGraphClient({ repoId: opts.repoId });
    console.log(
      JSON.stringify(await client.query(type, query, { repoId: opts.repoId }), null, 2),
    );
  });

const rulesCmd = program.command("rules").description("Policy rules");
rulesCmd
  .command("list")
  .description("List effective policy rules")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .action(async (opts) => {
    const policy = await loadPolicyFromDir(opts.path).catch(() => DEFAULT_POLICY);
    console.log(
      JSON.stringify(
        {
          severityFloor: policy.severityFloor,
          nitCap: policy.nitCap,
          pathRules: policy.pathRules.map((r) => ({
            id: r.id,
            pathScope: r.pathScope,
            title: r.title,
            sourcePath: r.sourcePath,
          })),
          skipGlobs: policy.skipGlobs,
        },
        null,
        2,
      ),
    );
  });

const sessionCmd = program.command("session").description("Review sessions");
sessionCmd
  .command("list")
  .description("List sessions from API")
  .action(async () => {
    console.log(JSON.stringify(await api().listSessions(), null, 2));
  });

const configCmd = program.command("config").description("Configuration");
configCmd
  .command("doctor")
  .description("Check environment configuration")
  .option("--full", "deep checks: graph, docker, scm tokens, data dirs")
  .action(async (opts) => {
    const cfg = loadEnvModelConfig();
    const checks: Array<{ name: string; ok: boolean; value: string; detail?: string }> = [
      { name: "MODEL_PROVIDER", ok: Boolean(cfg.provider), value: cfg.provider },
      { name: "MODEL_NAME", ok: Boolean(cfg.model), value: cfg.model },
      {
        name: "OPENAI_API_KEY",
        ok: Boolean(cfg.openaiApiKey),
        value: cfg.openaiApiKey ? "***" : "",
      },
      {
        name: "ANTHROPIC_API_KEY",
        ok: Boolean(cfg.anthropicApiKey),
        value: cfg.anthropicApiKey ? "***" : "",
      },
      {
        name: "SPACEXAI_API_KEY",
        ok: Boolean(cfg.xaiApiKey),
        value: cfg.xaiApiKey ? "***" : "",
      },
      {
        name: "GRAPH_MCP_URL",
        ok: true,
        value: process.env.GRAPH_MCP_URL ?? "http://localhost:3000/mcp",
      },
      { name: "GRAPH_MOCK", ok: true, value: process.env.GRAPH_MOCK ?? "0" },
      {
        name: "GITHUB_TOKEN",
        ok: Boolean(process.env.GITHUB_TOKEN),
        value: process.env.GITHUB_TOKEN ? "***" : "",
      },
    ];
    let apiOk = false;
    try {
      await api().health();
      apiOk = true;
    } catch {
      apiOk = false;
    }
    checks.push({
      name: "API",
      ok: apiOk,
      value: process.env.STEW_API_URL ?? "http://localhost:8081",
    });

    if (opts.full) {
      checks.push(
        {
          name: "GITLAB_TOKEN",
          ok: Boolean(process.env.GITLAB_TOKEN),
          value: process.env.GITLAB_TOKEN ? "***" : "",
        },
        {
          name: "BITBUCKET_TOKEN",
          ok: Boolean(process.env.BITBUCKET_TOKEN),
          value: process.env.BITBUCKET_TOKEN ? "***" : "",
        },
        {
          name: "AZURE_DEVOPS_TOKEN",
          ok: Boolean(process.env.AZURE_DEVOPS_TOKEN || process.env.AZDO_PAT),
          value: process.env.AZURE_DEVOPS_TOKEN || process.env.AZDO_PAT ? "***" : "",
        },
        {
          name: "GITEA_TOKEN",
          ok: Boolean(process.env.GITEA_TOKEN),
          value: process.env.GITEA_TOKEN ? "***" : "",
        },
        {
          name: "SCM_PROVIDER",
          ok: true,
          value: process.env.SCM_PROVIDER ?? "github",
        },
        {
          name: "STEW_DATA_DIR",
          ok: true,
          value: process.env.STEW_DATA_DIR ?? ".steward-data",
        },
        {
          name: "STEW_SANDBOX_PROVIDER",
          ok: true,
          value: process.env.STEW_SANDBOX_PROVIDER ?? "null",
        },
      );

      // Graph live status
      try {
        const graph = createGraphClient({ repoId: "local" });
        const st = await graph.status({ repoId: "local" });
        checks.push({
          name: "GRAPH_STATUS",
          ok: Boolean(st.backend_connected || process.env.GRAPH_MOCK === "1"),
          value: st.graph_backend ?? "unknown",
          detail: `last_build=${st.last_build ?? "null"} nodes=${st.nodes?.total ?? "?"}`,
        });
      } catch (err) {
        checks.push({
          name: "GRAPH_STATUS",
          ok: false,
          value: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      const dockerOk = await dockerAvailable().catch(() => false);
      checks.push({
        name: "DOCKER",
        ok: dockerOk,
        value: dockerOk ? "available" : "not available",
        detail: "Used for LocalSandbox prove isolation",
      });

      // Policy load
      try {
        const policy = await loadPolicyFromDir(process.cwd());
        checks.push({
          name: "POLICY",
          ok: true,
          value: policy.source,
          detail: `floor=${policy.severityFloor} nitCap=${policy.nitCap} rules=${policy.pathRules.length}`,
        });
      } catch (err) {
        checks.push({
          name: "POLICY",
          ok: false,
          value: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // Learning store
      try {
        const learning = createLearningStore();
        const mems = await learning.listMemories({ orgId: "local" });
        checks.push({
          name: "LEARNING_STORE",
          ok: true,
          value: process.env.LEARNING_STORE_PATH ?? ".steward-data/learning.json",
          detail: `memories=${mems.length}`,
        });
      } catch (err) {
        checks.push({
          name: "LEARNING_STORE",
          ok: false,
          value: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(JSON.stringify({ checks, full: Boolean(opts.full) }, null, 2));
    if (!cfg.openaiApiKey && !cfg.anthropicApiKey && !cfg.xaiApiKey) {
      console.error("Note: no LLM API keys set — model router will use mock responses.");
    }
    if (opts.full && checks.some((c) => !c.ok && c.name !== "GITLAB_TOKEN" && c.name !== "BITBUCKET_TOKEN" && c.name !== "AZURE_DEVOPS_TOKEN" && c.name !== "GITEA_TOKEN" && c.name !== "DOCKER")) {
      process.exitCode = 1;
    }
  });

// Alias: stew doctor full
program
  .command("doctor")
  .description("Alias for config doctor")
  .option("--full", "deep checks")
  .argument("[mode]", "optional 'full'")
  .action(async (mode: string | undefined, opts) => {
    const full = opts.full || mode === "full";
    await program.parseAsync(
      ["node", "stew", "config", "doctor", ...(full ? ["--full"] : [])],
      { from: "node" },
    );
  });

program
  .command("ask")
  .description("Ask a one-shot question via model router")
  .argument("<prompt...>")
  .option("--role <role>", "model role", "default")
  .action(async (promptParts: string[], opts) => {
    const router = createModelRouter();
    const model = router.createChatModel(opts.role);
    const res = await model.complete({
      messages: [{ role: "user", content: promptParts.join(" ") }],
    });
    console.log(res.content);
  });


async function runLocal(
  mode: "gate" | "stewardship",
  opts: {
    path: string;
    repoId: string;
    tier?: string;
    depth?: string;
    pr?: number;
    full?: boolean;
    publish?: boolean;
    scm?: string;
    owner?: string;
    repo?: string;
    /** Stewardship only — single tip to audit */
    branch?: string;
  },
) {
  const policy = await loadPolicyFromDir(opts.path).catch(() => DEFAULT_POLICY);
  const modelRouter = createModelRouter();
  const graph = createGraphClient({ repoId: opts.repoId });
  const findings = createFindingsStore({
    filePath:
      process.env.FINDINGS_STORE_PATH ??
      `${process.env.STEW_DATA_DIR ?? ".steward-data"}/findings.json`,
  });
  const learning = createLearningStore();
  const sandbox = createSandbox(process.env.STEW_SANDBOX_PROVIDER ?? "null");
  if (mode === "gate" && (opts.pr == null || opts.pr < 1)) {
    throw new Error(
      "Gate requires --pr. Gate is PR-only; use `stew steward` for a single-branch audit.",
    );
  }
  if (mode === "stewardship" && opts.pr != null) {
    throw new Error(
      "Stewardship does not accept a PR number. Open a PR and use `stew review --pr` (gate) to compare branches.",
    );
  }
  // Stewardship never uses git branch-range compare; gate uses PR patches via SCM when remote.
  const paths = await listSourceFiles(opts.path);
  const ts = nowIso();
  const depth = (opts.depth as ReviewSession["depth"]) ?? "normal";
  const riskTier = (opts.tier as ReviewSession["riskTier"]) ?? "full";
  const session: ReviewSession = {
    id: sessionId(),
    orgId: "local",
    tenantId: "local",
    repoId: opts.repoId,
    repoPath: opts.path,
    mode,
    trigger: "cli",
    prNumber: mode === "gate" ? opts.pr : undefined,
    headBranch: mode === "stewardship" ? opts.branch : undefined,
    baseBranch: mode === "stewardship" ? opts.branch : undefined,
    riskTier,
    depth,
    status: "pending",
    stage: "queued",
    units: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metadata: {},
    createdAt: ts,
    updatedAt: ts,
  };

  let scm;
  let scmJob;
  if (mode === "gate" && opts.publish && opts.pr && opts.owner && opts.repo) {
    scm = createScmProvider(opts.scm ?? "github");
    scmJob = {
      provider: (opts.scm ?? "github") as "github",
      owner: opts.owner,
      repo: opts.repo,
      prNumber: opts.pr,
      publish: true,
    };
  }

  const orch = createOrchestrator({
    modelRouter,
    graph,
    policy,
    findings,
    learning,
    sandbox,
    scm,
    onEvent: (e) => {
      if (e.type === "stage" || e.type === "log" || e.type === "completed") {
        console.error(`[${e.type}]`, "message" in e ? e.message : JSON.stringify(e));
      }
    },
  });
  const result = await orch.run(
    session,
    {
      id: jobId(),
      sessionId: session.id,
      mode,
      tenantId: "local",
      repoId: opts.repoId,
      repoPath: opts.path,
      riskTier,
      depth,
      paths,
      enqueuedAt: ts,
      attempts: 0,
      prNumber: opts.pr,
      crossRepo: true,
      fullReview: opts.full,
      scm: scmJob,
    },
    paths,
  );
  console.log(
    JSON.stringify(
      {
        sessionId: result.session.id,
        status: result.session.status,
        verdict: result.session.verdict,
        findingCount: result.findings.length,
        incremental: result.incremental,
        discourseNotes: result.discourseNotes,
        findings: result.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          path: f.path,
          title: f.title,
        })),
        dropped: result.dropped.length,
      },
      null,
      2,
    ),
  );
}

async function listSourceFiles(root: string, max = 80): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === ".git" ||
        e.name === "research"
      )
        continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(e.name)) {
        out.push(p.startsWith(root) ? p.slice(root.length).replace(/^\//, "") : p);
      }
    }
  }
  await walk(root);
  return out.length ? out : ["."];
}


const guard = program.command("guard").description("Git guardrails / attestation hooks");

guard
  .command("install")
  .description("Install a pre-commit hook that runs stew review --tier lite on staged changes")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .option("--force", "overwrite existing hook")
  .action(async (opts) => {
    const { mkdir, writeFile, readFile, chmod, access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const hookDir = join(opts.path, ".git", "hooks");
    const hookPath = join(hookDir, "pre-commit");
    // Use array join so bash ${...} is not parsed as JS template interpolation
    const script = [
      "#!/usr/bin/env bash",
      "# CodeSteward pre-commit guard (installed by: stew guard install)",
      "# Runs a lite-tier local review on staged paths. Set STEW_GUARD_SKIP=1 to bypass.",
      "set -euo pipefail",
      'if [[ "${STEW_GUARD_SKIP:-}" == "1" ]]; then',
      '  echo "[stew guard] skipped (STEW_GUARD_SKIP=1)"',
      "  exit 0",
      "fi",
      'ROOT="$(git rev-parse --show-toplevel)"',
      'cd "$ROOT"',
      'STAGED=$(git diff --cached --name-only --diff-filter=ACMR | head -80 || true)',
      'if [[ -z "$STAGED" ]]; then',
      "  exit 0",
      "fi",
      'echo "[stew guard] lite review of staged files..."',
      "if command -v stew >/dev/null 2>&1; then",
      '  stew review --tier lite -p "$ROOT" -r "$(basename "$ROOT")" || {',
      '    echo "[stew guard] review reported issues (non-blocking unless STEW_GUARD_STRICT=1)"',
      '    if [[ "${STEW_GUARD_STRICT:-}" == "1" ]]; then exit 1; fi',
      "  }",
      'elif command -v pnpm >/dev/null 2>&1 && [[ -f package.json ]]; then',
      '  pnpm stew -- review --tier lite -p "$ROOT" -r "$(basename "$ROOT")" || {',
      '    if [[ "${STEW_GUARD_STRICT:-}" == "1" ]]; then exit 1; fi',
      "  }",
      "else",
      '  echo "[stew guard] stew CLI not found — run: pnpm stew -- review --tier lite"',
      "fi",
      "exit 0",
      "",
    ].join("\n");
    try {
      await access(join(opts.path, ".git"));
    } catch {
      console.error("Not a git repository:", opts.path);
      process.exit(1);
    }
    await mkdir(hookDir, { recursive: true });
    try {
      const existing = await readFile(hookPath, "utf8");
      if (existing && !opts.force && !existing.includes("CodeSteward pre-commit guard")) {
        console.error(`pre-commit hook exists at ${hookPath}. Re-run with --force to overwrite.`);
        process.exit(1);
      }
    } catch {
      /* none */
    }
    await writeFile(hookPath, script, "utf8");
    await chmod(hookPath, 0o755);
    console.log(`Installed pre-commit guard at ${hookPath}`);
    console.log("Bypass: STEW_GUARD_SKIP=1. Strict fail: STEW_GUARD_STRICT=1.");
  });

guard
  .command("uninstall")
  .description("Remove CodeSteward pre-commit guard if present")
  .option("-p, --path <dir>", "repo path", process.cwd())
  .action(async (opts) => {
    const { readFile, unlink } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const hookPath = join(opts.path, ".git", "hooks", "pre-commit");
    try {
      const existing = await readFile(hookPath, "utf8");
      if (!existing.includes("CodeSteward pre-commit guard")) {
        console.log("No CodeSteward guard found");
        return;
      }
      await unlink(hookPath);
      console.log("Removed", hookPath);
    } catch {
      console.log("No pre-commit hook to remove");
    }
  });


program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
