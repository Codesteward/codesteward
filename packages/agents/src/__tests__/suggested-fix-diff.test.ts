import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureDiffFileHeaders,
  looksLikeUnifiedDiff,
  normalizeSuggestedFixAsDiff,
  snippetToUnifiedDiff,
  stripOuterCodeFence,
} from "../suggested-fix-diff.js";

describe("suggested-fix-diff", () => {
  it("detects unified diffs and strips outer fences", () => {
    assert.equal(
      looksLikeUnifiedDiff(
        "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2\n",
      ),
      true,
    );
    assert.equal(looksLikeUnifiedDiff("const a = 1;"), false);
    assert.equal(
      stripOuterCodeFence("```ts\nconst x = 1\n```"),
      "const x = 1",
    );
  });

  it("wraps hunk-only bodies with file headers", () => {
    const out = ensureDiffFileHeaders(
      "@@ -1,1 +1,1 @@\n-old\n+new\n",
      "src/foo.ts",
    );
    assert.match(out, /^--- a\/src\/foo\.ts\n/);
    assert.match(out, /^\+\+\+ b\/src\/foo\.ts\n/m);
  });

  it("converts plain snippets + existingCode into unified diffs", () => {
    const diff = snippetToUnifiedDiff({
      path: "pkg/main.go",
      existingCode: "return err",
      suggestedFix: 'return fmt.Errorf("wrap: %w", err)',
      startLine: 42,
    });
    assert.match(diff, /--- a\/pkg\/main\.go/);
    assert.match(diff, /\+\+\+ b\/pkg\/main\.go/);
    assert.match(diff, /@@ -42,1 \+42,1 @@/);
    assert.match(diff, /-return err/);
    assert.match(diff, /\+return fmt\.Errorf/);
  });

  it("normalizeSuggestedFixAsDiff is idempotent for real diffs", () => {
    const input =
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    const once = normalizeSuggestedFixAsDiff({
      path: "a.ts",
      suggestedFix: input,
    });
    const twice = normalizeSuggestedFixAsDiff({
      path: "a.ts",
      suggestedFix: once,
    });
    assert.equal(once, twice);
    assert.match(once, /--- a\/a\.ts/);
  });

  it("normalizeSuggestedFixAsDiff upgrades bare snippets", () => {
    const out = normalizeSuggestedFixAsDiff({
      path: "lib/util.ts",
      suggestedFix: "export const x = 1;",
      existingCode: "export let x = 1;",
      startLine: 3,
    });
    assert.match(out, /```|--- a\/lib\/util\.ts/);
    assert.ok(!out.includes("```"), "no markdown fences inside stored diff");
    assert.match(out, /-export let x = 1;/);
    assert.match(out, /\+export const x = 1;/);
  });
});
