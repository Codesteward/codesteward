import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextHealStrategy,
  HEAL_STRATEGY_ORDER,
  computeBackoffMs,
  resolveSelfHealConfig,
  isSessionResumable,
  splitReviewUnit,
  coverageGapFinding,
} from "../self-heal.js";
import type { ReviewUnit } from "@codesteward/core";

const sampleUnit = {
  id: "u1",
  sessionId: "s1",
  kind: "file_batch",
  label: "multi",
  paths: ["a.ts", "b.ts", "c.ts"],
  symbols: [],
  status: "pending",
  assignedRoles: ["security"],
  metadata: {},
} as ReviewUnit;

test("heal strategy ladder is ordered", () => {
  assert.ok(HEAL_STRATEGY_ORDER.length >= 3);
  assert.equal(HEAL_STRATEGY_ORDER[0], "retry_fresh_context");
  assert.ok(HEAL_STRATEGY_ORDER.includes("skip_with_gap_note"));
});

test("nextHealStrategy advances", () => {
  const a = nextHealStrategy([], sampleUnit);
  assert.equal(a, "retry_fresh_context");
  const b = nextHealStrategy([a!], sampleUnit);
  assert.equal(b, "fallback_simple_runner");
  assert.notEqual(a, b);
});

test("computeBackoffMs respects cap and base", () => {
  const cfg = resolveSelfHealConfig({
    baseBackoffMs: 100,
    maxBackoffMs: 250,
    noSleep: true,
  });
  const ms = computeBackoffMs(5, cfg);
  assert.ok(ms <= 250 * 1.2 + 1);
  assert.ok(ms >= 0);
});

test("isSessionResumable allows failed with incomplete units", () => {
  // failed + only failed units → not resumable
  assert.equal(
    isSessionResumable({
      status: "failed",
      stage: "specialists",
      units: [{ status: "failed" } as ReviewUnit],
      resumeAttempts: 0,
      maxGlobalRetries: 3,
    }),
    false,
  );
  // failed + completed partial → resumable
  assert.equal(
    isSessionResumable({
      status: "failed",
      stage: "specialists",
      units: [
        { status: "completed" } as ReviewUnit,
        { status: "pending" } as ReviewUnit,
      ],
      resumeAttempts: 0,
      maxGlobalRetries: 3,
    }),
    true,
  );
  assert.equal(
    isSessionResumable({
      status: "completed",
      stage: "completed",
      units: [],
      resumeAttempts: 0,
      maxGlobalRetries: 3,
    }),
    false,
  );
});

test("splitReviewUnit splits multi-path units", () => {
  const kids = splitReviewUnit(sampleUnit);
  assert.ok(kids.length >= 2);
});

test("coverageGapFinding is informational", () => {
  const f = coverageGapFinding({
    sessionId: "s1",
    repoId: "r1",
    unit: {
      ...sampleUnit,
      paths: ["a.ts"],
      status: "skipped",
    },
    error: "test failure",
  });
  assert.equal(f.severity, "info");
  assert.ok(f.tags?.includes("coverage-gap"));
});
