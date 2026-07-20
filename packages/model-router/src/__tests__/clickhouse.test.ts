/**
 * Unit tests for ClickHouse config / row shaping (no network).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClickHouseConfigComplete,
  clickHouseConfigFromEnv,
  createClickHouseWriter,
} from "../clickhouse.js";

describe("clickhouse config", () => {
  it("isComplete requires url and enabled", () => {
    assert.equal(isClickHouseConfigComplete(null), false);
    assert.equal(isClickHouseConfigComplete({ url: "", enabled: true }), false);
    assert.equal(
      isClickHouseConfigComplete({ url: "http://localhost:8123", enabled: true }),
      true,
    );
    assert.equal(
      isClickHouseConfigComplete({ url: "http://localhost:8123", enabled: false }),
      false,
    );
  });

  it("fromEnv requires CLICKHOUSE_URL", () => {
    const prev = { ...process.env };
    delete process.env.CLICKHOUSE_URL;
    assert.equal(clickHouseConfigFromEnv({}), null);
    process.env.CLICKHOUSE_URL = "http://ch:8123";
    const c = clickHouseConfigFromEnv(process.env);
    assert.ok(c);
    assert.equal(c!.url, "http://ch:8123");
    process.env = prev;
  });

  it("writer buffers and exposes default TTL", () => {
    const w = createClickHouseWriter(
      { url: "http://localhost:8123", enabled: true, defaultTtlDays: 30 },
      { defaultTtlDays: 45 },
    );
    assert.equal(w.enabled, true);
    assert.equal(w.defaultTtlDays, 45);
    w.record({
      orgId: "local",
      sessionId: "ses_x",
      traceId: "ses_x:judge",
      kind: "generation",
      name: "steward.judge",
      input: { hi: "there" },
      output: "ok",
    });
    // No network flush in unit test — just ensure no throw on record
  });
});
