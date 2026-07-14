import { jobId, nowIso, type ReviewJob } from "@codesteward/core";
import type { Queryable } from "../client.js";
import type {
  AgentFailureLog,
  JobRecord,
  JobStatus,
  OutboxEvent,
  OutboxStatus,
  ScmDeliveryLog,
  ScmDeliveryStatus,
} from "../types.js";
import { asRecord, jsonParam, toIso, toIsoOpt } from "../util.js";

interface JobRow {
  id: string;
  session_id: string;
  status: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  available_at: Date | string;
  locked_at: Date | string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status as JobStatus,
    payload: row.payload as ReviewJob,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: toIso(row.available_at),
    lockedAt: toIsoOpt(row.locked_at),
    lockedBy: row.locked_by ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: toIsoOpt(row.completed_at),
  };
}

export class JobsRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(
    job: Omit<ReviewJob, "id" | "enqueuedAt" | "attempts"> & {
      id?: string;
      attempts?: number;
      maxAttempts?: number;
    },
  ): Promise<ReviewJob> {
    const full: ReviewJob = {
      ...job,
      id: job.id ?? jobId(),
      enqueuedAt: nowIso(),
      attempts: job.attempts ?? 0,
      tenantId: job.tenantId ?? "local",
      riskTier: job.riskTier ?? "full",
      depth: job.depth ?? "normal",
      crossRepo: job.crossRepo ?? true,
    };
    await this.db.query(
      `INSERT INTO jobs (
        id, session_id, status, payload, attempts, max_attempts,
        available_at, created_at, updated_at
      ) VALUES ($1,$2,'pending',$3::jsonb,$4,$5, now(), now(), now())`,
      [
        full.id,
        full.sessionId,
        jsonParam(full),
        full.attempts,
        job.maxAttempts ?? 5,
      ],
    );
    return full;
  }

  /**
   * Claim next pending job with SKIP LOCKED (safe multi-worker dequeue).
   * Also reclaims `running` jobs whose lease expired (worker crash mid-job).
   */
  /** Heartbeat: extend lease while a long review is still executing. */
  async touchLock(id: string, workerId: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET locked_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [id, workerId],
    );
  }

  async claim(workerId: string): Promise<ReviewJob | undefined> {
    // Default 45m — reviews often exceed 2 minutes; heartbeat extends further.
    const leaseMs = Number(process.env.STEW_JOB_LEASE_MS ?? 2_700_000);
    const res = await this.db.query<JobRow>(
      `WITH next AS (
         SELECT id FROM jobs
         WHERE available_at <= now()
           AND (
             status = 'pending'
             OR (
               status = 'running'
               AND (
                 locked_at IS NULL
                 OR locked_at < now() - ($2::text || ' milliseconds')::interval
               )
             )
           )
         ORDER BY
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
           created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j SET
         status = 'running',
         attempts = j.attempts + 1,
         locked_at = now(),
         locked_by = $1,
         updated_at = now(),
         payload = jsonb_set(j.payload, '{attempts}', to_jsonb(j.attempts + 1), true)
       FROM next
       WHERE j.id = next.id
       RETURNING j.*`,
      [workerId, String(leaseMs)],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const payload = row.payload as ReviewJob;
    return { ...payload, attempts: row.attempts };
  }

  /**
   * Claim a specific job after a broker message delivery (hybrid queue).
   * Returns undefined if already completed or owned by a live lease.
   */
  async claimById(id: string, workerId: string): Promise<ReviewJob | undefined> {
    const leaseMs = Number(process.env.STEW_JOB_LEASE_MS ?? 2_700_000);
    const res = await this.db.query<JobRow>(
      `UPDATE jobs j SET
         status = 'running',
         attempts = j.attempts + 1,
         locked_at = now(),
         locked_by = $2,
         updated_at = now(),
         payload = jsonb_set(j.payload, '{attempts}', to_jsonb(j.attempts + 1), true)
       WHERE j.id = $1
         AND (
           j.status = 'pending'
           OR (
             j.status = 'running'
             AND (
               j.locked_at IS NULL
               OR j.locked_at < now() - ($3::text || ' milliseconds')::interval
             )
           )
         )
       RETURNING j.*`,
      [id, workerId, String(leaseMs)],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const payload = row.payload as ReviewJob;
    return { ...payload, attempts: row.attempts };
  }

  async getPayload(id: string): Promise<ReviewJob | undefined> {
    const res = await this.db.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return undefined;
    return { ...(row.payload as ReviewJob), attempts: row.attempts, id: row.id };
  }

  async complete(id: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now(),
       locked_at = NULL, locked_by = NULL WHERE id = $1`,
      [id],
    );
  }

  /**
   * Reclaim jobs stuck in `running` after a worker crash/restart.
   * Returns session ids that need a fresh enqueue (lock cleared → pending).
   */
  async reclaimStale(opts: {
    leaseMs?: number;
    workerId?: string;
  } = {}): Promise<{ reclaimed: number; sessionIds: string[] }> {
    const leaseMs = opts.leaseMs ?? Number(process.env.STEW_JOB_LEASE_MS ?? 2_700_000);
    const res = await this.db.query<{ id: string; session_id: string }>(
      `UPDATE jobs SET
         status = 'pending',
         locked_at = NULL,
         locked_by = NULL,
         last_error = COALESCE(last_error, '') || ' [lease expired / worker restart]',
         available_at = now(),
         updated_at = now()
       WHERE status = 'running'
         AND (
           locked_at IS NULL
           OR locked_at < now() - ($1::text || ' milliseconds')::interval
         )
       RETURNING id, session_id`,
      [String(leaseMs)],
    );
    const sessionIds = [...new Set(res.rows.map((r) => r.session_id))];
    return { reclaimed: res.rows.length, sessionIds };
  }

  async fail(
    id: string,
    error: string,
    opts: { dead?: boolean; retryAfterMs?: number } = {},
  ): Promise<void> {
    const status: JobStatus = opts.dead ? "dead" : "pending";
    const delayMs = opts.retryAfterMs ?? 5_000;
    await this.db.query(
      `UPDATE jobs SET
         status = $2,
         last_error = $3,
         available_at = now() + ($4::text || ' milliseconds')::interval,
         locked_at = NULL,
         locked_by = NULL,
         updated_at = now(),
         completed_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
       WHERE id = $1`,
      [id, status, error, String(delayMs)],
    );
  }

  async list(status?: JobStatus): Promise<JobRecord[]> {
    if (status) {
      const res = await this.db.query<JobRow>(
        `SELECT * FROM jobs WHERE status = $1 ORDER BY created_at DESC LIMIT 200`,
        [status],
      );
      return res.rows.map(mapJob);
    }
    const res = await this.db.query<JobRow>(
      `SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`,
    );
    return res.rows.map(mapJob);
  }

  async listPendingJobs(): Promise<ReviewJob[]> {
    const res = await this.db.query<JobRow>(
      `SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC`,
    );
    return res.rows.map((r) => r.payload as ReviewJob);
  }

  // ---- Outbox ----

  async enqueueOutbox(
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<OutboxEvent> {
    const res = await this.db.query<{
      id: string;
      topic: string;
      payload: unknown;
      status: string;
      attempts: number;
      available_at: Date | string;
      published_at: Date | string | null;
      last_error: string | null;
      created_at: Date | string;
    }>(
      `INSERT INTO outbox (topic, payload, status, available_at, created_at)
       VALUES ($1, $2::jsonb, 'pending', now(), now())
       RETURNING *`,
      [topic, jsonParam(payload)],
    );
    const row = res.rows[0]!;
    return {
      id: Number(row.id),
      topic: row.topic,
      payload: asRecord(row.payload),
      status: row.status as OutboxStatus,
      attempts: row.attempts,
      availableAt: toIso(row.available_at),
      publishedAt: toIsoOpt(row.published_at),
      lastError: row.last_error ?? undefined,
      createdAt: toIso(row.created_at),
    };
  }

  async claimOutbox(limit = 20): Promise<OutboxEvent[]> {
    const res = await this.db.query<{
      id: string;
      topic: string;
      payload: unknown;
      status: string;
      attempts: number;
      available_at: Date | string;
      published_at: Date | string | null;
      last_error: string | null;
      created_at: Date | string;
    }>(
      `WITH next AS (
         SELECT id FROM outbox
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE outbox o SET attempts = o.attempts + 1
       FROM next WHERE o.id = next.id
       RETURNING o.*`,
      [limit],
    );
    return res.rows.map((row) => ({
      id: Number(row.id),
      topic: row.topic,
      payload: asRecord(row.payload),
      status: row.status as OutboxStatus,
      attempts: row.attempts,
      availableAt: toIso(row.available_at),
      publishedAt: toIsoOpt(row.published_at),
      lastError: row.last_error ?? undefined,
      createdAt: toIso(row.created_at),
    }));
  }

  async markOutboxPublished(id: number): Promise<void> {
    await this.db.query(
      `UPDATE outbox SET status = 'published', published_at = now() WHERE id = $1`,
      [id],
    );
  }

  async markOutboxFailed(id: number, error: string): Promise<void> {
    await this.db.query(
      `UPDATE outbox SET status = 'failed', last_error = $2,
       available_at = now() + interval '30 seconds' WHERE id = $1`,
      [id, error],
    );
  }

  // ---- SCM delivery idempotency ----

  /**
   * Idempotent webhook receipt. Returns existing row if delivery_id already seen.
   */
  async tryRecordDelivery(
    input: Omit<ScmDeliveryLog, "receivedAt" | "processedAt" | "status"> & {
      status?: ScmDeliveryStatus;
    },
  ): Promise<{ isNew: boolean; log: ScmDeliveryLog }> {
    const existing = await this.getDelivery(input.deliveryId);
    if (existing) return { isNew: false, log: existing };

    const res = await this.db.query<{
      delivery_id: string;
      provider: string;
      event_type: string | null;
      org_id: string | null;
      repo_id: string | null;
      payload_hash: string | null;
      status: string;
      session_id: string | null;
      job_id: string | null;
      error: string | null;
      received_at: Date | string;
      processed_at: Date | string | null;
    }>(
      `INSERT INTO scm_delivery_log (
        delivery_id, provider, event_type, org_id, repo_id, payload_hash, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING *`,
      [
        input.deliveryId,
        input.provider,
        input.eventType ?? null,
        input.orgId ?? null,
        input.repoId ?? null,
        input.payloadHash ?? null,
        input.status ?? "received",
      ],
    );
    if (res.rows[0]) {
      return { isNew: true, log: mapDelivery(res.rows[0]) };
    }
    const again = await this.getDelivery(input.deliveryId);
    if (!again) throw new Error("scm delivery race failed");
    return { isNew: false, log: again };
  }

  async getDelivery(deliveryId: string): Promise<ScmDeliveryLog | undefined> {
    const res = await this.db.query<{
      delivery_id: string;
      provider: string;
      event_type: string | null;
      org_id: string | null;
      repo_id: string | null;
      payload_hash: string | null;
      status: string;
      session_id: string | null;
      job_id: string | null;
      error: string | null;
      received_at: Date | string;
      processed_at: Date | string | null;
    }>(`SELECT * FROM scm_delivery_log WHERE delivery_id = $1`, [deliveryId]);
    const row = res.rows[0];
    return row ? mapDelivery(row) : undefined;
  }

  async markDeliveryProcessed(
    deliveryId: string,
    patch: {
      status?: ScmDeliveryStatus;
      sessionId?: string;
      jobId?: string;
      error?: string;
    } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE scm_delivery_log SET
         status = COALESCE($2, status),
         session_id = COALESCE($3, session_id),
         job_id = COALESCE($4, job_id),
         error = COALESCE($5, error),
         processed_at = now()
       WHERE delivery_id = $1`,
      [
        deliveryId,
        patch.status ?? "processed",
        patch.sessionId ?? null,
        patch.jobId ?? null,
        patch.error ?? null,
      ],
    );
  }

  // ---- Agent failures ----

  async logAgentFailure(
    input: Omit<AgentFailureLog, "id" | "createdAt">,
  ): Promise<AgentFailureLog> {
    const res = await this.db.query<{
      id: string;
      session_id: string | null;
      unit_id: string | null;
      org_id: string | null;
      repo_id: string | null;
      agent_role: string | null;
      error_class: string | null;
      message: string;
      stack: string | null;
      retriable: boolean;
      metadata: unknown;
      created_at: Date | string;
    }>(
      `INSERT INTO agent_failure_log (
        session_id, unit_id, org_id, repo_id, agent_role, error_class,
        message, stack, retriable, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      RETURNING *`,
      [
        input.sessionId ?? null,
        input.unitId ?? null,
        input.orgId ?? null,
        input.repoId ?? null,
        input.agentRole ?? null,
        input.errorClass ?? null,
        input.message,
        input.stack ?? null,
        input.retriable,
        jsonParam(input.metadata ?? {}),
      ],
    );
    const row = res.rows[0]!;
    return {
      id: Number(row.id),
      sessionId: row.session_id ?? undefined,
      unitId: row.unit_id ?? undefined,
      orgId: row.org_id ?? undefined,
      repoId: row.repo_id ?? undefined,
      agentRole: row.agent_role ?? undefined,
      errorClass: row.error_class ?? undefined,
      message: row.message,
      stack: row.stack ?? undefined,
      retriable: row.retriable,
      metadata: asRecord(row.metadata),
      createdAt: toIso(row.created_at),
    };
  }

  async listAgentFailures(filter: {
    sessionId?: string;
    repoId?: string;
    limit?: number;
  } = {}): Promise<AgentFailureLog[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      params.push(filter.sessionId);
      clauses.push(`session_id = $${params.length}`);
    }
    if (filter.repoId) {
      params.push(filter.repoId);
      clauses.push(`repo_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 100);
    const res = await this.db.query<{
      id: string;
      session_id: string | null;
      unit_id: string | null;
      org_id: string | null;
      repo_id: string | null;
      agent_role: string | null;
      error_class: string | null;
      message: string;
      stack: string | null;
      retriable: boolean;
      metadata: unknown;
      created_at: Date | string;
    }>(
      `SELECT * FROM agent_failure_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      id: Number(row.id),
      sessionId: row.session_id ?? undefined,
      unitId: row.unit_id ?? undefined,
      orgId: row.org_id ?? undefined,
      repoId: row.repo_id ?? undefined,
      agentRole: row.agent_role ?? undefined,
      errorClass: row.error_class ?? undefined,
      message: row.message,
      stack: row.stack ?? undefined,
      retriable: row.retriable,
      metadata: asRecord(row.metadata),
      createdAt: toIso(row.created_at),
    }));
  }
}

function mapDelivery(row: {
  delivery_id: string;
  provider: string;
  event_type: string | null;
  org_id: string | null;
  repo_id: string | null;
  payload_hash: string | null;
  status: string;
  session_id: string | null;
  job_id: string | null;
  error: string | null;
  received_at: Date | string;
  processed_at: Date | string | null;
}): ScmDeliveryLog {
  return {
    deliveryId: row.delivery_id,
    provider: row.provider,
    eventType: row.event_type ?? undefined,
    orgId: row.org_id ?? undefined,
    repoId: row.repo_id ?? undefined,
    payloadHash: row.payload_hash ?? undefined,
    status: row.status as ScmDeliveryStatus,
    sessionId: row.session_id ?? undefined,
    jobId: row.job_id ?? undefined,
    error: row.error ?? undefined,
    receivedAt: toIso(row.received_at),
    processedAt: toIsoOpt(row.processed_at),
  };
}
