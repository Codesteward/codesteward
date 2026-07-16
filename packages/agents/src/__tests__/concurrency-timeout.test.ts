import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TimeoutError,
  mapPool,
  withTimeout,
} from "../concurrency.js";

describe("withTimeout", () => {
  it("resolves when work finishes in time", async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, "fast");
    assert.equal(v, 42);
  });

  it("rejects with TimeoutError when work is slow", async () => {
    await assert.rejects(
      () =>
        withTimeout(
          new Promise((r) => setTimeout(() => r("late"), 500)),
          30,
          "slow-op",
        ),
      (err: unknown) =>
        err instanceof TimeoutError && /slow-op timed out/.test(err.message),
    );
  });
});

describe("mapPool", () => {
  it("runs with concurrency and preserves order", async () => {
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40]);
    assert.ok(maxActive <= 2);
  });
});
