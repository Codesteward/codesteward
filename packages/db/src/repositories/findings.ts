import {
  computeFingerprint,
  findingId,
  nowIso,
  type Finding,
  type FindingCandidate,
  type FindingStatus,
  type Severity,
} from "@codesteward/core";
import type { Queryable } from "../client.js";
import { asArray, asRecord, jsonParam, toIso } from "../util.js";

export interface FindingFilter {
  sessionId?: string;
  severity?: Severity | Severity[];
  status?: FindingStatus | FindingStatus[];
  repoId?: string;
  orgId?: string;
  pathPrefix?: string;
  fingerprint?: string;
  limit?: number;
}

interface FindingRow {
  id: string;
  session_id: string;
  org_id: string;
  repo_id: string;
  tenant_id: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  symbol_id: string | null;
  title: string;
  body: string;
  category: string;
  severity: string;
  confidence: number;
  fingerprint: string;
  status: string;
  agents: unknown;
  rule_ids: unknown;
  suggestion: string | null;
  evidence: unknown;
  verification: unknown;
  scm_comment_id: string | null;
  cross_repo_origin_repo_id: string | null;
  tags: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    sessionId: row.session_id,
    orgId: row.org_id,
    repoId: row.repo_id,
    tenantId: row.tenant_id,
    path: row.path,
    startLine: row.start_line ?? undefined,
    endLine: row.end_line ?? undefined,
    symbolId: row.symbol_id ?? undefined,
    title: row.title,
    body: row.body,
    category: row.category as Finding["category"],
    severity: row.severity as Finding["severity"],
    confidence: Number(row.confidence),
    fingerprint: row.fingerprint,
    status: row.status as Finding["status"],
    agents: asArray(row.agents) as Finding["agents"],
    ruleIds: asArray<string>(row.rule_ids),
    suggestion: row.suggestion ?? undefined,
    evidence: asArray(row.evidence) as Finding["evidence"],
    verification: row.verification
      ? (asRecord(row.verification) as Finding["verification"])
      : undefined,
    scmCommentId: row.scm_comment_id ?? undefined,
    crossRepoOriginRepoId: row.cross_repo_origin_repo_id ?? undefined,
    tags: asArray<string>(row.tags),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class FindingsRepository {
  constructor(private readonly db: Queryable) {}

  async create(
    candidate: FindingCandidate & { sessionId: string; repoId: string },
  ): Promise<Finding> {
    const fingerprint = computeFingerprint({
      path: candidate.path,
      category: candidate.category,
      ruleId: candidate.ruleIds?.[0],
      snippet: candidate.body?.slice(0, 200),
      symbolId: candidate.symbolId,
    });

    const existing = await this.findByFingerprint(fingerprint, candidate.repoId);
    if (existing && existing.sessionId === candidate.sessionId) {
      const merged: Finding = {
        ...existing,
        body: candidate.body || existing.body,
        evidence: [...existing.evidence, ...(candidate.evidence ?? [])],
        updatedAt: nowIso(),
      };
      return this.update(existing.id, merged);
    }

    const ts = nowIso();
    const finding: Finding = {
      id: findingId(),
      sessionId: candidate.sessionId,
      orgId: candidate.orgId ?? "local",
      repoId: candidate.repoId,
      tenantId: candidate.tenantId ?? "local",
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      symbolId: candidate.symbolId,
      title: candidate.title,
      body: candidate.body ?? "",
      category: candidate.category,
      severity: candidate.severity,
      confidence: candidate.confidence ?? 0.7,
      fingerprint,
      status: "open",
      agents: candidate.agents ?? [],
      ruleIds: candidate.ruleIds ?? [],
      suggestion: candidate.suggestion,
      evidence: candidate.evidence ?? [],
      verification: candidate.verification,
      scmCommentId: candidate.scmCommentId,
      crossRepoOriginRepoId: candidate.crossRepoOriginRepoId,
      tags: candidate.tags ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    await this.insert(finding);
    return finding;
  }

  async insert(finding: Finding): Promise<void> {
    await this.db.query(
      `INSERT INTO findings (
        id, session_id, org_id, repo_id, tenant_id, path, start_line, end_line,
        symbol_id, title, body, category, severity, confidence, fingerprint, status,
        agents, rule_ids, suggestion, evidence, verification, scm_comment_id,
        cross_repo_origin_repo_id, tags, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,
        $17::jsonb,$18::jsonb,$19,$20::jsonb,$21::jsonb,$22,
        $23,$24::jsonb,$25,$26
      )
      ON CONFLICT (id) DO NOTHING`,
      [
        finding.id,
        finding.sessionId,
        finding.orgId,
        finding.repoId,
        finding.tenantId,
        finding.path,
        finding.startLine ?? null,
        finding.endLine ?? null,
        finding.symbolId ?? null,
        finding.title,
        finding.body,
        finding.category,
        finding.severity,
        finding.confidence,
        finding.fingerprint,
        finding.status,
        jsonParam(finding.agents),
        jsonParam(finding.ruleIds),
        finding.suggestion ?? null,
        jsonParam(finding.evidence),
        finding.verification ? jsonParam(finding.verification) : null,
        finding.scmCommentId ?? null,
        finding.crossRepoOriginRepoId ?? null,
        jsonParam(finding.tags),
        finding.createdAt,
        finding.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<Finding | undefined> {
    const res = await this.db.query<FindingRow>(
      `SELECT * FROM findings WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapFinding(row) : undefined;
  }

  async update(id: string, patch: Partial<Finding>): Promise<Finding> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Finding not found: ${id}`);
    const next: Finding = { ...cur, ...patch, id: cur.id, updatedAt: nowIso() };
    await this.db.query(
      `UPDATE findings SET
        session_id = $2, org_id = $3, repo_id = $4, tenant_id = $5,
        path = $6, start_line = $7, end_line = $8, symbol_id = $9,
        title = $10, body = $11, category = $12, severity = $13,
        confidence = $14, fingerprint = $15, status = $16,
        agents = $17::jsonb, rule_ids = $18::jsonb, suggestion = $19,
        evidence = $20::jsonb, verification = $21::jsonb, scm_comment_id = $22,
        cross_repo_origin_repo_id = $23, tags = $24::jsonb, updated_at = $25
      WHERE id = $1`,
      [
        next.id,
        next.sessionId,
        next.orgId,
        next.repoId,
        next.tenantId,
        next.path,
        next.startLine ?? null,
        next.endLine ?? null,
        next.symbolId ?? null,
        next.title,
        next.body,
        next.category,
        next.severity,
        next.confidence,
        next.fingerprint,
        next.status,
        jsonParam(next.agents),
        jsonParam(next.ruleIds),
        next.suggestion ?? null,
        jsonParam(next.evidence),
        next.verification ? jsonParam(next.verification) : null,
        next.scmCommentId ?? null,
        next.crossRepoOriginRepoId ?? null,
        jsonParam(next.tags),
        next.updatedAt,
      ],
    );
    return next;
  }

  async transition(id: string, status: FindingStatus): Promise<Finding> {
    return this.update(id, { status });
  }

  async list(filter: FindingFilter = {}): Promise<Finding[]> {
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
    if (filter.orgId) {
      params.push(filter.orgId);
      clauses.push(`org_id = $${params.length}`);
    }
    if (filter.fingerprint) {
      params.push(filter.fingerprint);
      clauses.push(`fingerprint = $${params.length}`);
    }
    if (filter.pathPrefix) {
      params.push(`${filter.pathPrefix}%`);
      clauses.push(`path LIKE $${params.length}`);
    }
    if (filter.severity) {
      const arr = Array.isArray(filter.severity)
        ? filter.severity
        : [filter.severity];
      params.push(arr);
      clauses.push(`severity = ANY($${params.length}::text[])`);
    }
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      params.push(arr);
      clauses.push(`status = ANY($${params.length}::text[])`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 500);
    const res = await this.db.query<FindingRow>(
      `SELECT * FROM findings ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(mapFinding);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM findings WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async findByFingerprint(
    fingerprint: string,
    repoId?: string,
  ): Promise<Finding | undefined> {
    const params: unknown[] = [fingerprint];
    let sql = `SELECT * FROM findings WHERE fingerprint = $1`;
    if (repoId) {
      params.push(repoId);
      sql += ` AND repo_id = $2`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const res = await this.db.query<FindingRow>(sql, params);
    const row = res.rows[0];
    return row ? mapFinding(row) : undefined;
  }
}
