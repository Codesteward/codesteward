import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planOutcomePromotions } from "../consolidate-outcomes.js";
import type { FindingOutcome } from "@codesteward/core";

function fo(
  partial: Partial<FindingOutcome> &
    Pick<FindingOutcome, "id" | "repoId" | "kind" | "fingerprint">,
): FindingOutcome {
  return {
    orgId: "org1",
    createdAt: new Date().toISOString(),
    confidence: 0.8,
    ...partial,
  };
}

describe("planOutcomePromotions scope rules", () => {
  it("promotes single-repo common pattern as repo scope", () => {
    const outcomes: FindingOutcome[] = [1, 2, 3].map((i) =>
      fo({
        id: `a${i}`,
        repoId: "acme/api",
        kind: "accepted",
        fingerprint: "fp-same",
      }),
    );
    const planned = planOutcomePromotions(outcomes, { orgId: "org1" });
    assert.equal(planned.length, 1);
    assert.equal(planned[0]!.scope, "repo");
    assert.equal(planned[0]!.repoId, "acme/api");
    assert.equal(planned[0]!.polarity, "positive");
  });

  it("promotes multi-repo pattern as org scope", () => {
    const outcomes: FindingOutcome[] = [
      fo({ id: "1", repoId: "acme/api", kind: "fixed", fingerprint: "fp-x" }),
      fo({ id: "2", repoId: "acme/api", kind: "fixed", fingerprint: "fp-x" }),
      fo({ id: "3", repoId: "acme/web", kind: "accepted", fingerprint: "fp-x" }),
      fo({ id: "4", repoId: "acme/web", kind: "accepted", fingerprint: "fp-x" }),
    ];
    const planned = planOutcomePromotions(outcomes, {
      orgId: "org1",
      minRepoCount: 2,
      minOrgRepos: 2,
      minOrgCount: 3,
    });
    assert.ok(planned.some((p) => p.scope === "org" && p.fingerprint === "fp-x"));
    assert.ok(!planned.some((p) => p.scope === "repo" && p.fingerprint === "fp-x"));
  });

  it("elevates important single-repo signal to org", () => {
    const outcomes: FindingOutcome[] = [
      fo({
        id: "1",
        repoId: "acme/api",
        kind: "accepted",
        fingerprint: "fp-sec",
        confidence: 0.95,
        metadata: { severity: "critical" },
      }),
      fo({
        id: "2",
        repoId: "acme/api",
        kind: "fixed",
        fingerprint: "fp-sec",
        confidence: 0.95,
        metadata: { severity: "critical" },
      }),
    ];
    const planned = planOutcomePromotions(outcomes, {
      orgId: "org1",
      minRepoCount: 5, // would not qualify as repo-only
      minImportantCount: 2,
    });
    assert.equal(planned.length, 1);
    assert.equal(planned[0]!.scope, "org");
    assert.ok(planned[0]!.evidence.important);
  });

  it("does not promote sparse noise as suppress", () => {
    const outcomes: FindingOutcome[] = [
      fo({
        id: "1",
        repoId: "acme/api",
        kind: "false_positive",
        fingerprint: "fp-once",
      }),
    ];
    const planned = planOutcomePromotions(outcomes, { orgId: "org1" });
    assert.equal(planned.length, 0);
  });

  it("promotes repeated FP in one repo as repo-scoped negative", () => {
    const outcomes: FindingOutcome[] = [1, 2, 3].map((i) =>
      fo({
        id: `n${i}`,
        repoId: "acme/api",
        kind: "false_positive",
        fingerprint: "fp-noise",
      }),
    );
    const planned = planOutcomePromotions(outcomes, { orgId: "org1" });
    assert.equal(planned.length, 1);
    assert.equal(planned[0]!.scope, "repo");
    assert.equal(planned[0]!.polarity, "negative");
  });
});
