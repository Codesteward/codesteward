import {
  CreateSessionRequestSchema,
  nowIso,
  sessionId as newSessionId,
  type CreateSessionRequest,
  type ProgressEvent,
  type ReviewSession,
  type ReviewUnit,
} from "@codesteward/core";
import type { Queryable } from "../client.js";
import { asArray, asRecord, jsonParam, toIso, toIsoOpt } from "../util.js";

interface SessionRow {
  id: string;
  org_id: string;
  tenant_id: string;
  repo_id: string;
  repo_path: string | null;
  mode: string;
  trigger: string;
  base_sha: string | null;
  head_sha: string | null;
  base_branch: string | null;
  head_branch: string | null;
  pr_number: number | null;
  scm_provider: string | null;
  scm_full_name: string | null;
  risk_tier: string;
  depth: string;
  status: string;
  stage: string;
  verdict: string | null;
  token_usage: unknown;
  policy_snapshot_id: string | null;
  parent_session_id: string | null;
  error: string | null;
  checkpoint: unknown;
  failure_log: unknown;
  resume_attempts: number | null;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

interface UnitRow {
  id: string;
  session_id: string;
  kind: string;
  label: string;
  paths: unknown;
  symbols: unknown;
  status: string;
  assigned_roles: unknown;
  worker_id: string | null;
  error: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  attempts: number | null;
  last_strategy: string | null;
  healed: boolean | null;
  metadata: unknown;
}

function mapUnit(row: UnitRow): ReviewUnit {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as ReviewUnit["kind"],
    label: row.label,
    paths: asArray<string>(row.paths),
    symbols: asArray<string>(row.symbols),
    status: row.status as ReviewUnit["status"],
    assignedRoles: asArray<string>(row.assigned_roles),
    workerId: row.worker_id ?? undefined,
    error: row.error ?? undefined,
    startedAt: toIsoOpt(row.started_at),
    completedAt: toIsoOpt(row.completed_at),
    attempts: row.attempts ?? undefined,
    lastStrategy: (row.last_strategy as ReviewUnit["lastStrategy"]) ?? undefined,
    healed: row.healed ?? undefined,
    metadata: asRecord(row.metadata),
  };
}

function mapSession(row: SessionRow, units: ReviewUnit[] = []): ReviewSession {
  const usage = asRecord(row.token_usage);
  const checkpoint = row.checkpoint
    ? (asRecord(row.checkpoint) as ReviewSession["checkpoint"])
    : undefined;
  const failureLog = asArray(row.failure_log) as NonNullable<
    ReviewSession["failureLog"]
  >;
  return {
    id: row.id,
    orgId: row.org_id,
    tenantId: row.tenant_id,
    repoId: row.repo_id,
    repoPath: row.repo_path ?? undefined,
    mode: row.mode as ReviewSession["mode"],
    trigger: row.trigger as ReviewSession["trigger"],
    baseSha: row.base_sha ?? undefined,
    headSha: row.head_sha ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    headBranch: row.head_branch ?? undefined,
    prNumber: row.pr_number ?? undefined,
    scmProvider: row.scm_provider ?? undefined,
    scmFullName: row.scm_full_name ?? undefined,
    riskTier: row.risk_tier as ReviewSession["riskTier"],
    depth: row.depth as ReviewSession["depth"],
    status: row.status as ReviewSession["status"],
    stage: row.stage as ReviewSession["stage"],
    verdict: (row.verdict as ReviewSession["verdict"]) ?? undefined,
    units,
    tokenUsage: {
      promptTokens: Number(usage.promptTokens ?? 0),
      completionTokens: Number(usage.completionTokens ?? 0),
      totalTokens: Number(usage.totalTokens ?? 0),
      costUsd:
        usage.costUsd === undefined || usage.costUsd === null
          ? undefined
          : Number(usage.costUsd),
    },
    policySnapshotId: row.policy_snapshot_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    error: row.error ?? undefined,
    checkpoint,
    failureLog: failureLog.length ? failureLog : undefined,
    resumeAttempts: row.resume_attempts ?? undefined,
    metadata: asRecord(row.metadata),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: toIsoOpt(row.completed_at),
  };
}

export class SessionsRepository {
  constructor(private readonly db: Queryable) {}

  async create(req: CreateSessionRequest): Promise<ReviewSession> {
    const parsed = CreateSessionRequestSchema.parse(req);
    const ts = nowIso();
    const session: ReviewSession = {
      id: newSessionId(),
      orgId: parsed.orgId ?? "local",
      tenantId: parsed.tenantId ?? "local",
      repoId: parsed.repoId,
      repoPath: parsed.repoPath,
      mode: parsed.mode,
      trigger: parsed.trigger ?? "api",
      baseSha: parsed.baseSha,
      headSha: parsed.headSha,
      baseBranch: parsed.baseBranch,
      headBranch: parsed.headBranch,
      prNumber: parsed.prNumber,
      scmProvider: parsed.scmProvider,
      scmFullName: parsed.scmFullName,
      riskTier: parsed.riskTier ?? "full",
      depth: parsed.depth ?? "normal",
      status: "pending",
      stage: "queued",
      units: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metadata: parsed.metadata ?? {},
      createdAt: ts,
      updatedAt: ts,
    };
    await this.insert(session);
    return session;
  }

  async insert(session: ReviewSession): Promise<void> {
    await this.db.query(
      `INSERT INTO review_sessions (
        id, org_id, tenant_id, repo_id, repo_path, mode, trigger,
        base_sha, head_sha, base_branch, head_branch, pr_number,
        scm_provider, scm_full_name, risk_tier, depth, status, stage, verdict,
        token_usage, policy_snapshot_id, parent_session_id, error,
        checkpoint, failure_log, resume_attempts, metadata,
        created_at, updated_at, completed_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,
        $20::jsonb,$21,$22,$23,
        $24::jsonb,$25::jsonb,$26,$27::jsonb,
        $28,$29,$30
      )
      ON CONFLICT (id) DO NOTHING`,
      [
        session.id,
        session.orgId,
        session.tenantId,
        session.repoId,
        session.repoPath ?? null,
        session.mode,
        session.trigger,
        session.baseSha ?? null,
        session.headSha ?? null,
        session.baseBranch ?? null,
        session.headBranch ?? null,
        session.prNumber ?? null,
        session.scmProvider ?? null,
        session.scmFullName ?? null,
        session.riskTier,
        session.depth,
        session.status,
        session.stage,
        session.verdict ?? null,
        jsonParam(session.tokenUsage),
        session.policySnapshotId ?? null,
        session.parentSessionId ?? null,
        session.error ?? null,
        session.checkpoint ? jsonParam(session.checkpoint) : null,
        jsonParam(session.failureLog ?? []),
        session.resumeAttempts ?? 0,
        jsonParam(session.metadata),
        session.createdAt,
        session.updatedAt,
        session.completedAt ?? null,
      ],
    );
    if (session.units?.length) {
      await this.replaceUnits(session.id, session.units);
    }
  }

  async get(id: string): Promise<ReviewSession | undefined> {
    const res = await this.db.query<SessionRow>(
      `SELECT * FROM review_sessions WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const units = await this.listUnits(id);
    return mapSession(row, units);
  }

  async list(filter: {
    orgId?: string;
    repoId?: string;
    status?: string;
    limit?: number;
  } = {}): Promise<ReviewSession[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.orgId) {
      params.push(filter.orgId);
      clauses.push(`org_id = $${params.length}`);
    }
    if (filter.repoId) {
      params.push(filter.repoId);
      clauses.push(`repo_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 200);
    const res = await this.db.query<SessionRow>(
      `SELECT * FROM review_sessions ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    const sessions: ReviewSession[] = [];
    for (const row of res.rows) {
      const units = await this.listUnits(row.id);
      sessions.push(mapSession(row, units));
    }
    return sessions;
  }

  async update(
    id: string,
    patch: Partial<ReviewSession>,
  ): Promise<ReviewSession> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Session not found: ${id}`);
    const next: ReviewSession = {
      ...cur,
      ...patch,
      id: cur.id,
      updatedAt: nowIso(),
    };
    await this.db.query(
      `UPDATE review_sessions SET
        org_id = $2, tenant_id = $3, repo_id = $4, repo_path = $5,
        mode = $6, trigger = $7, base_sha = $8, head_sha = $9,
        base_branch = $10, head_branch = $11, pr_number = $12,
        scm_provider = $13, scm_full_name = $14, risk_tier = $15, depth = $16,
        status = $17, stage = $18, verdict = $19, token_usage = $20::jsonb,
        policy_snapshot_id = $21, parent_session_id = $22, error = $23,
        checkpoint = $24::jsonb, failure_log = $25::jsonb, resume_attempts = $26,
        metadata = $27::jsonb, updated_at = $28, completed_at = $29
      WHERE id = $1`,
      [
        next.id,
        next.orgId,
        next.tenantId,
        next.repoId,
        next.repoPath ?? null,
        next.mode,
        next.trigger,
        next.baseSha ?? null,
        next.headSha ?? null,
        next.baseBranch ?? null,
        next.headBranch ?? null,
        next.prNumber ?? null,
        next.scmProvider ?? null,
        next.scmFullName ?? null,
        next.riskTier,
        next.depth,
        next.status,
        next.stage,
        next.verdict ?? null,
        jsonParam(next.tokenUsage),
        next.policySnapshotId ?? null,
        next.parentSessionId ?? null,
        next.error ?? null,
        next.checkpoint ? jsonParam(next.checkpoint) : null,
        jsonParam(next.failureLog ?? []),
        next.resumeAttempts ?? 0,
        jsonParam(next.metadata),
        next.updatedAt,
        next.completedAt ?? null,
      ],
    );
    if (patch.units) {
      await this.replaceUnits(id, next.units);
    }
    return next;
  }

  async listUnits(sessionId: string): Promise<ReviewUnit[]> {
    const res = await this.db.query<UnitRow>(
      `SELECT * FROM review_units WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
    return res.rows.map(mapUnit);
  }

  async upsertUnit(unit: ReviewUnit): Promise<ReviewUnit> {
    await this.db.query(
      `INSERT INTO review_units (
        id, session_id, kind, label, paths, symbols, status, assigned_roles,
        worker_id, error, started_at, completed_at, attempts, last_strategy, healed,
        metadata, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,
        $9,$10,$11,$12,$13,$14,$15,
        $16::jsonb, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        kind = EXCLUDED.kind,
        label = EXCLUDED.label,
        paths = EXCLUDED.paths,
        symbols = EXCLUDED.symbols,
        status = EXCLUDED.status,
        assigned_roles = EXCLUDED.assigned_roles,
        worker_id = EXCLUDED.worker_id,
        error = EXCLUDED.error,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        attempts = EXCLUDED.attempts,
        last_strategy = EXCLUDED.last_strategy,
        healed = EXCLUDED.healed,
        metadata = EXCLUDED.metadata,
        updated_at = now()`,
      [
        unit.id,
        unit.sessionId,
        unit.kind,
        unit.label,
        jsonParam(unit.paths ?? []),
        jsonParam(unit.symbols ?? []),
        unit.status,
        jsonParam(unit.assignedRoles ?? []),
        unit.workerId ?? null,
        unit.error ?? null,
        unit.startedAt ?? null,
        unit.completedAt ?? null,
        unit.attempts ?? null,
        unit.lastStrategy ?? null,
        unit.healed ?? null,
        jsonParam(unit.metadata ?? {}),
      ],
    );
    return unit;
  }

  async replaceUnits(sessionId: string, units: ReviewUnit[]): Promise<void> {
    await this.db.query(`DELETE FROM review_units WHERE session_id = $1`, [
      sessionId,
    ]);
    for (const unit of units) {
      await this.upsertUnit({ ...unit, sessionId });
    }
  }

  async appendEvent(sessionId: string, event: ProgressEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO session_events (session_id, event_type, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [sessionId, event.type, jsonParam(event)],
    );
  }

  async listEvents(sessionId: string, afterId = 0): Promise<ProgressEvent[]> {
    const rows = await this.listEventsWithIds(sessionId, afterId);
    return rows.map((r) => r.event);
  }

  /** Events with durable sequence ids for multi-process SSE polling. */
  async listEventsWithIds(
    sessionId: string,
    afterId = 0,
  ): Promise<Array<{ id: number; event: ProgressEvent }>> {
    const res = await this.db.query<{ id: string | number; payload: unknown }>(
      `SELECT id, payload FROM session_events
       WHERE session_id = $1 AND id > $2
       ORDER BY id ASC`,
      [sessionId, afterId],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      event: r.payload as ProgressEvent,
    }));
  }
}
