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
  it("highlights context and proposed fix from path", () => {
    const body = formatFindingPrCommentBody(
      {
        path: "internal/controller/queue.go",
        startLine: 10,
        title: "Example",
        body: "Explain",
        severity: "high",
        category: "security",
        existingCode: "if err != nil {\n  return err\n}",
        suggestedFix: "if err != nil {\n  return fmt.Errorf(\"wrap: %w\", err)\n}",
      },
      { inline: true },
    );
    assert.match(body, /```go\n/);
    assert.equal((body.match(/```go\n/g) ?? []).length, 2);
    assert.doesNotMatch(body, /```\nfunc/);
  });
});
