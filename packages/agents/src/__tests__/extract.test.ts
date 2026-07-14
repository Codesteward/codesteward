import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFindingsFromLlm } from "../extract.js";

describe("extractFindingsFromLlm", () => {
  it("accepts file alias, missing path, confidence 0-100, and string ruleIds", () => {
    const content = JSON.stringify({
      findings: [
        {
          title: "sql injection",
          file: "src/db.ts",
          line: "42",
          confidence: 90,
          severity: "High",
          category: "security",
        },
        {
          title: "no path ok",
          body: "still valid",
          ruleIds: "rule-a",
        },
        {
          title: "string confidence",
          path: "x.ts",
          confidence: "0.55",
        },
      ],
    });
    const out = extractFindingsFromLlm(content, { role: "security" });
    assert.equal(out.length, 3);
    assert.equal(out[0]!.path, "src/db.ts");
    assert.equal(out[0]!.startLine, 42);
    assert.equal(out[0]!.confidence, 0.9);
    assert.equal(out[0]!.severity, "high");
    assert.equal(out[1]!.path, "unknown");
    assert.deepEqual(out[1]!.ruleIds, ["rule-a"]);
    assert.equal(out[2]!.confidence, 0.55);
  });

  it("peels fenced JSON", () => {
    const content = 'Here:\n```json\n{"findings":[{"title":"xss","file":"ui.tsx"}]}\n```\n';
    const out = extractFindingsFromLlm(content, { role: "security" });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.path, "ui.tsx");
  });
});
