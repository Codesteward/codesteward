import {
  CreateSessionRequestSchema,
  linkId,
  nowIso,
  sessionId,
  type CreateSessionRequest,
  type CrossRepoLink,
  type ProgressEvent,
  type ReviewSession,
} from "@codesteward/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DATA_DIR = process.env.STEW_DATA_DIR ?? ".steward-data";

/**
 * Session + cross-repo link + progress event store.
 * File-backed by default; Postgres when DATABASE_URL is set (see createSessionStore).
 */
export class SessionStore {
  protected sessions = new Map<string, ReviewSession>();
  protected links = new Map<string, CrossRepoLink>();
  protected events = new Map<string, ProgressEvent[]>();
  protected listeners = new Map<string, Set<(e: ProgressEvent) => void>>();
  protected readonly sessionsPath: string;
  protected readonly linksPath: string;
  protected loaded = false;

  constructor(dataDir = DATA_DIR) {
    this.sessionsPath = `${dataDir}/sessions.json`;
    this.linksPath = `${dataDir}/links.json`;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      const arr = JSON.parse(raw) as ReviewSession[];
      for (const s of arr) this.sessions.set(s.id, s);
    } catch {
      /* empty */
    }
    try {
      const raw = await readFile(this.linksPath, "utf8");
      const arr = JSON.parse(raw) as CrossRepoLink[];
      for (const l of arr) this.links.set(l.id, l);
    } catch {
      /* empty */
    }
  }

  protected async saveSessions() {
    await mkdir(dirname(this.sessionsPath), { recursive: true });
    await writeFile(
      this.sessionsPath,
      JSON.stringify([...this.sessions.values()], null, 2),
      "utf8",
    );
  }

  protected async saveLinks() {
    await mkdir(dirname(this.linksPath), { recursive: true });
    await writeFile(
      this.linksPath,
      JSON.stringify([...this.links.values()], null, 2),
      "utf8",
    );
  }

  create(req: CreateSessionRequest): ReviewSession {
    const parsed = CreateSessionRequestSchema.parse(req);
    const ts = nowIso();
    const session: ReviewSession = {
      id: sessionId(),
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
    this.sessions.set(session.id, session);
    this.events.set(session.id, []);
    void this.saveSessions();
    return session;
  }

  get(id: string): ReviewSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Fresh read for multi-process (API + worker). File store reloads disk;
   * PgSessionStore overrides to hit Postgres for one session.
   */
  async getLive(id: string): Promise<ReviewSession | undefined> {
    await this.reload();
    return this.get(id);
  }

  update(id: string, patch: Partial<ReviewSession>): ReviewSession {
    const cur = this.sessions.get(id);
    if (!cur) throw new Error(`Session not found: ${id}`);
    const next = { ...cur, ...patch, id: cur.id, updatedAt: nowIso() };
    this.sessions.set(id, next);
    void this.saveSessions();
    return next;
  }

  list(filter?: { orgId?: string }): ReviewSession[] {
    let items = [...this.sessions.values()];
    if (filter?.orgId) {
      items = items.filter((s) => (s.orgId ?? "local") === filter.orgId);
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Fresh list for multi-process UI polling. */
  async listLive(filter?: { orgId?: string }): Promise<ReviewSession[]> {
    await this.reload();
    return this.list(filter);
  }

  pushEvent(sessionId: string, event: ProgressEvent) {
    const arr = this.events.get(sessionId) ?? [];
    arr.push(event);
    this.events.set(sessionId, arr);
    for (const fn of this.listeners.get(sessionId) ?? []) fn(event);
  }

  getEvents(sessionId: string): ProgressEvent[] {
    return this.events.get(sessionId) ?? [];
  }

  /**
   * Events written after `afterId` (Postgres sequence id). File store has no
   * durable events — returns in-memory only with synthetic ids.
   */
  async listEventsSince(
    sessionId: string,
    afterId = 0,
  ): Promise<Array<{ id: number; event: ProgressEvent }>> {
    const arr = this.events.get(sessionId) ?? [];
    // In-memory events have no durable id; synthesize from index+1
    return arr
      .map((event, i) => ({ id: i + 1, event }))
      .filter((row) => row.id > afterId);
  }

  subscribe(sessionId: string, fn: (e: ProgressEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  addLink(
    input: Omit<CrossRepoLink, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): CrossRepoLink {
    const ts = nowIso();
    const link: CrossRepoLink = {
      id: input.id ?? linkId(),
      orgId: input.orgId ?? "local",
      fromRepoId: input.fromRepoId,
      toRepoId: input.toRepoId,
      edgeType: input.edgeType ?? "depends_on_api",
      pathFilters: input.pathFilters ?? { from: [], to: [] },
      fromRepoPath: input.fromRepoPath,
      toRepoPath: input.toRepoPath,
      hints: input.hints ?? {},
      maxDepth: input.maxDepth ?? 2,
      tokenBudget: input.tokenBudget ?? 50_000,
      enabled: input.enabled ?? true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.links.set(link.id, link);
    void this.saveLinks();
    return link;
  }

  listLinks(): CrossRepoLink[] {
    return [...this.links.values()];
  }

  deleteLink(id: string): boolean {
    const ok = this.links.delete(id);
    if (ok) void this.saveLinks();
    return ok;
  }

  /** Reload sessions from disk (worker multi-process). */
  async reload() {
    this.loaded = false;
    await this.load();
  }
}

/**
 * Postgres-backed session store with in-memory cache for SSE listeners.
 * Same surface as SessionStore; mutations write through to DB.
 */
export class PgSessionStore extends SessionStore {
  private dbReady: Promise<void> | undefined;
  private db:
    | import("@codesteward/db").StewardDb
    | undefined;

  constructor() {
    super(DATA_DIR);
  }

  private async ensureDb() {
    if (!this.dbReady) {
      this.dbReady = (async () => {
        const { createStewardDb, migrate } = await import("@codesteward/db");
        try {
          await migrate();
        } catch (err) {
          console.warn("[api] db migrate failed:", err);
        }
        this.db = createStewardDb();
      })();
    }
    await this.dbReady;
    return this.db!;
  }

  override async load() {
    if (this.loaded) return;
    const db = await this.ensureDb();
    const sessions = await db.sessions.list({ limit: 500 });
    this.sessions.clear();
    for (const s of sessions) this.sessions.set(s.id, s);
    const links = await db.links.list();
    this.links.clear();
    for (const l of links) this.links.set(l.id, l);
    this.loaded = true;
  }

  override async reload() {
    this.loaded = false;
    // keep event listeners; refresh durable state
    await this.load();
  }

  override async getLive(id: string): Promise<ReviewSession | undefined> {
    const db = await this.ensureDb();
    const s = await db.sessions.get(id);
    if (s) this.sessions.set(s.id, s);
    return s;
  }

  override async listLive(filter?: { orgId?: string }): Promise<ReviewSession[]> {
    const db = await this.ensureDb();
    const sessions = await db.sessions.list({
      orgId: filter?.orgId,
      limit: 500,
    });
    for (const s of sessions) this.sessions.set(s.id, s);
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  override async listEventsSince(
    sessionId: string,
    afterId = 0,
  ): Promise<Array<{ id: number; event: ProgressEvent }>> {
    const db = await this.ensureDb();
    // Durable SoT so API SSE sees worker-written events (multi-process)
    const durable = await db.sessions.listEventsWithIds(sessionId, afterId);
    if (durable.length) {
      const arr = this.events.get(sessionId) ?? [];
      for (const row of durable) {
        if (!arr.some((e) => e.ts === row.event.ts && e.type === row.event.type)) {
          arr.push(row.event);
        }
      }
      this.events.set(sessionId, arr);
    }
    return durable;
  }

  override create(req: CreateSessionRequest): ReviewSession {
    const parsed = CreateSessionRequestSchema.parse(req);
    const ts = nowIso();
    const session: ReviewSession = {
      id: sessionId(),
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
    this.sessions.set(session.id, session);
    this.events.set(session.id, []);
    void this.ensureDb().then((db) => db.sessions.insert(session));
    return session;
  }

  override update(id: string, patch: Partial<ReviewSession>): ReviewSession {
    const cur = this.sessions.get(id);
    if (!cur) throw new Error(`Session not found: ${id}`);
    const next = { ...cur, ...patch, id: cur.id, updatedAt: nowIso() };
    this.sessions.set(id, next);
    void this.ensureDb().then((db) => db.sessions.update(id, patch));
    return next;
  }

  override pushEvent(sessionId: string, event: ProgressEvent) {
    super.pushEvent(sessionId, event);
    void this.ensureDb().then((db) => db.sessions.appendEvent(sessionId, event));
  }

  override getEvents(sessionId: string): ProgressEvent[] {
    const cached = this.events.get(sessionId);
    if (cached?.length) return cached;
    // Fire async hydrate for subsequent SSE reconnects
    void this.ensureDb()
      .then((db) => db.sessions.listEvents(sessionId))
      .then((evs) => {
        if (evs.length) this.events.set(sessionId, evs);
      });
    return cached ?? [];
  }

  override addLink(
    input: Omit<CrossRepoLink, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): CrossRepoLink {
    const link = super.addLink(input);
    // super wrote to file paths — skip; write DB
    void this.ensureDb().then((db) => db.links.add(link));
    return link;
  }

  override deleteLink(id: string): boolean {
    const ok = this.links.delete(id);
    if (ok) void this.ensureDb().then((db) => db.links.delete(id));
    return ok;
  }

  protected override async saveSessions() {
    /* no-op: Postgres is SoT */
  }

  protected override async saveLinks() {
    /* no-op: Postgres is SoT */
  }
}

export function createSessionStore(): SessionStore {
  if (process.env.DATABASE_URL?.trim()) {
    return new PgSessionStore();
  }
  return new SessionStore();
}

export const globalSessionStore = createSessionStore();
