#!/usr/bin/env node
/**
 * Offline precision/recall harness for CodeSteward findings quality.
 *
 * Modes:
 *  1) Fixture file (default): packages/evals/fixtures/sample-findings.json
 *  2) Outcome export: JSON from GET /v1/analytics/outcomes/eval-export
 *     { cases: OutcomeEvalCase[] }
 *
 * Not a live-model eval — production labels come from reactions + merge outcomes.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const writeOut = args.includes("--write-summary")
  ? args[args.indexOf("--write-summary") + 1]
  : null;
const fixturePath =
  args.find((a) => !a.startsWith("-") && a !== writeOut) ??
  join(__dirname, "../fixtures/sample-findings.json");

const data = JSON.parse(readFileSync(fixturePath, "utf8"));
const cases = data.cases ?? [];

let tp = 0,
  fp = 0,
  fn = 0,
  tn = 0,
  lineOk = 0,
  lineN = 0;

const bySource = {};

for (const c of cases) {
  const should = Boolean(c.expected?.should_fire);
  const fired = Boolean(c.predicted?.fired);
  if (should && fired) tp++;
  else if (!should && fired) fp++;
  else if (should && !fired) fn++;
  else tn++;
  if (fired) {
    lineN++;
    if (c.predicted?.line_correct) lineOk++;
  }
  const src = c.source ?? "fixture";
  bySource[src] = bySource[src] ?? { tp: 0, fp: 0, fn: 0, tn: 0 };
  if (should && fired) bySource[src].tp++;
  else if (!should && fired) bySource[src].fp++;
  else if (should && !fired) bySource[src].fn++;
  else bySource[src].tn++;
}

const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
const lineAccuracy = lineN === 0 ? 1 : lineOk / lineN;

const report = {
  fixture: fixturePath,
  n: cases.length,
  tp,
  fp,
  fn,
  tn,
  precision: Math.round(precision * 1000) / 1000,
  recall: Math.round(recall * 1000) / 1000,
  f1: Math.round(f1 * 1000) / 1000,
  lineAccuracy: Math.round(lineAccuracy * 1000) / 1000,
  bySource,
  gates: {
    minPrecision: 0.5,
    minRecall: 0.5,
    minLineAccuracy: 0.5,
  },
  note:
    "When cases come from production outcomes (eval-export), treat metrics as indirect quality proxies — not live model precision marketing.",
};

const pass =
  report.precision >= report.gates.minPrecision &&
  report.recall >= report.gates.minRecall &&
  report.lineAccuracy >= report.gates.minLineAccuracy;

const out = { ...report, pass };
console.log(JSON.stringify(out, null, 2));

if (writeOut) {
  mkdirSync(dirname(writeOut), { recursive: true });
  writeFileSync(writeOut, JSON.stringify(out, null, 2));
}

if (!pass) {
  console.error("EVAL FAILED quality gates");
  process.exit(1);
}
const structureOk = cases.every(
  (c) =>
    c.expected &&
    typeof c.expected.should_fire === "boolean" &&
    c.predicted &&
    typeof c.predicted.fired === "boolean",
);
if (!structureOk) {
  console.error("EVAL FAILED structure");
  process.exit(1);
}
console.error("EVAL PASSED");
