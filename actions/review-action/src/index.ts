import * as core from "@actions/core";
import * as github from "@actions/github";
import { createOrchestrator } from "@codesteward/agents";
import { jobId, nowIso, sessionId, type ReviewSession } from "@codesteward/core";
import { createFindingsStore, findingsToSarifJson } from "@codesteward/findings";
import { createGraphClient } from "@codesteward/graph-client";
import { createLearningStore } from "@codesteward/learning";
import { createModelRouter } from "@codesteward/model-router";
import { DEFAULT_POLICY, loadPolicyFromDir } from "@codesteward/policy";
import { createSandbox } from "@codesteward/sandbox";
import { GitHubScm } from "@codesteward/scm";
import { writeFile } from "node:fs/promises";

async function main() {
  const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
  const repoPath = core.getInput("repo-path") || process.env.GITHUB_WORKSPACE || process.cwd();
  const riskTier = (core.getInput("risk-tier") || "full") as ReviewSession["riskTier"];
  const depth = (core.getInput("depth") || "normal") as ReviewSession["depth"];
  const publish = (core.getInput("publish") || "true") === "true";
  const fullReview = (core.getInput("full-review") || "false") === "true";
  const failOn = (core.getInput("fail-on") || "high").toLowerCase();
  const sarifOutput = core.getInput("sarif-output") || "codesteward.sarif";
  const graphMock = core.getInput("graph-mock") || "1";

  if (graphMock === "1") process.env.GRAPH_MOCK = "1";
  if (token) process.env.GITHUB_TOKEN = token;

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const repoId = core.getInput("repo-id") || repo;

  const prNumber =
    ctx.payload.pull_request?.number ??
    (ctx.payload as { number?: number }).number;

  if (!prNumber) {
    core.setFailed("This action must run on a pull_request event (no PR number).");
    return;
  }

  const scm = new GitHubScm({ token });
  const pr = await scm.getPullRequest(owner, repo, prNumber);
  const diff = await scm.getDiff(owner, repo, prNumber);
  const paths = diff.map((d) => d.path);

  core.info(
    `Reviewing PR #${prNumber} (${paths.length} files) tier=${riskTier} depth=${depth}`,
  );

  const policy = await loadPolicyFromDir(repoPath).catch(() => DEFAULT_POLICY);
  const modelRouter = createModelRouter();
  const graph = createGraphClient({ repoId });
  const findings = createFindingsStore({
    filePath: `${process.env.STEW_DATA_DIR ?? "/tmp/steward-data"}/findings.json`,
  });
  const learning = createLearningStore({
    filePath: `${process.env.STEW_DATA_DIR ?? "/tmp/steward-data"}/learning.json`,
  });
  const sandbox = createSandbox(process.env.STEW_SANDBOX_PROVIDER ?? "null");

  const ts = nowIso();
  const session: ReviewSession = {
    id: sessionId(),
    orgId: owner,
    tenantId: "github-actions",
    repoId,
    repoPath,
    mode: "gate",
    trigger: "action",
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    prNumber,
    scmProvider: "github",
    scmFullName: `${owner}/${repo}`,
    riskTier,
    depth,
    status: "pending",
    stage: "queued",
    units: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metadata: { action: true },
    createdAt: ts,
    updatedAt: ts,
  };

  const orch = createOrchestrator({
    modelRouter,
    graph,
    policy,
    findings,
    learning,
    sandbox,
    scm,
    onEvent: (e) => {
      if (e.type === "stage") core.info(`[stage] ${e.message ?? e.stage}`);
      if (e.type === "log") core.info(`[log] ${e.message}`);
    },
  });

  const result = await orch.run(
    session,
    {
      id: jobId(),
      sessionId: session.id,
      mode: "gate",
      tenantId: "github-actions",
      repoId,
      repoPath,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      baseBranch: pr.baseBranch,
      prNumber,
      riskTier,
      depth,
      paths,
      enqueuedAt: ts,
      attempts: 0,
      fullReview,
      crossRepo: false,
      patches: diff.map((d) => ({
        path: d.path,
        status: d.status,
        patch: d.patch,
        additions: d.additions,
        deletions: d.deletions,
        previousPath: d.previousPath,
      })),
      scm: publish
        ? {
            provider: "github",
            owner,
            repo,
            prNumber,
            publish: true,
          }
        : undefined,
    },
    paths,
  );

  core.setOutput("session-id", result.session.id);
  core.setOutput("finding-count", String(result.findings.length));
  core.setOutput("verdict", result.session.verdict ?? "unknown");

  if (sarifOutput) {
    const sarif = findingsToSarifJson(result.findings);
    await writeFile(sarifOutput, sarif, "utf8");
    core.setOutput("sarif-path", sarifOutput);
    core.info(`Wrote SARIF to ${sarifOutput}`);
  }

  core.info(
    `Done: findings=${result.findings.length} verdict=${result.session.verdict} dropped=${result.dropped.length}`,
  );

  const rank: Record<string, number> = {
    critical: 100,
    high: 80,
    medium: 60,
    low: 40,
    info: 20,
    nit: 10,
    none: 999,
  };
  const threshold = rank[failOn] ?? rank.high!;
  if (failOn !== "none") {
    const hit = result.findings.some((f) => (rank[f.severity] ?? 0) >= threshold);
    if (hit) {
      core.setFailed(
        `Findings at or above severity "${failOn}" detected (${result.findings.length} total).`,
      );
    }
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
