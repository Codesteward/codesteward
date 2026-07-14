/**
 * Run: pnpm --filter @codesteward/model-router exec tsx --test src/__tests__/langfuse-redact.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactForLangfuse, redactCompleteRequest, isLangfuseAllowed } from "../langfuse.js";

describe("langfuse redaction", () => {
  it("redacts sk- and ghp tokens", () => {
    const s = redactForLangfuse("key=sk-abc1234567890xyz and ghp_abcdefghijklmnopqrstuvwxyz12", {});
    assert.ok(!s.includes("sk-abc"));
    assert.ok(!s.includes("ghp_"));
    assert.ok(s.includes("[REDACTED]"));
  });

  it("redacts emails by default", () => {
    const s = redactForLangfuse("contact alice@example.com please", {});
    assert.ok(!s.includes("alice@example.com"));
    assert.ok(s.includes("[EMAIL]"));
  });

  it("redacts complete request messages", () => {
    const out = redactCompleteRequest(
      {
        system: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xx.yy",
        messages: [{ role: "user", content: "token sk-test1234567890ab" }],
      },
      {},
    );
    assert.ok(String(out.system).includes("[REDACTED]"));
    assert.ok(String((out.messages as Array<{ content: string }>)[0]!.content).includes("[REDACTED]"));
  });

  it("isLangfuseAllowed respects STEW_LICENSE_LANGFUSE=0", () => {
    assert.equal(
      isLangfuseAllowed({
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
        STEW_LICENSE_LANGFUSE: "0",
      } as NodeJS.ProcessEnv),
      false,
    );
    assert.equal(
      isLangfuseAllowed({
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      } as NodeJS.ProcessEnv),
      true,
    );
  });
});
