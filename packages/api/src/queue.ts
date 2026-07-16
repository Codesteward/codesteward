import type { ReviewJob } from "@codesteward/core";
import { randomBytes } from "node:crypto";
import {
  createJobBroker,
  resolveBrokerKind,
  type ConsumedJob,
  type JobBroker,
} from "./queue-broker.js";

export type EnqueueJob = Omit<ReviewJob, "id" | "enqueuedAt" | "attempts" | "crossRepo"> & {
  id?: string;
  crossRepo?: boolean;
};

export interface JobQueue {
  enqueue(job: EnqueueJob): Promise<ReviewJob>;
  dequeue(): Promise<ReviewJob | undefined>;
  list(): Promise<ReviewJob[]>;
  load(): Promise<void>;
  complete?(id: string): Promise<void>;
  fail?(id: string, error: string): Promise<void>;
  /** Optional: reclaim crashed worker locks (Postgres). */
  reclaimStale?(leaseMs?: number): Promise<{ reclaimed: number; sessionIds: string[] }>;
  /** Optional: extend lease while job is running. */
  touchLock?(id: string): Promise<void>;
  /** Optional: claim a known job id (broker delivery). */
  claimById?(id: string): Promise<ReviewJob | undefined>;
  /** Diagnostics */
  describe?(): string;
}

/** Postgres jobs table with FOR UPDATE SKIP LOCKED claim. */
export class PgJobQueue implements JobQueue {
  private dbReady: Promise<import("@codesteward/db").StewardDb> | undefined;
  private readonly workerId =
    process.env.STEW_WORKER_ID ?? `worker_${randomBytes(4).toString("hex")}`;

  getWorkerId(): string {
    return this.workerId;
  }

  describe() {
    return `postgres(worker=${this.workerId})`;
  }

  private async db() {
    if (!this.dbReady) {
      this.dbReady = (async () => {
        const { createStewardDb, migrate } = await import("@codesteward/db");
        try {
          await migrate();
        } catch (err) {
          console.warn("[queue] migrate failed:", err);
        }
        return createStewardDb();
      })();
    }
    return this.dbReady;
  }

  async load() {
    await this.db();
  }

  async enqueue(partial: EnqueueJob): Promise<ReviewJob> {
    const db = await this.db();
    return db.jobs.enqueue({
      ...partial,
      tenantId: partial.tenantId ?? "local",
      riskTier: partial.riskTier ?? "full",
      depth: partial.depth ?? "normal",
      crossRepo: partial.crossRepo ?? true,
    });
  }

  async dequeue(): Promise<ReviewJob | undefined> {
    const db = await this.db();
    return db.jobs.claim(this.workerId);
  }

  async claimById(id: string): Promise<ReviewJob | undefined> {
    const db = await this.db();
    return db.jobs.claimById(id, this.workerId);
  }

  async reclaimStale(leaseMs?: number): Promise<{ reclaimed: number; sessionIds: string[] }> {
    const db = await this.db();
    return db.jobs.reclaimStale({ leaseMs, workerId: this.workerId });
  }

  async touchLock(id: string): Promise<void> {
    const db = await this.db();
    await db.jobs.touchLock(id, this.workerId);
  }

  async list(): Promise<ReviewJob[]> {
    const db = await this.db();
    return db.jobs.listPendingJobs();
  }

  async listPendingSessionIds(): Promise<Set<string>> {
    const pending = await this.list();
    return new Set(pending.map((j) => j.sessionId));
  }

  async complete(id: string): Promise<void> {
    const db = await this.db();
    await db.jobs.complete(id);
  }

  async fail(id: string, error: string): Promise<void> {
    const db = await this.db();
    const rows = await db.jobs.list();
    const row = rows.find((r) => r.id === id);
    const dead = row ? row.attempts >= row.maxAttempts : false;
    await db.jobs.fail(id, error, { dead, retryAfterMs: 5_000 });
  }
}

/**
 * Durable Postgres SoT + optional broker for dispatch / KEDA.
 * - enqueue: write SoT first, then publish (best-effort)
 * - dequeue: prefer broker; claim ownership in SoT; fall back to SoT claim
 * - complete/fail: SoT + broker ack
 */
export class HybridJobQueue implements JobQueue {
  private readonly pending = new Map<string, ConsumedJob>();

  constructor(
    private readonly base: JobQueue,
    private readonly broker: JobBroker,
  ) {}

  describe() {
    const base = this.base.describe?.() ?? "base";
    return `hybrid(${base}+${this.broker.kind})`;
  }

  async load() {
    await this.base.load();
  }

  async enqueue(partial: EnqueueJob): Promise<ReviewJob> {
    const job = await this.base.enqueue(partial);
    try {
      await this.broker.publish(job);
    } catch (err) {
      console.warn(
        `[queue] broker publish failed (${this.broker.kind}); job ${job.id} remains in SoT for poll claim:`,
        err instanceof Error ? err.message : err,
      );
    }
    return job;
  }

  async dequeue(): Promise<ReviewJob | undefined> {
    // 1) Broker wake-up (skip stale/owned messages)
    try {
      for (let i = 0; i < 8; i++) {
        const msg = await this.broker.consume(i === 0 ? 800 : 50);
        if (!msg) break;
        let claimed: ReviewJob | undefined;
        if (this.base.claimById) {
          claimed = await this.base.claimById(msg.job.id);
        } else {
          claimed = msg.job;
        }
        if (!claimed) {
          // Already done / owned — drop broker message and try next
          await msg.ack().catch(() => undefined);
          continue;
        }
        this.pending.set(claimed.id, msg);
        return claimed;
      }
    } catch (err) {
      console.warn(
        `[queue] broker consume failed (${this.broker.kind}):`,
        err instanceof Error ? err.message : err,
      );
    }
    // 2) SoT poll (minimal setup, recovery after crash, broker outage)
    return this.base.dequeue();
  }

  async list(): Promise<ReviewJob[]> {
    return this.base.list();
  }

  async reclaimStale(leaseMs?: number) {
    return this.base.reclaimStale?.(leaseMs) ?? { reclaimed: 0, sessionIds: [] as string[] };
  }

  async touchLock(id: string) {
    await this.base.touchLock?.(id);
  }

  async claimById(id: string) {
    return this.base.claimById?.(id);
  }

  async complete(id: string) {
    await this.base.complete?.(id);
    const msg = this.pending.get(id);
    this.pending.delete(id);
    await msg?.ack().catch(() => undefined);
  }

  async fail(id: string, error: string) {
    await this.base.fail?.(id, error);
    const msg = this.pending.get(id);
    this.pending.delete(id);
    // PG owns retry schedule — ack broker so we don't double-deliver while pending
    await msg?.ack().catch(() => undefined);
  }

  async closeBroker() {
    await this.broker.close();
  }
}

/**
 * Job source of truth is always Postgres (`DATABASE_URL`).
 * A file-backed queue is intentionally not supported — it pins state to the
 * process filesystem and breaks horizontal scale / restarts.
 */
function createSoTQueue(): PgJobQueue {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      "DATABASE_URL is required for the review job queue. " +
        "Postgres is the only supported job SoT (FOR UPDATE SKIP LOCKED). " +
        "Optional STEW_QUEUE_BROKER=nats|rabbitmq|pulsar only wakes workers; it does not store jobs.",
    );
  }
  return new PgJobQueue();
}

/**
 * Factory:
 * - SoT: Postgres only (`DATABASE_URL` required).
 * - Optional broker: STEW_QUEUE_BROKER=nats|rabbitmq|pulsar (or infer from NATS_URL /
 *   RABBITMQ_URL / PULSAR_URL). Hybrid keeps Postgres + publishes for KEDA wake-up.
 */
export function createJobQueue(): JobQueue {
  const sot = createSoTQueue();
  // Synchronous factory used at module load — broker attaches lazily on first load()/enqueue
  return new LazyHybridJobQueue(sot);
}

/**
 * Defers broker connect until load() so import doesn't fail without optional packages.
 */
class LazyHybridJobQueue implements JobQueue {
  private inner: JobQueue;
  private init: Promise<void> | undefined;

  constructor(private readonly sot: JobQueue) {
    this.inner = sot;
  }

  private async ensure() {
    if (this.init) return this.init;
    this.init = (async () => {
      const kind = resolveBrokerKind();
      if (!kind) {
        this.inner = this.sot;
        console.info(`[queue] SoT only: ${this.sot.describe?.() ?? "sot"}`);
        return;
      }
      const broker = await createJobBroker();
      if (!broker) {
        this.inner = this.sot;
        console.warn(
          `[queue] STEW_QUEUE_BROKER=${kind} requested but broker unavailable — SoT only (${this.sot.describe?.()})`,
        );
        return;
      }
      this.inner = new HybridJobQueue(this.sot, broker);
      console.info(`[queue] ${this.inner.describe?.()}`);
    })();
    return this.init;
  }

  describe() {
    return this.inner.describe?.() ?? "lazy";
  }

  async load() {
    await this.ensure();
    await this.inner.load();
  }

  async enqueue(job: EnqueueJob) {
    await this.ensure();
    return this.inner.enqueue(job);
  }

  async dequeue() {
    await this.ensure();
    return this.inner.dequeue();
  }

  async list() {
    await this.ensure();
    return this.inner.list();
  }

  async complete(id: string) {
    await this.ensure();
    await this.inner.complete?.(id);
  }

  async fail(id: string, error: string) {
    await this.ensure();
    await this.inner.fail?.(id, error);
  }

  async reclaimStale(leaseMs?: number) {
    await this.ensure();
    return this.inner.reclaimStale?.(leaseMs) ?? { reclaimed: 0, sessionIds: [] as string[] };
  }

  async touchLock(id: string) {
    await this.ensure();
    await this.inner.touchLock?.(id);
  }

  async claimById(id: string) {
    await this.ensure();
    return this.inner.claimById?.(id);
  }
}

export const globalQueue = createJobQueue();
