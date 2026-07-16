/**
 * Hybrid queue republish (broker rehydrate from Postgres SoT).
 * Run: pnpm --filter @codesteward/api exec tsx --test src/__tests__/queue-republish.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import type { ReviewJob } from "@codesteward/core";
import type { JobQueue, RepublishPendingResult, QueueStatus } from "../queue.js";
import type { JobBroker } from "../queue-broker.js";

process.env.DATABASE_URL =
  process.env.DATABASE_URL?.trim() ||
  "postgres://test:test@127.0.0.1:5432/codesteward_test";

let HybridJobQueue: typeof import("../queue.js").HybridJobQueue;
let PgJobQueue: typeof import("../queue.js").PgJobQueue;

before(async () => {
  const mod = await import("../queue.js");
  HybridJobQueue = mod.HybridJobQueue;
  PgJobQueue = mod.PgJobQueue;
});

function makeJob(id: string): ReviewJob {
  return {
    id,
    sessionId: `ses_${id}`,
    mode: "gate",
    tenantId: "local",
    orgId: "local",
    repoId: "demo",
    riskTier: "full",
    depth: "normal",
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    crossRepo: true,
  };
}

function mockSot(jobs: ReviewJob[]): JobQueue {
  return {
    async enqueue() {
      throw new Error("not used");
    },
    async dequeue() {
      return undefined;
    },
    async list() {
      return [...jobs];
    },
    async load() {},
    describe() {
      return "mock-sot";
    },
  };
}

function mockBroker(opts?: {
  failIds?: Set<string>;
  kind?: "nats" | "rabbitmq" | "pulsar";
}): JobBroker & { published: ReviewJob[] } {
  const published: ReviewJob[] = [];
  const failIds = opts?.failIds ?? new Set<string>();
  return {
    kind: opts?.kind ?? "rabbitmq",
    published,
    async publish(job) {
      if (failIds.has(job.id)) throw new Error("broker down");
      published.push(job);
    },
    async consume() {
      return undefined;
    },
    async depth() {
      return published.length;
    },
    async close() {},
  };
}

describe("HybridJobQueue.republishPending", () => {
  it("re-publishes all pending jobs from SoT", async () => {
    const jobs = [makeJob("j1"), makeJob("j2"), makeJob("j3")];
    const broker = mockBroker();
    const q = new HybridJobQueue(mockSot(jobs), broker);
    const r: RepublishPendingResult = await q.republishPending();
    assert.equal(r.broker, "rabbitmq");
    assert.equal(r.pending, 3);
    assert.equal(r.published, 3);
    assert.equal(r.failed, 0);
    assert.equal(r.skipped, 0);
    assert.equal(broker.published.length, 3);
    assert.deepEqual(
      broker.published.map((j) => j.id),
      ["j1", "j2", "j3"],
    );
  });

  it("respects limit and reports skipped", async () => {
    const jobs = [makeJob("a"), makeJob("b"), makeJob("c")];
    const broker = mockBroker();
    const q = new HybridJobQueue(mockSot(jobs), broker);
    const r = await q.republishPending({ limit: 2 });
    assert.equal(r.published, 2);
    assert.equal(r.skipped, 1);
    assert.equal(r.pending, 3);
  });

  it("counts publish failures without mutating SoT list", async () => {
    const jobs = [makeJob("ok"), makeJob("bad")];
    const broker = mockBroker({ failIds: new Set(["bad"]) });
    const q = new HybridJobQueue(mockSot(jobs), broker);
    const r = await q.republishPending();
    assert.equal(r.published, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /bad/);
    assert.equal((await q.list()).length, 2);
  });

  it("status reports broker depth", async () => {
    const broker = mockBroker();
    const q = new HybridJobQueue(mockSot([makeJob("x")]), broker);
    await q.republishPending();
    const s: QueueStatus = await q.status();
    assert.equal(s.broker, "rabbitmq");
    assert.equal(s.brokerConfigured, true);
    assert.equal(s.pendingInSot, 1);
    assert.equal(s.brokerDepth, 1);
  });
});

describe("PgJobQueue methods", () => {
  it("exposes status and republishPending", () => {
    assert.equal(typeof PgJobQueue.prototype.republishPending, "function");
    assert.equal(typeof PgJobQueue.prototype.status, "function");
  });
});
