#!/usr/bin/env node
/**
 * Functional GA acceptance against design §16 + SPA.
 * 1) Static: code/files/cli presence
 * 2) Runtime: API bootstrap, start stewardship, wait completion (inline worker)
 * Exit 0 only if static rate >= 0.98 AND runtime smoke passes.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(readFileSync(join(root, "evals/acceptance/ga-functional-matrix.json"), "utf8"));

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "research") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs|yml|yaml|sql|md|json)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const corpus = walk(join(root, "packages"))
  .concat(walk(join(root, "services")))
  .concat(walk(join(root, "actions")))
  .concat(walk(join(root, "skills")))
  .concat(walk(join(root, "deploy")));
const blob = corpus.map((f) => {
  try { return readFileSync(f, "utf8"); } catch { return ""; }
}).join("\n");

function hasCode(...needles) {
  return needles.every((n) => blob.toLowerCase().includes(String(n).toLowerCase()));
}
function hasFile(rel) {
  return existsSync(join(root, rel));
}
function hasUi(page) {
  return hasFile(`packages/ui/src/pages/${page}.tsx`);
}
function hasCli(...cmds) {
  const cli = join(root, "packages/cli/src/index.ts");
  if (!existsSync(cli)) return false;
  const t = readFileSync(cli, "utf8");
  return cmds.every((c) => t.includes(c));
}
function hasApi(...routes) {
  // search packages/api
  return routes.every((r) => {
    const m = r.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/);
    if (!m) return hasCode(r);
    const path = m[2];
    return hasCode(path) || hasCode(path.replace(/:\w+/g, ""));
  });
}

const results = [];
for (const item of matrix.items) {
  let ok = true;
  const reasons = [];
  if (item.code) {
    const hit = item.code.some((c) => hasCode(c));
    if (!hit) { ok = false; reasons.push("code missing: " + item.code.join("|")); }
  }
  if (item.files) {
    for (const f of item.files) {
      if (!hasFile(f)) { ok = false; reasons.push("file " + f); }
    }
  }
  if (item.ui) {
    for (const p of item.ui) {
      if (!hasUi(p)) { ok = false; reasons.push("ui " + p); }
    }
  }
  if (item.cli) {
    if (!hasCli(...item.cli)) { ok = false; reasons.push("cli " + item.cli.join(",")); }
  }
  if (item.api) {
    if (!hasApi(...item.api)) { ok = false; reasons.push("api " + item.api.join(",")); }
  }
  results.push({ id: item.id, name: item.name, ok, reasons });
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
const rate = passed / total;

console.log("\n=== GA Functional Matrix (static) ===\n");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.id} ${r.name}${r.ok ? "" : " — " + r.reasons.join("; ")}`);
}
console.log(`\nStatic: ${passed}/${total} (${(rate * 100).toFixed(1)}%)`);

// Runtime smoke
async function runtime() {
  const dataDir = `/tmp/stew-ga-accept-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    STEW_DATA_DIR: dataDir,
    GRAPH_MOCK: "1",
    STEW_USE_DEEPAGENTS: "0",
    STEW_INLINE_WORKER: "1",
    PORT: "18081",
    STEW_API_PORT: "18081",
  };
  const child = spawn("node", [join(root, "packages/api/dist/server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await new Promise((r) => setTimeout(r, 2500));

  const base = "http://127.0.0.1:18081";
  const checks = [];
  try {
    const status = await fetch(`${base}/v1/auth/status`).then((r) => r.json());
    checks.push({ id: "RT-auth-status", ok: status.bootstrapRequired === true || status.mode });

    const boot = await fetch(`${base}/v1/auth/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ga@test.com", password: "ga-test-password", displayName: "GA" }),
    }).then((r) => r.json());
    const token = boot.token;
    checks.push({ id: "RT-bootstrap", ok: Boolean(token) });

    const headers = {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const start = await fetch(`${base}/v1/reviews/stewardship`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoId: "codesteward",
        repoPath: root,
        paths: ["packages/core/src"],
        riskTier: "lite",
      }),
    }).then((r) => r.json());
    const sid = start.session?.id;
    checks.push({ id: "RT-start-steward", ok: Boolean(sid && start.job?.id) });

    let done = false;
    let last = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await fetch(`${base}/v1/sessions/${sid}`, { headers }).then((r) => r.json());
      last = `${s.session?.status}/${s.session?.stage}`;
      if (["completed", "completed_with_errors", "failed"].includes(s.session?.status)) {
        done = true;
        checks.push({
          id: "RT-session-complete",
          ok: s.session.status === "completed" || s.session.status === "completed_with_errors",
          detail: last,
        });
        break;
      }
    }
    if (!done) checks.push({ id: "RT-session-complete", ok: false, detail: "timeout " + last });

    // connector save
    const conn = await fetch(`${base}/v1/org/connectors/github`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, config: { token: "ghp_acceptancetest1234" } }),
    });
    checks.push({ id: "RT-connector-put", ok: conn.ok });

    const unauth = await fetch(`${base}/v1/sessions`);
    checks.push({ id: "RT-auth-required", ok: unauth.status === 401 });

  } catch (e) {
    checks.push({ id: "RT-error", ok: false, detail: String(e) });
  } finally {
    child.kill("SIGTERM");
  }

  console.log("\n=== GA Runtime Smoke ===\n");
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.id}${c.detail ? " — " + c.detail : ""}`);
  }
  return checks;
}

const runtimeChecks = await runtime();
const rtPass = runtimeChecks.filter((c) => c.ok).length;
const rtTotal = runtimeChecks.length;
const rtRate = rtTotal ? rtPass / rtTotal : 0;

const staticOk = rate >= 0.98;
const runtimeOk = rtRate >= 0.9 && runtimeChecks.some((c) => c.id === "RT-session-complete" && c.ok);
const overall = staticOk && runtimeOk;

const report = {
  ts: new Date().toISOString(),
  static: { passed, total, rate },
  runtime: { passed: rtPass, total: rtTotal, rate: rtRate, checks: runtimeChecks },
  overall: overall ? "PASS_GA_FUNCTIONAL" : "FAIL_GA_FUNCTIONAL",
  results,
};
mkdirSync(join(root, "evals/acceptance"), { recursive: true });
writeFileSync(join(root, "evals/acceptance/latest-report.json"), JSON.stringify(report, null, 2));

console.log(`\nRuntime: ${rtPass}/${rtTotal} (${(rtRate * 100).toFixed(1)}%)`);
console.log(`\nOVERALL: ${report.overall}\n`);
process.exit(overall ? 0 : 1);
