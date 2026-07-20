import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePrMerge,
  suggestionApplyScore,
  outcomesToEvalCases,
  computeQualityKpis,
  textEmbedding,
  matchPreference,
  cosineSimilarity,
} from "../index.js";

describe("suggestionApplyScore", () => {
  it("scores overlapping patches", () => {
    const s = suggestionApplyScore(
      "use parameterized query for userId",
      "+ const row = db.query('select * from users where id = $1', [userId])",
    );
    assert.ok(s > 0.1);
  });
});

describe("analyzePrMerge", () => {
  it("marks path-changed open findings as fixed and untouched as unaddressed", () => {
    const result = analyzePrMerge({
      orgId: "local",
      repoId: "acme/api",
      prNumber: 42,
      mergeSha: "abc",
      pathsChanged: ["src/db.ts"],
      findings: [
        {
          id: "f1",
          repoId: "acme/api",
          path: "src/db.ts",
          title: "SQL injection",
          fingerprint: "fp1",
          status: "open",
          tags: ["scope:pr:42"],
          severity: "high",
          confidence: 0.9,
        },
        {
          id: "f2",
          repoId: "acme/api",
          path: "src/other.ts",
          title: "Nit naming",
          fingerprint: "fp2",
          status: "open",
          tags: ["scope:pr:42"],
          severity: "nit",
          confidence: 0.4,
        },
        {
          id: "f3",
          repoId: "acme/api",
          path: "src/style.ts",
          title: "Whitespace",
          fingerprint: "fp3",
          status: "false_positive",
          tags: ["scope:pr:42", "reaction:down"],
          severity: "nit",
        },
      ],
    });
    assert.equal(result.pr.counts.posted, 3);
    assert.ok(result.markFixedIds.includes("f1"));
    assert.ok(
      result.findingOutcomes.some(
        (o) => o.findingId === "f2" && o.kind === "unaddressed_at_merge",
      ),
    );
    assert.ok(
      result.findingOutcomes.some(
        (o) => o.findingId === "f3" && o.kind === "false_positive",
      ),
    );
    assert.ok((result.pr.rates.fixAcceptRate ?? 0) > 0);
  });

  it("emits agent_miss_candidate for sensitive unflagged paths", () => {
    const result = analyzePrMerge({
      orgId: "local",
      repoId: "acme/api",
      prNumber: 1,
      pathsChanged: ["src/auth/password.ts"],
      findings: [],
    });
    assert.ok(result.pr.counts.agentMissCandidates >= 1);
    assert.ok(result.agentMissNotes.some((n) => n.path.includes("password")));
  });
});

describe("outcomesToEvalCases + computeQualityKpis", () => {
  it("builds eval cases and split KPIs", () => {
    const analyzed = analyzePrMerge({
      orgId: "local",
      repoId: "r",
      prNumber: 1,
      pathsChanged: ["a.ts"],
      findings: [
        {
          id: "1",
          repoId: "r",
          path: "a.ts",
          title: "bug",
          fingerprint: "x",
          status: "open",
          tags: ["scope:pr:1"],
          severity: "high",
          confidence: 0.9,
        },
      ],
    });
    const cases = outcomesToEvalCases(analyzed.findingOutcomes);
    assert.ok(cases.length >= 1);
    const kpis = computeQualityKpis({
      findings: [
        {
          id: "1",
          repoId: "r",
          title: "bug",
          fingerprint: "x",
          status: "fixed",
          tags: ["auto-fixed:merge:abc"],
          confidence: 0.9,
        },
        {
          id: "2",
          repoId: "r",
          title: "noise",
          fingerprint: "y",
          status: "false_positive",
          tags: ["reaction:down"],
          confidence: 0.3,
        },
      ],
      outcomes: analyzed.findingOutcomes,
    });
    assert.equal(kpis.fixAccept, 1);
    assert.equal(kpis.noise, 1);
  });
});

describe("embeddings preference match", () => {
  it("suppresses candidates near negative prototypes", () => {
    const neg = textEmbedding("prefer const trailing comma style nit whitespace");
    const pos = textEmbedding("sql injection authentication bypass secret leak");
    const hit = matchPreference("fix trailing whitespace style", [
      { polarity: "negative", embedding: neg, subjectId: "n1" },
      { polarity: "positive", embedding: pos, subjectId: "p1" },
    ]);
    assert.ok(hit.suppress || hit.score > 0.2);
    assert.ok(cosineSimilarity(neg, neg) > 0.99);
  });
});
