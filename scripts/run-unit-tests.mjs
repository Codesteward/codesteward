#!/usr/bin/env node
/**
 * Run node:test suites under packages/ and services/ via tsx.
 * Used by CI — package-level "test" scripts are often stubs.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else if (e.endsWith(".test.ts") || e.endsWith(".test.mjs")) acc.push(p);
  }
  return acc;
}

const files = [...walk(join(root, "packages")), ...walk(join(root, "services"))].sort();
if (files.length === 0) {
  console.log("run-unit-tests: no *.test.ts files found");
  process.exit(0);
}

console.log(`run-unit-tests: ${files.length} file(s)`);
for (const f of files) console.log("  ·", relative(root, f));

// tsx is a workspace devDependency of @codesteward/api (not hoisted to root).
const r = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@codesteward/api", "exec", "tsx", "--test", ...files],
  { cwd: root, stdio: "inherit", env: process.env },
);
process.exit(r.status === null ? 1 : r.status);
