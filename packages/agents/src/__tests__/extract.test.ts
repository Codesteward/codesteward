import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreEmptyScanConfidence,
  scoreProductConfidence,
} from "../confidence.js";
import {
  extractEmptyScanModelConfidence,
  extractFindingsFromLlm,
  resolveSpecialistRunConfidence,
} from "../extract.js";

describe("extractFindingsFromLlm", () => {
  it("maps model self-score to modelConfidence and derives product confidence", () => {
    const content = JSON.stringify({
      findings: [
        {
          title: "sql injection",
          file: "src/db.ts",
          line: "42",
          body: "Untrusted input concatenated into SQL query without parameterization.",
          confidence: 90,
          severity: "High",
          category: "security",
        },
        {
          title: "no path ok",
          body: "still valid finding body text here",
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
    assert.equal(out[0]!.modelConfidence, 0.9);
    // Product score is evidence-derived (path+line+body), not raw 0.9
    assert.ok((out[0]!.confidence ?? 0) >= 0.7);
    assert.ok((out[0]!.confidence ?? 1) < 0.95);
    assert.equal(out[0]!.severity, "high");
    assert.equal(out[1]!.path, "unknown");
    assert.deepEqual(out[1]!.ruleIds, ["rule-a"]);
    assert.equal(out[2]!.modelConfidence, 0.55);
  });

  it("passes tokenConfidence into findings when provided", () => {
    const content = JSON.stringify({
      findings: [
        {
          title: "t",
          path: "a.ts",
          startLine: 1,
          body: "Enough body text for hasBody signal in product scorer.",
          confidence: 0.99,
        },
      ],
    });
    const out = extractFindingsFromLlm(content, {
      role: "security",
      tokenConfidence: 0.88,
    });
    assert.equal(out[0]!.tokenConfidence, 0.88);
    assert.equal(out[0]!.modelConfidence, 0.99);
    assert.notEqual(out[0]!.confidence, 0.99);
  });

  it("peels fenced JSON", () => {
    const content =
      'Here:\n```json\n{"findings":[{"title":"xss","file":"ui.tsx"}]}\n```\n';
    const out = extractFindingsFromLlm(content, { role: "security" });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.path, "ui.tsx");
  });

  it("extracts suggestedFix and existingCode aliases", () => {
    const prev = process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE;
    process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE = "0.5";
    try {
      const content = JSON.stringify({
        findings: [
          {
            title: "use const",
            path: "a.ts",
            startLine: 1,
            confidence: 0.9,
            suggestion: "Prefer const for never-reassigned bindings",
            suggestedFix: "const x = 1;",
            existingCode: "let x = 1;",
          },
          {
            title: "alias fix",
            path: "b.ts",
            confidence: 0.9,
            code_fix: "return null;",
            existing_code: "return undefined;",
          },
        ],
      });
      const out = extractFindingsFromLlm(content, { role: "correctness" });
      assert.equal(out.length, 2);
      assert.ok(out[0]!.suggestedFix?.includes("--- a/a.ts"));
      assert.ok(out[0]!.suggestedFix?.includes("+const x = 1;"));
      assert.equal(out[0]!.existingCode, "let x = 1;");
      assert.equal(out[0]!.suggestion?.includes("const"), true);
      assert.ok(out[1]!.suggestedFix?.includes("+return null;"));
      assert.equal(out[1]!.existingCode, "return undefined;");
    } finally {
      if (prev === undefined) delete process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE;
      else process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE = prev;
    }
  });

  it("gates suggestedFix on product confidence, not model self-score alone", () => {
    const prev = process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE;
    process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE = "0.8";
    try {
      const content = JSON.stringify({
        findings: [
          {
            title: "inflated model score, no anchor",
            confidence: 0.99,
            suggestion: "maybe fix",
            suggestedFix: "badFix();",
          },
          {
            title: "well grounded",
            path: "b.ts",
            startLine: 10,
            body: "Concrete issue with enough detail for product scorer body signal.",
            confidence: 0.5,
            suggestion: "good fix",
            suggestedFix: "goodFix();",
          },
        ],
      });
      const out = extractFindingsFromLlm(content, { role: "correctness" });
      assert.equal(out.length, 2);
      assert.equal(out[0]!.modelConfidence, 0.99);
      assert.equal(out[0]!.suggestedFix, undefined);
      assert.equal(out[0]!.suggestion, "maybe fix");
      assert.ok((out[1]!.confidence ?? 0) >= 0.8);
      assert.ok(out[1]!.suggestedFix?.includes("+goodFix();"));
    } finally {
      if (prev === undefined) delete process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE;
      else process.env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE = prev;
    }
  });
});


  it("extracts structured reasoning and evidence.reasoning entry", () => {
    const content = JSON.stringify({
      findings: [
        {
          title: "auth bypass",
          path: "api.ts",
          startLine: 3,
          body: "Missing auth middleware on admin route.",
          confidence: 0.8,
          reasoning:
            "Route registered without requireAuth; graph shows handlers reachable from public router.",
        },
        {
          title: "alias rationale",
          path: "b.ts",
          rationale: "Checked null branch; crash when user is undefined.",
        },
      ],
    });
    const out = extractFindingsFromLlm(content, { role: "security" });
    assert.equal(out.length, 2);
    assert.ok(out[0]!.reasoning?.includes("requireAuth"));
    assert.equal(out[0]!.evidence?.[0]?.type, "reasoning");
    assert.equal(out[0]!.evidence?.[0]?.payload?.role, "security");
    assert.ok(out[1]!.reasoning?.includes("null branch"));
  });

describe("scoreProductConfidence", () => {
  it("does not treat model self-score as product score", () => {
    const highModel = scoreProductConfidence({
      modelConfidence: 0.99,
      hasPath: false,
      hasLine: false,
    });
    const grounded = scoreProductConfidence({
      modelConfidence: 0.4,
      hasPath: true,
      hasLine: true,
      hasBody: true,
      hasGraphEvidence: true,
    });
    assert.ok(grounded > highModel);
    assert.ok(highModel < 0.7);
  });
});

describe("empty scan confidence", () => {
  it("parses emptyScanConfidence from empty findings JSON", () => {
    const c = extractEmptyScanModelConfidence(
      JSON.stringify({ findings: [], emptyScanConfidence: 0.88 }),
    );
    assert.equal(c, 0.88);
  });

  it("sets avgConfidence for zero-finding specialist runs", () => {
    const run = resolveSpecialistRunConfidence({
      findings: [],
      responseContent: JSON.stringify({
        findings: [],
        emptyScanConfidence: 0.9,
      }),
      pathsReviewed: 4,
      filesReviewed: 3,
      usedGraph: true,
    });
    assert.equal(run.emptyScan, true);
    assert.ok(run.avgConfidence >= 0.7);
    assert.equal(run.modelEmptyScanConfidence, 0.9);
  });

  it("scores empty scans lower without context", () => {
    const thin = scoreEmptyScanConfidence({ validEmptyJson: true });
    const thick = scoreEmptyScanConfidence({
      validEmptyJson: true,
      pathsReviewed: 5,
      filesReviewed: 5,
      usedGraph: true,
      modelConfidence: 0.85,
    });
    assert.ok(thick > thin);
  });
});
