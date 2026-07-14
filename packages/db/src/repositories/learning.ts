import { nowIso } from "@codesteward/core";
import type { Queryable } from "../client.js";
import type {
  LearningEmbeddingMeta,
  LearningMemory,
  LearningReaction,
  LearningReactionKind,
} from "../types.js";
import {
  asNumberArray,
  asRecord,
  jsonParam,
  newEmbeddingId,
  newMemoryId,
  newReactionId,
  toIso,
} from "../util.js";

export interface RepoReviewStateRow {
  repoId: string;
  orgId: string;
  lastReviewedSha?: string;
  lastSessionId?: string;
  lastPrNumber?: number;
  updatedAt: string;
}

export class LearningRepository {
  constructor(private readonly db: Queryable) {}

  async addReaction(
    input: Omit<LearningReaction, "id" | "createdAt"> & { id?: string },
  ): Promise<LearningReaction> {
    const reaction: LearningReaction = {
      id: input.id ?? newReactionId(),
      orgId: input.orgId ?? "local",
      tenantId: input.tenantId ?? "local",
      findingId: input.findingId,
      sessionId: input.sessionId,
      repoId: input.repoId,
      kind: input.kind as LearningReactionKind,
      userId: input.userId,
      comment: input.comment,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO learning_reactions (
        id, org_id, tenant_id, finding_id, session_id, repo_id,
        kind, user_id, comment, metadata, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        reaction.id,
        reaction.orgId,
        reaction.tenantId,
        reaction.findingId ?? null,
        reaction.sessionId ?? null,
        reaction.repoId ?? null,
        reaction.kind,
        reaction.userId ?? null,
        reaction.comment ?? null,
        jsonParam(reaction.metadata),
        reaction.createdAt,
      ],
    );
    return reaction;
  }

  async listReactions(filter: {
    findingId?: string;
    repoId?: string;
    orgId?: string;
    limit?: number;
  } = {}): Promise<LearningReaction[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.findingId) {
      params.push(filter.findingId);
      clauses.push(`finding_id = $${params.length}`);
    }
    if (filter.repoId) {
      params.push(filter.repoId);
      clauses.push(`repo_id = $${params.length}`);
    }
    if (filter.orgId) {
      params.push(filter.orgId);
      clauses.push(`org_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 200);
    const res = await this.db.query<{
      id: string;
      org_id: string;
      tenant_id: string;
      finding_id: string | null;
      session_id: string | null;
      repo_id: string | null;
      kind: string;
      user_id: string | null;
      comment: string | null;
      metadata: unknown;
      created_at: Date | string;
    }>(
      `SELECT * FROM learning_reactions ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      tenantId: row.tenant_id,
      findingId: row.finding_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      repoId: row.repo_id ?? undefined,
      kind: row.kind,
      userId: row.user_id ?? undefined,
      comment: row.comment ?? undefined,
      metadata: asRecord(row.metadata),
      createdAt: toIso(row.created_at),
    }));
  }

  async upsertMemory(
    input: Omit<LearningMemory, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    },
  ): Promise<LearningMemory> {
    const ts = nowIso();
    const memory: LearningMemory = {
      id: input.id ?? newMemoryId(),
      orgId: input.orgId ?? "local",
      tenantId: input.tenantId ?? "local",
      repoId: input.repoId,
      kind: input.kind ?? "memory",
      title: input.title,
      body: input.body,
      source: input.source,
      metadata: input.metadata ?? {},
      enabled: input.enabled ?? true,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.query(
      `INSERT INTO learning_memories (
        id, org_id, tenant_id, repo_id, kind, title, body, source,
        metadata, enabled, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        repo_id = EXCLUDED.repo_id,
        kind = EXCLUDED.kind,
        body = EXCLUDED.body,
        title = EXCLUDED.title,
        source = EXCLUDED.source,
        metadata = EXCLUDED.metadata,
        enabled = EXCLUDED.enabled,
        updated_at = EXCLUDED.updated_at`,
      [
        memory.id,
        memory.orgId,
        memory.tenantId,
        memory.repoId ?? null,
        memory.kind,
        memory.title ?? null,
        memory.body,
        memory.source ?? null,
        jsonParam(memory.metadata),
        memory.enabled,
        memory.createdAt,
        memory.updatedAt,
      ],
    );
    return memory;
  }

  async getMemory(id: string): Promise<LearningMemory | undefined> {
    const res = await this.db.query<{
      id: string;
      org_id: string;
      tenant_id: string;
      repo_id: string | null;
      kind: string;
      title: string | null;
      body: string;
      source: string | null;
      metadata: unknown;
      enabled: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>(`SELECT * FROM learning_memories WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      orgId: row.org_id,
      tenantId: row.tenant_id,
      repoId: row.repo_id ?? undefined,
      kind: row.kind,
      title: row.title ?? undefined,
      body: row.body,
      source: row.source ?? undefined,
      metadata: asRecord(row.metadata),
      enabled: row.enabled,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async deleteMemory(id: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE learning_memories SET enabled = false, updated_at = now() WHERE id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listMemories(filter: {
    orgId?: string;
    repoId?: string;
    enabled?: boolean;
    limit?: number;
  } = {}): Promise<LearningMemory[]> {
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
    if (filter.enabled !== undefined) {
      params.push(filter.enabled);
      clauses.push(`enabled = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 200);
    const res = await this.db.query<{
      id: string;
      org_id: string;
      tenant_id: string;
      repo_id: string | null;
      kind: string;
      title: string | null;
      body: string;
      source: string | null;
      metadata: unknown;
      enabled: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT * FROM learning_memories ${where} ORDER BY updated_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      tenantId: row.tenant_id,
      repoId: row.repo_id ?? undefined,
      kind: row.kind,
      title: row.title ?? undefined,
      body: row.body,
      source: row.source ?? undefined,
      metadata: asRecord(row.metadata),
      enabled: row.enabled,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    }));
  }

  async storeEmbedding(
    input: Omit<LearningEmbeddingMeta, "id" | "createdAt"> & { id?: string },
  ): Promise<LearningEmbeddingMeta> {
    const meta: LearningEmbeddingMeta = {
      id: input.id ?? newEmbeddingId(),
      orgId: input.orgId ?? "local",
      tenantId: input.tenantId ?? "local",
      repoId: input.repoId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      model: input.model,
      dims: input.dims,
      embedding: input.embedding,
      contentHash: input.contentHash,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    };
    await this.db.query(
      `INSERT INTO learning_embeddings (
        id, org_id, tenant_id, repo_id, subject_type, subject_id,
        model, dims, embedding, content_hash, metadata, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12)`,
      [
        meta.id,
        meta.orgId,
        meta.tenantId,
        meta.repoId ?? null,
        meta.subjectType,
        meta.subjectId,
        meta.model,
        meta.dims,
        jsonParam(meta.embedding),
        meta.contentHash ?? null,
        jsonParam(meta.metadata),
        meta.createdAt,
      ],
    );
    return meta;
  }

  async getEmbeddings(filter: {
    subjectType?: string;
    subjectId?: string;
    orgId?: string;
    repoId?: string;
    limit?: number;
  } = {}): Promise<LearningEmbeddingMeta[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.subjectType) {
      params.push(filter.subjectType);
      clauses.push(`subject_type = $${params.length}`);
    }
    if (filter.subjectId) {
      params.push(filter.subjectId);
      clauses.push(`subject_id = $${params.length}`);
    }
    if (filter.orgId) {
      params.push(filter.orgId);
      clauses.push(`org_id = $${params.length}`);
    }
    if (filter.repoId) {
      params.push(filter.repoId);
      clauses.push(`repo_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 100);
    const res = await this.db.query<{
      id: string;
      org_id: string;
      tenant_id: string;
      repo_id: string | null;
      subject_type: string;
      subject_id: string;
      model: string;
      dims: number;
      embedding: unknown;
      content_hash: string | null;
      metadata: unknown;
      created_at: Date | string;
    }>(
      `SELECT * FROM learning_embeddings ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      tenantId: row.tenant_id,
      repoId: row.repo_id ?? undefined,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      model: row.model,
      dims: row.dims,
      embedding: asNumberArray(row.embedding),
      contentHash: row.content_hash ?? undefined,
      metadata: asRecord(row.metadata),
      createdAt: toIso(row.created_at),
    }));
  }

  async getRepoState(
    repoId: string,
    orgId = "local",
  ): Promise<RepoReviewStateRow | undefined> {
    const res = await this.db.query<{
      repo_id: string;
      org_id: string;
      last_reviewed_sha: string | null;
      last_session_id: string | null;
      last_pr_number: number | null;
      updated_at: Date | string;
    }>(
      `SELECT * FROM repo_review_state WHERE org_id = $1 AND repo_id = $2`,
      [orgId, repoId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      repoId: row.repo_id,
      orgId: row.org_id,
      lastReviewedSha: row.last_reviewed_sha ?? undefined,
      lastSessionId: row.last_session_id ?? undefined,
      lastPrNumber: row.last_pr_number ?? undefined,
      updatedAt: toIso(row.updated_at),
    };
  }

  async setRepoState(state: {
    repoId: string;
    orgId?: string;
    lastReviewedSha?: string;
    lastSessionId?: string;
    lastPrNumber?: number;
  }): Promise<RepoReviewStateRow> {
    const ts = nowIso();
    const next: RepoReviewStateRow = {
      repoId: state.repoId,
      orgId: state.orgId ?? "local",
      lastReviewedSha: state.lastReviewedSha,
      lastSessionId: state.lastSessionId,
      lastPrNumber: state.lastPrNumber,
      updatedAt: ts,
    };
    await this.db.query(
      `INSERT INTO repo_review_state (
        repo_id, org_id, last_reviewed_sha, last_session_id, last_pr_number, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (org_id, repo_id) DO UPDATE SET
        last_reviewed_sha = EXCLUDED.last_reviewed_sha,
        last_session_id = EXCLUDED.last_session_id,
        last_pr_number = EXCLUDED.last_pr_number,
        updated_at = EXCLUDED.updated_at`,
      [
        next.repoId,
        next.orgId,
        next.lastReviewedSha ?? null,
        next.lastSessionId ?? null,
        next.lastPrNumber ?? null,
        next.updatedAt,
      ],
    );
    return next;
  }
}
