import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  isRetryableLlmError,
  isRetryableLlmStatus,
  parseRetryAfterMs,
} from "../llm-retry.js";

describe("llm-retry", () => {
  it("treats 429 and 503 as retryable", () => {
    assert.equal(isRetryableLlmStatus(429), true);
    assert.equal(isRetryableLlmStatus(503), true);
    assert.equal(isRetryableLlmStatus(401), false);
    assert.equal(isRetryableLlmStatus(400, "rate limit exceeded"), true);
  });

  it("detects rate limit errors in messages", () => {
    assert.equal(isRetryableLlmError(new Error("HTTP 429 rate limit")), true);
    assert.equal(isRetryableLlmError(new Error("invalid api key")), false);
  });

  it("parses Retry-After seconds", () => {
    const ms = parseRetryAfterMs("2");
    assert.equal(ms, 2000);
  });

  it("backoff grows with attempt", () => {
    const a0 = backoffMs(0, undefined);
    const a3 = backoffMs(3, undefined);
    assert.ok(a0 >= 800 && a0 <= 1400);
    assert.ok(a3 > a0);
  });
});
