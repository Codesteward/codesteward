import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression: materialize used `git checkout --force -- <sha>`, which makes
 * git treat the SHA as a *pathspec* and always fails with:
 *   pathspec '<sha>' did not match any file(s) known to git
 */
describe("clone checkout args", () => {
  it("does not use checkout --force -- <ref> (pathspec mode)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../clone.ts"), "utf8");
    assert.ok(
      !src.includes('["checkout", "--force", "--"'),
      "must not call git checkout --force -- <ref>",
    );
    assert.ok(
      !src.includes("['checkout', '--force', '--']"),
      "must not call git checkout --force -- <ref>",
    );
    assert.match(src, /pathspec/);
    assert.match(src, /switch/);
  });
});
