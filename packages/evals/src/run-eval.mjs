#!/usr/bin/env node
/**
 * Offline precision/recall harness for CodeSteward findings quality.\n * Uses labeled regression fixtures (predicted vs expected) as CI quality gate.\n * Not a live-model eval — run live suites separately against held-out PRs.
 * Fixture-based until live model evals are wired.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath =
  process.argv[2] ?? join(__dirname, "../fixtures/sample-findings.json");
const data = JSON.parse(readFileSync(fixturePath, "utf8"));
const cases = data.cases ?? [];

let tp = 0,
  fp = 0,
  fn = 0,
  tn = 0,
  lineOk = 0,
  lineN = 0;

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
  gates: {
    minPrecision: 0.5,
    minRecall: 0.5,
    minLineAccuracy: 0.5,
  },
};

const pass =
  report.precision >= report.gates.minPrecision &&
  report.recall >= report.gates.minRecall &&
  report.lineAccuracy >= report.gates.minLineAccuracy;

console.log(JSON.stringify({ ...report, pass }, null, 2));
if (!pass) {
  console.error("EVAL FAILED quality gates");
  process.exit(1);
}
// Structural schema check for finding shape used by product
const structureOk = cases.every((c) =>
  c.expected && typeof c.expected.should_fire === "boolean" &&
  c.predicted && typeof c.predicted.fired === "boolean"
);
if (!structureOk) {
  console.error("EVAL FAILED structure");
  process.exit(1);
}
console.error("EVAL PASSED");
