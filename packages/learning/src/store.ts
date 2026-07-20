import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId, nowIso } from "@codesteward/core";
import type {
  FindingReaction,
  LearningScope,
  OrgMemory,
  RepoReviewState,
} from "./types.js";
import {
  inferMemoryScope,
  normalizeMemoryScopeFields,
} from "./types.js";

export interface ListMemoriesFilter {
  orgId?: string;
  /** Exact repo id filter (admin UI). */
  repoId?: string;
  /** Exact PR key filter (admin UI). */
  prKey?: string;
  /** Exact scope filter (admin UI). */
  scope?: LearningScope;
  polarity?: "positive" | "negative";
  kind?: OrgMemory["kind"];
  /**
   * When true, return memories applicable to a review context:
   * org-wide + matching repo + matching PR (if prKey provided).
   * Ignores exact `scope` match; uses hierarchy instead.
   */
  applicable?: boolean;
}

export interface MoveMemoryTarget {
  scope: LearningScope;
  repoId?: string;
  prKey?: string;
  prNumber?: number;
}

export interface LearningStore {
  react(input: {
    findingId: string;
    reaction: "up" | "down" | "👍" | "👎";
    fingerprint?: string;
    orgId?: string;
    repoId?: string;
    userId?: string;
    note?: string;
  }): Promise<FindingReaction>;
  listReactions(filter?: {
    findingId?: string;
    orgId?: string;
    repoId?: string;
  }): Promise<FindingReaction[]>;
  addMemory(
    input: Omit<OrgMemory, "id" | "createdAt" | "updatedAt" | "scope"> & {
      id?: string;
      scope?: LearningScope;
      prNumber?: number;
    },
  ): Promise<OrgMemory>;
  listMemories(filter?: ListMemoriesFilter): Promise<OrgMemory[]>;
  deleteMemory(id: string): Promise<boolean>;
  /** Move a memory across org / repo / pr scopes. */
  moveMemory(id: string, target: MoveMemoryTarget): Promise<OrgMemory | undefined>;
  /** Fingerprints / title patterns that should suppress findings. */
  negativeSuppression(opts?: {
    orgId?: string;
    repoId?: string;
    prKey?: string;
  }): Promise<{ fingerprints: Set<string>; patterns: string[] }>;
  getRepoState(
    repoId: string,
    opts?: { orgId?: string },
  ): Promise<RepoReviewState | undefined>;
  setRepoState(
    state: Omit<RepoReviewState, "updatedAt"> & { updatedAt?: string },
  ): Promise<RepoReviewState>;
  persist?(): Promise<void>;
}

export interface LearningStoreOptions {
  filePath?: string;
  /** Force file backend even when DATABASE_URL is set. */
  forceFile?: boolean;
}

function normalizeReaction(
  r: "up" | "down" | "👍" | "👎",
): "up" | "down" {
  if (r === "👍" || r === "up") return "up";
  return "down";
}

function mapDbKindToReaction(kind: string): "up" | "down" {
  if (kind === "thumb_up" || kind === "up" || kind === "👍") return "up";
  return "down";
}

function ensureMemoryShape(
  m: Omit<OrgMemory, "scope"> & { scope?: LearningScope },
): OrgMemory {
  const scope = inferMemoryScope(m);
  return { ...m, scope };
}

/** Whether a memory applies to a review of repoId / prKey. */
export function memoryAppliesTo(
  m: OrgMemory,
  ctx: { repoId?: string; prKey?: string },
): boolean {
  const scope = inferMemoryScope(m);
  if (scope === "org") return true;
  if (scope === "repo") {
    if (!ctx.repoId) return false;
    return m.repoId === ctx.repoId;
  }
  // pr
  if (!ctx.prKey) return false;
  return m.prKey === ctx.prKey;
}

function filterMemories(
  memories: OrgMemory[],
  filter: ListMemoriesFilter,
): OrgMemory[] {
  return memories
    .map(ensureMemoryShape)
    .filter((m) => {
      if (filter.orgId && m.orgId !== filter.orgId) return false;
      if (filter.polarity && m.polarity !== filter.polarity) return false;
      if (filter.kind && m.kind !== filter.kind) return false;

      if (filter.applicable) {
        return memoryAppliesTo(m, {
          repoId: filter.repoId,
          prKey: filter.prKey,
        });
      }

      if (filter.scope) {
        if (inferMemoryScope(m) !== filter.scope) return false;
      }
      if (filter.repoId) {
        if (m.repoId && m.repoId !== filter.repoId) return false;
        // When filtering exact scope=repo, require repoId match (not org-wide)
        if (filter.scope === "repo" && m.repoId !== filter.repoId) return false;
      }
      if (filter.prKey && m.prKey !== filter.prKey) return false;
      return true;
    });
}

/**
 * Dual-mode learning store:
 * - Postgres via @codesteward/db when DATABASE_URL is set
 * - File JSON otherwise
 */
export function createLearningStore(opts: LearningStoreOptions = {}): LearningStore {
  const usePg =
    !opts.forceFile &&
    Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0);

  if (usePg) {
    try {
      return createPgLearningStore();
    } catch (err) {
      console.warn(
        "[learning] Postgres store init failed, falling back to file:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return createFileLearningStore(opts);
}

function createPgLearningStore(): LearningStore {
  type DbLearning = {
    addReaction: (input: {
      orgId?: string;
      tenantId?: string;
      findingId?: string;
      repoId?: string;
      kind: string;
      userId?: string;
      comment?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<{
      id: string;
      orgId: string;
      findingId?: string;
      repoId?: string;
      kind: string;
      userId?: string;
      comment?: string;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>;
    listReactions: (filter?: {
      findingId?: string;
      orgId?: string;
      repoId?: string;
    }) => Promise<
      Array<{
        id: string;
        orgId: string;
        findingId?: string;
        repoId?: string;
        kind: string;
        userId?: string;
        comment?: string;
        metadata: Record<string, unknown>;
        createdAt: string;
      }>
    >;
    upsertMemory: (input: {
      id?: string;
      orgId?: string;
      tenantId?: string;
      repoId?: string;
      kind: string;
      title?: string;
      body: string;
      source?: string;
      metadata?: Record<string, unknown>;
      enabled?: boolean;
    }) => Promise<{
      id: string;
      orgId: string;
      repoId?: string;
      kind: string;
      title?: string;
      body: string;
      source?: string;
      metadata: Record<string, unknown>;
      enabled: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
    listMemories: (filter?: {
      orgId?: string;
      repoId?: string;
      enabled?: boolean;
      limit?: number;
    }) => Promise<
      Array<{
        id: string;
        orgId: string;
        repoId?: string;
        kind: string;
        title?: string;
        body: string;
        source?: string;
        metadata: Record<string, unknown>;
        enabled: boolean;
        createdAt: string;
        updatedAt: string;
      }>
    >;
    deleteMemory?: (id: string) => Promise<boolean>;
    getMemory?: (id: string) => Promise<
      | {
          id: string;
          orgId: string;
          repoId?: string;
          kind: string;
          title?: string;
          body: string;
          source?: string;
          metadata: Record<string, unknown>;
          enabled: boolean;
          createdAt: string;
          updatedAt: string;
        }
      | undefined
    >;
    getRepoState: (
      repoId: string,
      orgId?: string,
    ) => Promise<
      | {
          repoId: string;
          orgId: string;
          lastReviewedSha?: string;
          lastSessionId?: string;
          lastPrNumber?: number;
          updatedAt: string;
        }
      | undefined
    >;
    setRepoState: (state: {
      repoId: string;
      orgId?: string;
      lastReviewedSha?: string;
      lastSessionId?: string;
      lastPrNumber?: number;
    }) => Promise<{
      repoId: string;
      orgId: string;
      lastReviewedSha?: string;
      lastSessionId?: string;
      lastPrNumber?: number;
      updatedAt: string;
    }>;
  };

  let repoPromise: Promise<DbLearning> | null = null;

  async function repo(): Promise<DbLearning> {
    if (!repoPromise) {
      repoPromise = (async () => {
        const mod = await import("@codesteward/db");
        const db = mod.tryCreateStewardDb?.() ?? mod.createStewardDb?.();
        if (!db?.learning) {
          throw new Error("DATABASE_URL set but StewardDb.learning unavailable");
        }
        return db.learning as DbLearning;
      })();
    }
    return repoPromise;
  }

  function memFromDb(m: {
    id: string;
    orgId: string;
    repoId?: string;
    kind: string;
    title?: string;
    body: string;
    source?: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }): OrgMemory {
    const polarity =
      (m.metadata.polarity as "positive" | "negative" | undefined) ??
      (m.kind === "dismissal" || m.kind === "false_positive" ? "negative" : "positive");
    const kind = (["steward_rule", "dismissal", "false_positive", "preference", "pattern"].includes(
      m.kind,
    )
      ? m.kind
      : "preference") as OrgMemory["kind"];
    const prKey =
      (m.metadata.prKey as string | undefined) ??
      (m.metadata.pr_key as string | undefined) ??
      undefined;
    const scopeMeta = m.metadata.scope as string | undefined;
    return ensureMemoryShape({
      id: m.id,
      orgId: m.orgId,
      repoId: m.repoId,
      prKey,
      scope: scopeMeta as LearningScope | undefined,
      kind,
      polarity,
      fingerprint: (m.metadata.fingerprint as string | undefined) ?? undefined,
      pattern: (m.metadata.pattern as string | undefined) ?? undefined,
      title: m.title,
      body: m.body,
      source: m.source,
      weight: typeof m.metadata.weight === "number" ? m.metadata.weight : 1,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    });
  }

  const api: LearningStore = {
    async react(input) {
      const r = await repo();
      const reactionNorm = normalizeReaction(input.reaction);
      const row = await r.addReaction({
        orgId: input.orgId ?? "local",
        findingId: input.findingId,
        repoId: input.repoId,
        kind: reactionNorm === "up" ? "thumb_up" : "thumb_down",
        userId: input.userId,
        comment: input.note,
        metadata: {
          fingerprint: input.fingerprint,
          reaction: reactionNorm,
        },
      });
      const reaction: FindingReaction = {
        id: row.id,
        findingId: input.findingId,
        fingerprint: input.fingerprint,
        orgId: input.orgId ?? "local",
        repoId: input.repoId,
        userId: input.userId,
        reaction: reactionNorm,
        note: input.note,
        createdAt: row.createdAt,
      };
      if (reactionNorm === "down" && (input.fingerprint || input.note)) {
        await api.addMemory({
          orgId: reaction.orgId,
          repoId: reaction.repoId,
          scope: reaction.repoId ? "repo" : "org",
          kind: "dismissal",
          polarity: "negative",
          fingerprint: input.fingerprint,
          pattern: input.note,
          title: input.note?.slice(0, 120),
          body: `User downvoted finding ${input.findingId}`,
          source: "reaction",
          weight: 1,
        });
      }
      if (reactionNorm === "up" && (input.fingerprint || input.note)) {
        await api.addMemory({
          orgId: reaction.orgId,
          repoId: reaction.repoId,
          scope: reaction.repoId ? "repo" : "org",
          kind: "preference",
          polarity: "positive",
          fingerprint: input.fingerprint,
          pattern: input.note,
          title: input.note?.slice(0, 120) ?? "Useful finding pattern",
          body: `User upvoted finding ${input.findingId} — prefer similar high-signal issues`,
          source: "reaction",
          weight: 1,
        });
      }
      return reaction;
    },

    async listReactions(filter = {}) {
      const r = await repo();
      const rows = await r.listReactions(filter);
      return rows.map((row) => ({
        id: row.id,
        findingId: row.findingId ?? "",
        fingerprint: row.metadata?.fingerprint as string | undefined,
        orgId: row.orgId,
        repoId: row.repoId,
        userId: row.userId,
        reaction: mapDbKindToReaction(row.kind),
        note: row.comment,
        createdAt: row.createdAt,
      }));
    },

    async addMemory(input) {
      const r = await repo();
      const scoped = normalizeMemoryScopeFields({
        scope: input.scope,
        repoId: input.repoId,
        prKey: input.prKey,
        prNumber: input.prNumber,
      });
      const row = await r.upsertMemory({
        id: input.id,
        orgId: input.orgId ?? "local",
        repoId: scoped.repoId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? input.title ?? "",
        source: input.source,
        metadata: {
          polarity: input.polarity ?? "negative",
          fingerprint: input.fingerprint,
          pattern: input.pattern,
          weight: input.weight ?? 1,
          scope: scoped.scope,
          prKey: scoped.prKey,
        },
        enabled: true,
      });
      return memFromDb(row);
    },

    async listMemories(filter = {}) {
      const r = await repo();
      // Scope / prKey live in metadata — load org slice and filter in process.
      const rows = await r.listMemories({
        orgId: filter.orgId,
        enabled: true,
        limit: 500,
      });
      return filterMemories(rows.map(memFromDb), filter);
    },

    async deleteMemory(id) {
      const r = await repo();
      if (typeof r.deleteMemory === "function") {
        return r.deleteMemory(id);
      }
      // Soft-disable fallback
      try {
        let existing: Awaited<ReturnType<NonNullable<DbLearning["getMemory"]>>> | undefined;
        if (typeof r.getMemory === "function") {
          existing = await r.getMemory(id);
        }
        await r.upsertMemory({
          id,
          orgId: existing?.orgId ?? "local",
          repoId: existing?.repoId,
          kind: existing?.kind ?? "preference",
          body: existing?.body ?? "",
          title: existing?.title ?? "deleted",
          source: existing?.source ?? "api",
          metadata: { ...(existing?.metadata ?? {}), deleted: true },
          enabled: false,
        });
        return true;
      } catch {
        return false;
      }
    },

    async moveMemory(id, target) {
      const r = await repo();
      const rows = await r.listMemories({ enabled: true, limit: 500 });
      const row = rows.find((x) => x.id === id);
      if (!row) {
        // try disabled / broader
        const all = await r.listMemories({ limit: 1000 });
        const found = all.find((x) => x.id === id);
        if (!found) return undefined;
        return movePgRow(r, found, target);
      }
      return movePgRow(r, row, target);
    },

    async negativeSuppression(opts = {}) {
      const orgId = opts.orgId ?? "local";
      const memories = await api.listMemories({
        orgId,
        repoId: opts.repoId,
        prKey: opts.prKey,
        applicable: true,
        polarity: "negative",
      });
      const reactions = await api.listReactions({
        orgId,
        repoId: opts.repoId,
      });
      const fps = new Set<string>();
      const patterns: string[] = [];
      for (const m of memories) {
        if (m.fingerprint) fps.add(m.fingerprint);
        if (m.pattern) patterns.push(m.pattern);
        if (m.title) patterns.push(m.title);
      }
      for (const r of reactions) {
        if (r.reaction === "down" && r.fingerprint) fps.add(r.fingerprint);
      }
      return { fingerprints: fps, patterns };
    },

    async getRepoState(repoId, opts) {
      const r = await repo();
      const orgId = opts?.orgId ?? "local";
      const s = await r.getRepoState(repoId, orgId);
      if (!s) return undefined;
      return {
        repoId: s.repoId,
        orgId: s.orgId,
        lastReviewedSha: s.lastReviewedSha,
        lastSessionId: s.lastSessionId,
        lastPrNumber: s.lastPrNumber,
        updatedAt: s.updatedAt,
      };
    },

    async setRepoState(state) {
      const r = await repo();
      const s = await r.setRepoState({
        repoId: state.repoId,
        orgId: state.orgId ?? "local",
        lastReviewedSha: state.lastReviewedSha,
        lastSessionId: state.lastSessionId,
        lastPrNumber: state.lastPrNumber,
      });
      return {
        repoId: s.repoId,
        orgId: s.orgId,
        lastReviewedSha: s.lastReviewedSha,
        lastSessionId: s.lastSessionId,
        lastPrNumber: s.lastPrNumber,
        updatedAt: s.updatedAt,
      };
    },
  };

  async function movePgRow(
    r: DbLearning,
    row: {
      id: string;
      orgId: string;
      repoId?: string;
      kind: string;
      title?: string;
      body: string;
      source?: string;
      metadata: Record<string, unknown>;
    },
    target: MoveMemoryTarget,
  ): Promise<OrgMemory> {
    const scoped = normalizeMemoryScopeFields(target);
    const meta = {
      ...row.metadata,
      scope: scoped.scope,
      prKey: scoped.prKey,
    };
    if (!scoped.prKey) delete meta.prKey;
    const updated = await r.upsertMemory({
      id: row.id,
      orgId: row.orgId,
      repoId: scoped.repoId,
      kind: row.kind,
      title: row.title,
      body: row.body,
      source: row.source,
      metadata: meta,
      enabled: true,
    });
    return memFromDb(updated);
  }

  return api;
}

function createFileLearningStore(opts: LearningStoreOptions = {}): LearningStore {
  const filePath =
    opts.filePath ??
    process.env.LEARNING_STORE_PATH ??
    `${process.env.STEW_DATA_DIR ?? ".steward-data"}/learning.json`;

  const reactions: FindingReaction[] = [];
  const memories: OrgMemory[] = [];
  const repoStates = new Map<string, RepoReviewState>();
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw) as {
        reactions?: FindingReaction[];
        memories?: OrgMemory[];
        repoStates?: RepoReviewState[];
      };
      for (const r of data.reactions ?? []) reactions.push(r);
      for (const m of data.memories ?? []) memories.push(ensureMemoryShape(m));
      for (const s of data.repoStates ?? []) repoStates.set(s.repoId, s);
    } catch {
      /* empty */
    }
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        {
          reactions,
          memories,
          repoStates: [...repoStates.values()],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const api: LearningStore = {
    async react(input) {
      await ensureLoaded();
      const reaction: FindingReaction = {
        id: createId("rxn"),
        findingId: input.findingId,
        fingerprint: input.fingerprint,
        orgId: input.orgId ?? "local",
        repoId: input.repoId,
        userId: input.userId,
        reaction: normalizeReaction(input.reaction),
        note: input.note,
        createdAt: nowIso(),
      };
      reactions.push(reaction);

      if (reaction.reaction === "down" && (input.fingerprint || input.note)) {
        await api.addMemory({
          orgId: reaction.orgId,
          repoId: reaction.repoId,
          scope: reaction.repoId ? "repo" : "org",
          kind: "dismissal",
          polarity: "negative",
          fingerprint: input.fingerprint,
          pattern: input.note,
          title: input.note?.slice(0, 120),
          body: `User downvoted finding ${input.findingId}`,
          source: "reaction",
          weight: 1,
        });
      }
      if (reaction.reaction === "up" && (input.fingerprint || input.note)) {
        await api.addMemory({
          orgId: reaction.orgId,
          repoId: reaction.repoId,
          scope: reaction.repoId ? "repo" : "org",
          kind: "preference",
          polarity: "positive",
          fingerprint: input.fingerprint,
          pattern: input.note,
          title: input.note?.slice(0, 120) ?? "Useful finding pattern",
          body: `User upvoted finding ${input.findingId} — prefer similar high-signal issues`,
          source: "reaction",
          weight: 1,
        });
      }
      await save();
      return reaction;
    },

    async listReactions(filter = {}) {
      await ensureLoaded();
      return reactions.filter((r) => {
        if (filter.findingId && r.findingId !== filter.findingId) return false;
        if (filter.orgId && r.orgId !== filter.orgId) return false;
        if (filter.repoId && r.repoId !== filter.repoId) return false;
        return true;
      });
    },

    async addMemory(input) {
      await ensureLoaded();
      const ts = nowIso();
      const scoped = normalizeMemoryScopeFields({
        scope: input.scope,
        repoId: input.repoId,
        prKey: input.prKey,
        prNumber: input.prNumber,
      });
      const mem: OrgMemory = {
        id: input.id ?? createId("mem"),
        orgId: input.orgId ?? "local",
        scope: scoped.scope,
        repoId: scoped.repoId,
        prKey: scoped.prKey,
        kind: input.kind,
        polarity: input.polarity ?? "negative",
        fingerprint: input.fingerprint,
        pattern: input.pattern,
        title: input.title,
        body: input.body,
        source: input.source,
        weight: input.weight ?? 1,
        createdAt: ts,
        updatedAt: ts,
      };
      memories.push(mem);
      await save();
      return mem;
    },

    async listMemories(filter = {}) {
      await ensureLoaded();
      return filterMemories(memories, filter);
    },

    async deleteMemory(id) {
      await ensureLoaded();
      const idx = memories.findIndex((m) => m.id === id);
      if (idx < 0) return false;
      memories.splice(idx, 1);
      await save();
      return true;
    },

    async moveMemory(id, target) {
      await ensureLoaded();
      const mem = memories.find((m) => m.id === id);
      if (!mem) return undefined;
      const scoped = normalizeMemoryScopeFields(target);
      mem.scope = scoped.scope;
      mem.repoId = scoped.repoId;
      mem.prKey = scoped.prKey;
      mem.updatedAt = nowIso();
      await save();
      return { ...mem };
    },

    async negativeSuppression(opts = {}) {
      await ensureLoaded();
      const orgId = opts.orgId ?? "local";
      const fps = new Set<string>();
      const patterns: string[] = [];
      for (const m of memories) {
        if (m.polarity !== "negative") continue;
        if (m.orgId !== orgId) continue;
        if (!memoryAppliesTo(ensureMemoryShape(m), { repoId: opts.repoId, prKey: opts.prKey })) {
          continue;
        }
        if (m.fingerprint) fps.add(m.fingerprint);
        if (m.pattern) patterns.push(m.pattern);
        if (m.title) patterns.push(m.title);
      }
      for (const r of reactions) {
        if (r.reaction !== "down") continue;
        if (r.orgId !== orgId) continue;
        if (opts.repoId && r.repoId && r.repoId !== opts.repoId) continue;
        if (r.fingerprint) fps.add(r.fingerprint);
      }
      return { fingerprints: fps, patterns };
    },

    async getRepoState(repoId, opts) {
      await ensureLoaded();
      const orgId = opts?.orgId ?? "local";
      return (
        repoStates.get(`${orgId}::${repoId}`) ??
        (repoStates.get(repoId)?.orgId === orgId || !repoStates.get(repoId)?.orgId
          ? repoStates.get(repoId)
          : undefined)
      );
    },

    async setRepoState(state) {
      await ensureLoaded();
      const orgId = state.orgId ?? "local";
      const next: RepoReviewState = {
        repoId: state.repoId,
        orgId,
        lastReviewedSha: state.lastReviewedSha,
        lastSessionId: state.lastSessionId,
        lastPrNumber: state.lastPrNumber,
        updatedAt: state.updatedAt ?? nowIso(),
      };
      const key = `${orgId}::${next.repoId}`;
      repoStates.set(key, next);
      const legacy = repoStates.get(next.repoId);
      if (legacy && (legacy.orgId ?? "local") !== orgId) {
        /* keep other org's legacy entry under composite only */
      } else {
        repoStates.delete(next.repoId);
      }
      await save();
      return next;
    },

    async persist() {
      await save();
    },
  };

  void ensureLoaded();
  return api;
}

/**
 * Import STEWARD.md custom guidance into org memories.
 */
export async function seedMemoriesFromSteward(
  store: LearningStore,
  opts: {
    orgId?: string;
    repoId?: string;
    ignoreRules?: string[];
    focus?: string[];
    rawStewardMd?: string;
  },
): Promise<number> {
  let n = 0;
  const scope: LearningScope = opts.repoId ? "repo" : "org";
  for (const rule of opts.ignoreRules ?? []) {
    await store.addMemory({
      orgId: opts.orgId ?? "local",
      repoId: opts.repoId,
      scope,
      kind: "steward_rule",
      polarity: "negative",
      pattern: rule,
      title: `Ignore: ${rule}`,
      body: `From STEWARD ignoreRules: ${rule}`,
      source: "STEWARD.md",
      weight: 1,
    });
    n++;
  }
  for (const focus of opts.focus ?? []) {
    await store.addMemory({
      orgId: opts.orgId ?? "local",
      repoId: opts.repoId,
      scope,
      kind: "preference",
      polarity: "positive",
      pattern: focus,
      title: `Focus: ${focus}`,
      body: `From STEWARD focus: ${focus}`,
      source: "STEWARD.md",
      weight: 0.5,
    });
    n++;
  }
  if (opts.rawStewardMd && opts.rawStewardMd.length > 40) {
    await store.addMemory({
      orgId: opts.orgId ?? "local",
      repoId: opts.repoId,
      scope,
      kind: "steward_rule",
      polarity: "positive",
      body: opts.rawStewardMd.slice(0, 4000),
      title: "STEWARD.md snapshot",
      source: "STEWARD.md",
      weight: 0.3,
    });
    n++;
  }
  return n;
}
