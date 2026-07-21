import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fencedCodeBlock,
  formatFindingPrCommentBody,
  markdownLanguageFromPath,
} from "../scm-findings-publish.js";

describe("markdownLanguageFromPath", () => {
  it("maps common extensions for GFM highlighting", () => {
    assert.equal(markdownLanguageFromPath("pkg/foo.go"), "go");
    assert.equal(markdownLanguageFromPath("src/App.tsx"), "tsx");
    assert.equal(markdownLanguageFromPath("lib/util.ts"), "typescript");
    assert.equal(markdownLanguageFromPath("chart/values.yaml"), "yaml");
    assert.equal(markdownLanguageFromPath("Dockerfile"), "dockerfile");
    assert.equal(markdownLanguageFromPath("unknown"), "");
  });
});

describe("fencedCodeBlock", () => {
  it("includes language tag", () => {
    const block = fencedCodeBlock("func main() {}", "go");
    assert.equal(block, "```go\nfunc main() {}\n```");
  });
});

describe("formatFindingPrCommentBody", () => {
  it("uses language from path for context and always ```diff for proposed fix", () => {
    const body = formatFindingPrCommentBody(
      {
        path: "internal/controller/queue.go",
        startLine: 10,
        title: "Example",
        body: "Explain",
        severity: "high",
        category: "security",
        existingCode: "if err != nil {\n  return err\n}",
        // plain snippet — must be normalized to unified diff + fenced as diff
        suggestedFix: "if err != nil {\n  return fmt.Errorf(\"wrap: %w\", err)\n}",
      },
      { inline: true },
    );
    assert.match(body, /```go\n/);
    assert.match(body, /\*\*Proposed fix:\*\*\n```diff\n/);
    assert.match(body, /--- a\/internal\/controller\/queue\.go/);
    assert.match(body, /\+if err != nil \{/);
    assert.doesNotMatch(body, /\*\*Proposed fix:\*\*\n```go\n/);
  });

  it("keeps already-unified suggestedFix as ```diff", () => {
    const body = formatFindingPrCommentBody(
      {
        path: "src/a.ts",
        startLine: 1,
        title: "T",
        body: "B",
        severity: "low",
        suggestedFix:
          "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      },
      { inline: true },
    );
    assert.match(body, /```diff\n--- a\/src\/a\.ts/);
  });
});
