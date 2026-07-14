import { jobId, nowIso, type ReviewJob } from "@codesteward/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

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
}

const defaultQueuePath = () =>
  process.env.JOB_QUEUE_PATH ??
  `${process.env.STEW_DATA_DIR ?? ".steward-data"}/jobs.json`;

/** In-memory + file-backed queue for demo (NATS when NATS_URL set in worker). */
export class FileJobQueue implements JobQueue {
  private jobs: ReviewJob[] = [];
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultQueuePath();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.jobs = JSON.parse(raw) as ReviewJob[];
    } catch {
      this.jobs = [];
    }
  }

  private async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.jobs, null, 2), "utf8");
  }

  async enqueue(partial: EnqueueJob): Promise<ReviewJob> {
    await this.load();
    const job: ReviewJob = {
      ...partial,
      id: partial.id ?? jobId(),
      enqueuedAt: nowIso(),
      attempts: 0,
      tenantId: partial.tenantId ?? "local",
      riskTier: partial.riskTier ?? "full",
      depth: partial.depth ?? "normal",
      crossRepo: partial.crossRepo ?? true,
    };
    this.jobs.push(job);
    await this.save();
    return job;
  }

  async dequeue(): Promise<ReviewJob | undefined> {
    await this.load();
    const job = this.jobs.shift();
    if (job) {
      job.attempts += 1;
      await this.save();
    }
    return job;
  }

  async list(): Promise<ReviewJob[]> {
    await this.load();
    return [...this.jobs];
  }
}

/** Postgres jobs table with FOR UPDATE SKIP LOCKED claim. */
export class PgJobQueue implements JobQueue {
  private dbReady: Promise<import("@codesteward/db").StewardDb> | undefined;
  private readonly workerId =
    process.env.STEW_WORKER_ID ?? `worker_${randomBytes(4).toString("hex")}`;

  getWorkerId(): string {
    return this.workerId;
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

  /** Reclaim stale running locks so interrupted sessions can be resumed. */
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
    // Only *pending* jobs block re-enqueue. Stale `running` rows are reclaimed
    // separately — including them here permanently prevented resume after crash.
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

export function createJobQueue(): JobQueue {
  if (process.env.DATABASE_URL?.trim()) {
    return new PgJobQueue();
  }
  return new FileJobQueue();
}

export const globalQueue = createJobQueue();
