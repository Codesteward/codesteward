import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFingerprint } from "../fingerprint.js";

test("fingerprint is stable for same content", () => {
  const a = computeFingerprint({
    path: "src/a.ts",
    category: "correctness",
    ruleId: "r1",
    snippet: "const x = 1",
  });
  const b = computeFingerprint({
    path: "src/a.ts",
    category: "correctness",
    ruleId: "r1",
    snippet: "const x = 1",
  });
  assert.equal(a, b);
  assert.ok(a.length > 8);
});

test("fingerprint differs for different paths", () => {
  const a = computeFingerprint({ path: "src/a.ts", category: "correctness" });
  const b = computeFingerprint({ path: "src/b.ts", category: "correctness" });
  assert.notEqual(a, b);
});
