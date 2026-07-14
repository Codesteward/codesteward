import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId, nowIso } from "@codesteward/core";
import type {
  FindingReaction,
  OrgMemory,
  RepoReviewState,
} from "./types.js";

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
    input: Omit<OrgMemory, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<OrgMemory>;
  listMemories(filter?: {
    orgId?: string;
    repoId?: string;
    polarity?: "positive" | "negative";
    kind?: OrgMemory["kind"];
  }): Promise<OrgMemory[]>;
  deleteMemory(id: string): Promise<boolean>;
  /** Fingerprints / title patterns that should suppress findings. */
  negativeSuppression(opts?: {
    orgId?: string;
    repoId?: string;
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
  // Lazy import binding — resolved on first call via dynamic import cache
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
    return {
      id: m.id,
      orgId: m.orgId,
      repoId: m.repoId,
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
    };
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
      const row = await r.upsertMemory({
        id: input.id,
        orgId: input.orgId ?? "local",
        repoId: input.repoId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? input.title ?? "",
        source: input.source,
        metadata: {
          polarity: input.polarity ?? "negative",
          fingerprint: input.fingerprint,
          pattern: input.pattern,
          weight: input.weight ?? 1,
        },
        enabled: true,
      });
      return memFromDb(row);
    },

    async listMemories(filter = {}) {
      const r = await repo();
      const rows = await r.listMemories({
        orgId: filter.orgId,
        repoId: filter.repoId,
        enabled: true,
      });
      return rows
        .map(memFromDb)
        .filter((m) => {
          if (filter.polarity && m.polarity !== filter.polarity) return false;
          if (filter.kind && m.kind !== filter.kind) return false;
          return true;
        });
    },

    async deleteMemory(id) {
      const r = await repo();
      // Soft-disable via upsert when hard delete not on repository
      try {
        await r.upsertMemory({
          id,
          orgId: "local",
          kind: "preference",
          body: "",
          source: "api",
          enabled: false,
          title: "deleted",
        });
        return true;
      } catch {
        return false;
      }
    },

    async negativeSuppression(opts = {}) {
      // Multi-tenant safety: never merge orgs. Missing orgId → "local".
      const orgId = opts.orgId ?? "local";
      const memories = await api.listMemories({
        orgId,
        repoId: opts.repoId,
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
      for (const m of data.memories ?? []) memories.push(m);
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
      const mem: OrgMemory = {
        id: input.id ?? createId("mem"),
        orgId: input.orgId ?? "local",
        repoId: input.repoId,
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
      return memories.filter((m) => {
        if (filter.orgId && m.orgId !== filter.orgId) return false;
        if (filter.repoId && m.repoId && m.repoId !== filter.repoId) return false;
        if (filter.polarity && m.polarity !== filter.polarity) return false;
        if (filter.kind && m.kind !== filter.kind) return false;
        return true;
      });
    },

    async deleteMemory(id) {
      const idx = memories.findIndex((m) => m.id === id);
      if (idx < 0) return false;
      memories.splice(idx, 1);
      await save();
      return true;
    },

    async negativeSuppression(opts = {}) {
      await ensureLoaded();
      // Multi-tenant safety: never merge orgs. Missing orgId → "local".
      const orgId = opts.orgId ?? "local";
      const fps = new Set<string>();
      const patterns: string[] = [];
      for (const m of memories) {
        if (m.polarity !== "negative") continue;
        if (m.orgId !== orgId) continue;
        if (opts.repoId && m.repoId && m.repoId !== opts.repoId) continue;
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
      // Prefer composite key; fall back to legacy repoId-only for migration
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
      // Drop legacy unscoped key if it pointed at another org
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
  for (const rule of opts.ignoreRules ?? []) {
    await store.addMemory({
      orgId: opts.orgId ?? "local",
      repoId: opts.repoId,
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
