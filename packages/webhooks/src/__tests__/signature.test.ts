import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature } from "../github-verify.js";
import { verifyGitLabToken, verifyGitLabHmac } from "../gitlab-handler.js";

test("verifyGitHubSignature accepts valid hmac", () => {
  const body = '{"ok":true}';
  const secret = "s3cret";
  const sig =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyGitHubSignature(body, sig, secret), true);
});

test("verifyGitHubSignature rejects invalid hmac", () => {
  assert.equal(
    verifyGitHubSignature("{}", "sha256=deadbeef", "s3cret"),
    false,
  );
});

test("verifyGitLabToken accepts matching token", () => {
  assert.equal(verifyGitLabToken("my-token", "my-token"), true);
});

test("verifyGitLabToken rejects mismatch", () => {
  assert.equal(verifyGitLabToken("a", "b"), false);
  assert.equal(verifyGitLabToken(undefined, "b"), false);
});

test("verifyGitLabHmac accepts valid", () => {
  const body = '{"object_kind":"merge_request"}';
  const secret = "gl-secret";
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyGitLabHmac(body, sig, secret), true);
  assert.equal(verifyGitLabHmac(body, "sha256=" + sig, secret), true);
});
