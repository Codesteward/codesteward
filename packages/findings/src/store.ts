import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  computeFingerprint,
  findingId,
  nowIso,
  type Finding,
  type FindingCandidate,
  type FindingStatus,
  type Severity,
} from "@codesteward/core";

export interface FindingFilter {
  sessionId?: string;
  severity?: Severity | Severity[];
  status?: FindingStatus | FindingStatus[];
  repoId?: string;
  pathPrefix?: string;
  /** Hard multi-org isolation */
  orgId?: string;
}

export interface FindingsStore {
  create(candidate: FindingCandidate & { sessionId: string; repoId: string }): Promise<Finding>;
  get(id: string): Promise<Finding | undefined>;
  update(id: string, patch: Partial<Finding>): Promise<Finding>;
  transition(id: string, status: FindingStatus): Promise<Finding>;
  list(filter?: FindingFilter): Promise<Finding[]>;
  delete(id: string): Promise<boolean>;
  findByFingerprint(fingerprint: string, repoId?: string): Promise<Finding | undefined>;
  persist?(): Promise<void>;
}

export interface FindingsStoreOptions {
  /** Optional JSON file path for durability when not using Postgres. */
  filePath?: string;
  /**
   * Prefer Postgres when DATABASE_URL is set (default true).
   * Pass false to force in-memory/file store.
   */
  preferDb?: boolean;
  /** Optional pre-built db findings repository (from @codesteward/db). */
  dbRepo?: {
    create(
      candidate: FindingCandidate & { sessionId: string; repoId: string },
    ): Promise<Finding>;
    get(id: string): Promise<Finding | undefined>;
    update(id: string, patch: Partial<Finding>): Promise<Finding>;
    transition(id: string, status: FindingStatus): Promise<Finding>;
    list(filter?: FindingFilter): Promise<Finding[]>;
    delete(id: string): Promise<boolean>;
    findByFingerprint(
      fingerprint: string,
      repoId?: string,
    ): Promise<Finding | undefined>;
  };
}

/** Wrap a Postgres FindingsRepository as FindingsStore. */
export function createDbFindingsStore(
  repo: NonNullable<FindingsStoreOptions["dbRepo"]>,
): FindingsStore {
  return {
    create: (c) => repo.create(c),
    get: (id) => repo.get(id),
    update: (id, patch) => repo.update(id, patch),
    transition: (id, status) => repo.transition(id, status),
    list: (filter) => repo.list(filter),
    delete: (id) => repo.delete(id),
    findByFingerprint: (fp, repoId) => repo.findByFingerprint(fp, repoId),
    async persist() {
      /* durable by default */
    },
  };
}

function createMemoryFindingsStore(filePath?: string): FindingsStore {
  const byId = new Map<string, Finding>();

  const api: FindingsStore = {
    async create(candidate) {
      const fingerprint = computeFingerprint({
        path: candidate.path,
        category: candidate.category,
        ruleId: candidate.ruleIds?.[0],
        snippet: candidate.body?.slice(0, 200),
        symbolId: candidate.symbolId,
      });

      const existing = await api.findByFingerprint(fingerprint, candidate.repoId);
      if (existing && existing.sessionId === candidate.sessionId) {
        const merged: Finding = {
          ...existing,
          body: candidate.body || existing.body,
          evidence: [...existing.evidence, ...(candidate.evidence ?? [])],
          updatedAt: nowIso(),
        };
        byId.set(existing.id, merged);
        await save();
        return merged;
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
        modelConfidence: candidate.modelConfidence,
        tokenConfidence: candidate.tokenConfidence,
        fingerprint,
        status: "open",
        agents: candidate.agents ?? [],
        ruleIds: candidate.ruleIds ?? [],
        suggestion: candidate.suggestion,
        suggestedFix: candidate.suggestedFix,
        existingCode: candidate.existingCode,
        evidence: candidate.evidence ?? [],
        verification: candidate.verification,
        scmCommentId: candidate.scmCommentId,
        crossRepoOriginRepoId: candidate.crossRepoOriginRepoId,
        tags: candidate.tags ?? [],
        createdAt: ts,
        updatedAt: ts,
      };
      byId.set(finding.id, finding);
      await save();
      return finding;
    },

    async get(id) {
      return byId.get(id);
    },

    async update(id, patch) {
      const cur = byId.get(id);
      if (!cur) throw new Error(`Finding not found: ${id}`);
      const next = { ...cur, ...patch, id: cur.id, updatedAt: nowIso() };
      byId.set(id, next);
      await save();
      return next;
    },

    async transition(id, status) {
      return api.update(id, { status });
    },

    async list(filter = {}) {
      let items = [...byId.values()];
      if (filter.orgId) items = items.filter((f) => (f.orgId ?? "local") === filter.orgId);
      if (filter.sessionId) items = items.filter((f) => f.sessionId === filter.sessionId);
      if (filter.repoId) items = items.filter((f) => f.repoId === filter.repoId);
      if (filter.pathPrefix)
        items = items.filter((f) => f.path.startsWith(filter.pathPrefix!));
      if (filter.severity) {
        const set = new Set(Array.isArray(filter.severity) ? filter.severity : [filter.severity]);
        items = items.filter((f) => set.has(f.severity));
      }
      if (filter.status) {
        const set = new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
        items = items.filter((f) => set.has(f.status));
      }
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async delete(id) {
      const ok = byId.delete(id);
      if (ok) await save();
      return ok;
    },

    async findByFingerprint(fingerprint, repoId) {
      for (const f of byId.values()) {
        if (f.fingerprint === fingerprint && (!repoId || f.repoId === repoId)) return f;
      }
      return undefined;
    },

    async persist() {
      await save();
    },
  };

  async function save() {
    if (!filePath) return;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify([...byId.values()], null, 2), "utf8");
  }

  async function load() {
    if (!filePath) return;
    try {
      const raw = await readFile(filePath, "utf8");
      const arr = JSON.parse(raw) as Finding[];
      for (const f of arr) byId.set(f.id, f);
    } catch {
      // empty
    }
  }

  void load();
  return api;
}

/**
 * Create a findings store.
 * - If `dbRepo` is provided, or DATABASE_URL is set and preferDb !== false,
 *   uses Postgres via @codesteward/db (lazy import).
 * - Otherwise in-memory + optional JSON file.
 */
export function createFindingsStore(opts: FindingsStoreOptions = {}): FindingsStore {
  if (opts.dbRepo) {
    return createDbFindingsStore(opts.dbRepo);
  }

  const preferDb = opts.preferDb !== false;
  const hasDbUrl = Boolean(process.env.DATABASE_URL?.trim());

  if (preferDb && hasDbUrl) {
    // Lazy-bind to shared pool; methods await db on first use.
    return createLazyDbFindingsStore();
  }

  const filePath = opts.filePath ?? process.env.FINDINGS_STORE_PATH;
  return createMemoryFindingsStore(filePath);
}

function createLazyDbFindingsStore(): FindingsStore {
  let storePromise: Promise<FindingsStore> | undefined;

  async function resolve(): Promise<FindingsStore> {
    if (!storePromise) {
      storePromise = (async () => {
        const { createStewardDb, migrate } = await import("@codesteward/db");
        // Best-effort migrate on first use (idempotent)
        try {
          await migrate();
        } catch (err) {
          console.warn("[findings] migrate skipped/failed:", err);
        }
        const db = createStewardDb();
        return createDbFindingsStore(db.findings);
      })();
    }
    return storePromise;
  }

  return {
    async create(c) {
      return (await resolve()).create(c);
    },
    async get(id) {
      return (await resolve()).get(id);
    },
    async update(id, patch) {
      return (await resolve()).update(id, patch);
    },
    async transition(id, status) {
      return (await resolve()).transition(id, status);
    },
    async list(filter) {
      return (await resolve()).list(filter);
    },
    async delete(id) {
      return (await resolve()).delete(id);
    },
    async findByFingerprint(fp, repoId) {
      return (await resolve()).findByFingerprint(fp, repoId);
    },
    async persist() {
      return (await resolve()).persist?.();
    },
  };
}
