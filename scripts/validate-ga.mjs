#!/usr/bin/env node
/**
 * CodeSteward GA structural validator.
 * Checks that required feature paths exist and key symbols are present.
 * Exit 0 only if pass_rate >= minimum_pass_rate.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checklist = JSON.parse(
  readFileSync(join(root, "evals/ga-checklist.json"), "utf8"),
);

function pathExists(p) {
  const full = join(root, p);
  if (!existsSync(full)) return false;
  const st = statSync(full);
  if (st.isDirectory()) {
    try {
      return readdirSync(full).length > 0;
    } catch {
      return false;
    }
  }
  return st.size > 20;
}

function hasSymbol(paths, symbols) {
  for (const p of paths) {
    const full = join(root, p);
    if (!existsSync(full)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      for (const f of walk(full)) {
        const t = readFileSync(f, "utf8");
        if (symbols.every((s) => t.includes(s))) return true;
      }
    } else {
      const t = readFileSync(full, "utf8");
      if (symbols.every((s) => t.includes(s))) return true;
    }
  }
  return false;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules" && e.name !== "dist")
      out.push(...walk(p));
    else if (/\.(ts|tsx|js|yml|yaml|sql|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Extra semantic checks beyond path existence
const semantic = [
  {
    id: "SEM-selfheal",
    name: "Self-healing strategies",
    check: () =>
      hasSymbol(["packages/agents/src"], ["retry", "checkpoint"]) ||
      hasSymbol(["packages/agents/src/self-heal.ts"], ["heal", "retry", "backoff"]),
  },
  {
    id: "SEM-postgres",
    name: "Postgres migrations present",
    check: () => pathExists("packages/db/migrations") || pathExists("packages/db/src"),
  },
  {
    id: "SEM-completed_with_errors",
    name: "Degraded success status",
    check: () =>
      hasSymbol(["packages/core/src"], ["completed_with_errors"]) ||
      hasSymbol(["packages/agents/src"], ["completed_with_errors"]),
  },
  {
    id: "SEM-build",
    name: "dist builds exist for core packages",
    check: () =>
      pathExists("packages/core/dist") &&
      pathExists("packages/agents/dist") &&
      pathExists("packages/api/dist"),
  },
  {
    id: "SEM-ui-brand",
    name: "UI has branded CSS tokens",
    check: () => {
      const candidates = [
        join(root, "packages/ui/src/styles/global.css"),
        join(root, "packages/ui/dist/assets"),
      ];
      for (const c of candidates) {
        if (!existsSync(c)) continue;
        const st = statSync(c);
        if (st.isFile()) {
          const t = readFileSync(c, "utf8");
          if (t.includes("--accent") && (t.includes("22d3ee") || t.includes("teal") || t.includes("#22")))
            return true;
        } else {
          for (const f of walk(c).filter((x) => x.endsWith(".css"))) {
            const t = readFileSync(f, "utf8");
            if (t.includes("--accent") || t.includes("22d3ee") || t.includes("--teal")) return true;
          }
        }
      }
      // fallback walk
      const css = walk(join(root, "packages/ui")).filter((f) => f.endsWith(".css"));
      return css.some((f) => {
        const t = readFileSync(f, "utf8");
        return t.includes("--accent") || t.includes("22d3ee") || t.includes("--teal");
      });
    },
  },
];

const results = [];
for (const [cat, items] of Object.entries(checklist.categories)) {
  for (const item of items) {
    const ok = (item.paths || []).some((p) => pathExists(p));
    results.push({ id: item.id, name: item.name, category: cat, ok, reason: ok ? "path" : "missing path" });
  }
}
for (const s of semantic) {
  const ok = s.check();
  results.push({ id: s.id, name: s.name, category: "semantic", ok, reason: ok ? "pass" : "fail" });
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
const rate = passed / total;
const min = checklist.minimum_pass_rate ?? 0.92;

console.log("\n=== CodeSteward GA Structural Validator ===\n");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} [${r.category}] ${r.id} — ${r.name}${r.ok ? "" : " (" + r.reason + ")"}`);
}
console.log(`\nScore: ${passed}/${total} (${(rate * 100).toFixed(1)}%) — need ${(min * 100).toFixed(0)}%`);
console.log(rate >= min ? "\nRESULT: PASS\n" : "\nRESULT: FAIL — continue implementation\n");

const report = { passed, total, rate, min, results, ts: new Date().toISOString() };
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(join(root, "evals"), { recursive: true });
writeFileSync(join(root, "evals/ga-validation-report.json"), JSON.stringify(report, null, 2));

process.exit(rate >= min ? 0 : 1);
