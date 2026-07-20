/**
 * Run: pnpm --filter @codesteward/model-router test (or tsx --test this file)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeLangfuseSessionId,
  buildLangfuseTraceArgs,
} from "../langfuse.js";

describe("langfuse sessionId for Sessions UI", () => {
  it("preserves codesteward session ids", () => {
    const id = "ses_01HQXYZABCDEFG1234567890";
    assert.equal(sanitizeLangfuseSessionId(id), id);
  });

  it("trims and caps at 200 ASCII chars", () => {
    const long = "a".repeat(250);
    assert.equal(sanitizeLangfuseSessionId(long)?.length, 200);
    assert.equal(sanitizeLangfuseSessionId("  ses_abc  "), "ses_abc");
  });

  it("replaces non-ASCII so Langfuse accepts the id", () => {
    const s = sanitizeLangfuseSessionId("ses_café");
    assert.ok(s);
    assert.ok(/^[\x20-\x7E]+$/.test(s!));
  });

  it("returns undefined for empty", () => {
    assert.equal(sanitizeLangfuseSessionId(""), undefined);
    assert.equal(sanitizeLangfuseSessionId(null), undefined);
    assert.equal(sanitizeLangfuseSessionId("   "), undefined);
  });

  it("buildLangfuseTraceArgs always sets sessionId for session mode", () => {
    const args = buildLangfuseTraceArgs(
      {
        sessionId: "ses_review_1",
        orgId: "org_1",
        role: "security",
        traceName: "codesteward.review",
      },
      "org",
      { mode: "session" },
    );
    assert.equal(args.sessionId, "ses_review_1");
    // Role-scoped under the review session (not a bare prior-session id)
    assert.equal(args.id, "ses_review_1:security");
    assert.equal(args.name, "codesteward.review");
  });

  it("never lets a foreign traceId escape the current session prefix", () => {
    const args = buildLangfuseTraceArgs(
      {
        sessionId: "ses_new_abc",
        // Simulate stale/wrong id from a previous review
        traceId: "ses_old_zzz:root:security",
        role: "security",
      },
      "org",
      { mode: "session" },
    );
    assert.equal(args.sessionId, "ses_new_abc");
    assert.equal(String(args.id).startsWith("ses_new_abc"), true);
    assert.equal(String(args.id).startsWith("ses_old_zzz"), false);
  });

  it("per_call mode still sets sessionId for Sessions grouping", () => {
    const args = buildLangfuseTraceArgs(
      { sessionId: "ses_review_1", role: "judge" },
      "platform",
      { mode: "per_call" },
    );
    assert.equal(args.sessionId, "ses_review_1");
    assert.equal(args.id, undefined);
  });
});
