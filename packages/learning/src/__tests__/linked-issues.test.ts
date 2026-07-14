import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatLinkedIssuesContext,
  parseLinkedIssueRefs,
} from "../linked-issues.js";
import { triageCommentHeuristic } from "../comment-triage.js";

describe("parseLinkedIssueRefs", () => {
  it("parses Fixes/Closes/Resolves and loose related", () => {
    const refs = parseLinkedIssueRefs(
      "Fixes #12 and closes #3. Related to #7. See #9. Resolves org/repo#4",
    );
    const nums = refs.map((r) => r.number).sort((a, b) => a - b);
    assert.deepEqual(nums, [3, 4, 7, 9, 12]);
  });

  it("returns empty for blank", () => {
    assert.deepEqual(parseLinkedIssueRefs(""), []);
    assert.deepEqual(parseLinkedIssueRefs(null), []);
  });
});

describe("formatLinkedIssuesContext", () => {
  it("builds a prompt block", () => {
    const text = formatLinkedIssuesContext([
      {
        number: 12,
        title: "Auth bypass",
        body: "Users can skip MFA",
        state: "open",
        url: "https://example.com/12",
        labels: ["security"],
      },
    ]);
    assert.ok(text.includes("#12"));
    assert.ok(text.includes("Auth bypass"));
    assert.ok(text.includes("skip MFA"));
  });
});

describe("triageCommentHeuristic", () => {
  it("detects PR-scoped deferral as learn", () => {
    const r = triageCommentHeuristic({
      commentBody: "@codesteward don't implement rate limiting in this PR — follow-up PR",
      repoId: "acme/api",
      prNumber: 5,
    });
    assert.equal(r.intent, "learn");
    assert.ok(r.learning);
    assert.equal(r.learning!.scope, "pr");
    assert.equal(r.learning!.polarity, "negative");
  });

  it("detects review trigger", () => {
    const r = triageCommentHeuristic({
      commentBody: "@codesteward please review again focusing on auth",
      repoId: "acme/api",
      prNumber: 5,
    });
    assert.equal(r.intent, "review");
    assert.ok(r.reviewFocus || r.intent === "review");
  });
});
