/**
 * Cross-repo path normalization + tenant jail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReviewToolPath,
  resolveInsideRoot,
  rewriteShellCommandPaths,
  toVirtualReviewPath,
} from "../path-jail.js";

const sessionRoot = "/workspace/local/ses_test123";
const crossRoot = `${sessionRoot}/cross/Codesteward__codesteward-prompt-evaluator`;

describe("normalizeReviewToolPath (cross-repo)", () => {
  it("maps host cross path into unit clone root", () => {
    const rel = normalizeReviewToolPath(
      "workspace/local/ses_test123/cross/Codesteward__codesteward-prompt-evaluator",
      crossRoot,
    );
    assert.equal(rel, ".");
  });

  it("maps nested file under mistaken host cross path", () => {
    const rel = normalizeReviewToolPath(
      `/workspace/local/ses_test123/cross/Codesteward__codesteward-prompt-evaluator/src/main.go`,
      crossRoot,
    );
    assert.equal(rel, "src/main.go");
  });

  it("maps virtual absolute paths under unit root", () => {
    assert.equal(normalizeReviewToolPath("/src/foo.ts", crossRoot), "src/foo.ts");
    assert.equal(toVirtualReviewPath("src/foo.ts"), "/src/foo.ts");
  });

  it("strips cross/Owner__repo prefix when already at that root", () => {
    assert.equal(
      normalizeReviewToolPath(
        "cross/Codesteward__codesteward-prompt-evaluator/pkg/x.go",
        crossRoot,
      ),
      "pkg/x.go",
    );
  });

  it("allows session-root relative cross path when unit is session root", () => {
    const rel = normalizeReviewToolPath(
      "cross/Codesteward__codesteward-prompt-evaluator/README.md",
      sessionRoot,
    );
    assert.equal(rel, "cross/Codesteward__codesteward-prompt-evaluator/README.md");
  });

  it("refuses sibling session escape", () => {
    assert.throws(() =>
      normalizeReviewToolPath(
        "/workspace/local/ses_OTHER/cross/foo",
        crossRoot,
      ),
    );
  });

  it("resolveInsideRoot still jails", () => {
    assert.throws(() => resolveInsideRoot(crossRoot, "../ses_OTHER/secret"));
  });
});

describe("rewriteShellCommandPaths (cross-repo + isolation)", () => {
  it("rewrites mistaken host path in ls (session bug ses_mrulb…)", () => {
    const r = rewriteShellCommandPaths(
      "ls workspace/local/ses_test123/cross/Codesteward__codesteward-prompt-evaluator",
      crossRoot,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.rewrote, true);
      assert.equal(r.command, "ls .");
    }
  });

  it("rewrites quoted host paths and nested files", () => {
    const r = rewriteShellCommandPaths(
      `cat '/workspace/local/ses_test123/cross/Codesteward__codesteward-prompt-evaluator/src/main.go'`,
      crossRoot,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.command, "cat 'src/main.go'");
    }
  });

  it("refuses sibling session shell path", () => {
    const r = rewriteShellCommandPaths(
      "ls /workspace/local/ses_OTHER/cross/foo",
      crossRoot,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /other session|escapes/i);
    }
  });

  it("refuses parent traversal", () => {
    const r = rewriteShellCommandPaths("cat ../ses_OTHER/secret", crossRoot);
    assert.equal(r.ok, false);
  });

  it("leaves normal relative commands alone", () => {
    const r = rewriteShellCommandPaths("ls -la src && head -n 5 README.md", crossRoot);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.rewrote, false);
      assert.equal(r.command, "ls -la src && head -n 5 README.md");
    }
  });
});
