import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractThreadCommentIds,
  handleGitHubWebhook,
  type GitHubWebhookDeps,
} from "../github-handler.js";

describe("extractThreadCommentIds", () => {
  it("collects numeric and string comment ids", () => {
    const ids = extractThreadCommentIds({
      comments: [{ id: 11 }, { id: "22" }, {}],
    });
    assert.deepEqual(ids, ["11", "22"]);
  });
});

describe("handleGitHubWebhook review thread + advisory", () => {
  const baseDeps = (): GitHubWebhookDeps =>
    ({
      secret: "dev-insecure",
      scm: {} as never,
      enqueueGate: async () => ({ sessionId: "s", jobId: "j" }),
      resolveProductOrgId: async () => "org1",
    }) as GitHubWebhookDeps;

  it("routes pull_request_review_thread resolved to onReviewThread", async () => {
    let called = false;
    const deps = baseDeps();
    deps.onReviewThread = async (input) => {
      called = true;
      assert.equal(input.action, "resolved");
      assert.equal(input.prNumber, 9);
      assert.deepEqual(input.commentIds, ["1001"]);
      assert.equal(input.orgId, "org1");
      return { matched: 1, outcomeIds: ["fout_1"] };
    };
    const body = JSON.stringify({
      action: "resolved",
      pull_request: { number: 9 },
      thread: { node_id: "PRT_1", comments: [{ id: 1001 }] },
      repository: {
        full_name: "acme/api",
        name: "api",
        owner: { login: "acme" },
      },
    });
    const res = await handleGitHubWebhook(
      deps,
      { "x-github-event": "pull_request_review_thread", "x-github-delivery": "d1" },
      body,
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(called, true);
    assert.equal(res.body.matched, 1);
  });

  it("routes security_advisory to onSecurityAdvisory", async () => {
    let called = false;
    const deps = baseDeps();
    deps.onSecurityAdvisory = async (input) => {
      called = true;
      assert.equal(input.ghsaId, "GHSA-xxxx");
      assert.ok(input.packageNames?.includes("lodash"));
      return { outcomeId: "fout_adv" };
    };
    const body = JSON.stringify({
      action: "published",
      security_advisory: {
        ghsa_id: "GHSA-xxxx",
        summary: "Prototype pollution",
        severity: "high",
        vulnerabilities: [{ package: { name: "lodash", ecosystem: "npm" } }],
      },
      repository: { full_name: "acme/api", owner: { login: "acme" }, name: "api" },
    });
    const res = await handleGitHubWebhook(
      deps,
      { "x-github-event": "security_advisory", "x-github-delivery": "d2" },
      body,
    );
    assert.equal(res.ok, true);
    assert.equal(called, true);
    assert.equal(res.body.outcomeId, "fout_adv");
  });
});
