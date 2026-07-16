/**
 * Self-healing for review units: retry, backoff, fallback runner, split, skip.
 * Checkpoints persist unit results + partial findings for resume after crash.
 */
import {
  createId,
  nowIso,
  unitId,
  type AgentFailureLogEntry,
  type FindingCandidate,
  type HealStrategy,
  type ProgressEvent,
  type ReviewJob,
  type ReviewUnit,
  type SessionCheckpointSummary,
  type SessionStage,
} from "@codesteward/core";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SelfHealConfig {
  /** Max heal attempts per unit (strategies applied in order). Default 3. */
  maxUnitRetries: number;
  /** Base delay for exponential backoff (ms). Default 500. */
  baseBackoffMs: number;
  /** Cap on backoff delay (ms). Default 30_000. */
  maxBackoffMs: number;
  /** Allow splitting multi-path units. Default true. */
  enableSplit: boolean;
  /** Min paths required to attempt split. Default 2. */
  minPathsToSplit: number;
  /** Session-level resume attempts before total failure. Default 3. */
  maxGlobalRetries: number;
  /** Zero-delay for tests. */
  noSleep?: boolean;
}

export const DEFAULT_SELF_HEAL_CONFIG: SelfHealConfig = {
  maxUnitRetries: Number(process.env.STEW_UNIT_MAX_RETRIES ?? 3),
  baseBackoffMs: Number(process.env.STEW_HEAL_BASE_BACKOFF_MS ?? 500),
  maxBackoffMs: Number(process.env.STEW_HEAL_MAX_BACKOFF_MS ?? 30_000),
  enableSplit: process.env.STEW_HEAL_SPLIT !== "0",
  minPathsToSplit: 2,
  maxGlobalRetries: Number(process.env.STEW_GLOBAL_MAX_RETRIES ?? 3),
};

/** Ordered strategies tried after each unit crash. */
export const HEAL_STRATEGY_ORDER: HealStrategy[] = [
  "retry_fresh_context",
  "fallback_simple_runner",
  "split_unit",
  "skip_with_gap_note",
];

export function resolveSelfHealConfig(
  partial?: Partial<SelfHealConfig>,
): SelfHealConfig {
  return { ...DEFAULT_SELF_HEAL_CONFIG, ...partial };
}

// ---------------------------------------------------------------------------
// Backoff / strategy selection
// ---------------------------------------------------------------------------

/** Exponential backoff: base * 2^(attempt-1), capped, with ±20% jitter. */
export function computeBackoffMs(
  attempt: number,
  config: SelfHealConfig = DEFAULT_SELF_HEAL_CONFIG,
): number {
  const exp = Math.max(0, attempt - 1);
  const raw = config.baseBackoffMs * 2 ** exp;
  const capped = Math.min(raw, config.maxBackoffMs);
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pick the next heal strategy not yet used for this unit.
 * `split_unit` is skipped when unit has too few paths or split is disabled.
 */
export function nextHealStrategy(
  used: HealStrategy[],
  unit: ReviewUnit,
  config: SelfHealConfig = DEFAULT_SELF_HEAL_CONFIG,
): HealStrategy | null {
  for (const s of HEAL_STRATEGY_ORDER) {
    if (used.includes(s)) continue;
    if (s === "split_unit") {
      if (!config.enableSplit) continue;
      if ((unit.paths?.length ?? 0) < config.minPathsToSplit) continue;
    }
    return s;
  }
  return null;
}

/**
 * Split a multi-path unit into smaller units (half paths each).
 * Returned units inherit roles/session; parent is marked for replacement.
 */
export function splitReviewUnit(unit: ReviewUnit): ReviewUnit[] {
  const paths = unit.paths ?? [];
  if (paths.length < 2) return [unit];
  const mid = Math.ceil(paths.length / 2);
  const chunks = [paths.slice(0, mid), paths.slice(mid)].filter((c) => c.length);
  return chunks.map((group, i) => ({
    id: unitId(),
    sessionId: unit.sessionId,
    kind: unit.kind,
    label: `${unit.label}-split-${i + 1}`,
    paths: group,
    symbols: unit.symbols ?? [],
    status: "pending" as const,
    assignedRoles: unit.assignedRoles ?? [],
    attempts: 0,
    metadata: {
      ...(unit.metadata ?? {}),
      splitFrom: unit.id,
      parentLabel: unit.label,
    },
  }));
}

/** Info finding noting that a unit was skipped after max heal retries. */
export function coverageGapFinding(input: {
  sessionId: string;
  unit: ReviewUnit;
  error: string;
  repoId: string;
  tenantId?: string;
}): FindingCandidate {
  const path = input.unit.paths[0] ?? ".";
  return {
    sessionId: input.sessionId,
    repoId: input.repoId,
    tenantId: input.tenantId ?? "local",
    path,
    title: "Review coverage gap",
    body: [
      `Unit **${input.unit.label}** could not be completed after self-heal retries.`,
      ``,
      `Paths: ${input.unit.paths.length ? input.unit.paths.join(", ") : "(none)"}`,
      `Last error: ${input.error}`,
      ``,
      `This is an informational note — other units completed and their findings were still published.`,
    ].join("\n"),
    category: "reliability",
    severity: "info",
    confidence: 1,
    agents: ["coordinator"],
    tags: ["coverage-gap", "self-heal"],
  };
}

export function makeFailureLogEntry(input: {
  sessionId: string;
  unit: ReviewUnit;
  attempt: number;
  error: unknown;
  strategy?: HealStrategy;
  recovered?: boolean;
}): AgentFailureLogEntry {
  return {
    id: createId("afl"),
    sessionId: input.sessionId,
    unitId: input.unit.id,
    unitLabel: input.unit.label,
    attempt: input.attempt,
    strategy: input.strategy,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    recovered: input.recovered ?? false,
    ts: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Checkpoint persistence (.steward-data/checkpoints/{sessionId}.json)
// ---------------------------------------------------------------------------

export interface SessionCheckpointPayload {
  sessionId: string;
  job: ReviewJob;
  stage: SessionStage;
  units: ReviewUnit[];
  /** Serialized finding candidates from completed units. */
  candidates: FindingCandidate[];
  completedUnitIds: string[];
  failedUnitIds: string[];
  skippedUnitIds: string[];
  /** Per-unit strategies already applied. */
  strategiesUsed: Record<string, HealStrategy[]>;
  /** agent_failure_log */
  failureLog: AgentFailureLogEntry[];
  partialFindingCount: number;
  lastUnitId?: string;
  updatedAt: string;
}

export function checkpointDataDir(): string {
  return (
    process.env.STEW_CHECKPOINT_DIR ??
    `${process.env.STEW_DATA_DIR ?? ".steward-data"}/checkpoints`
  );
}

/** Synthetic unit id (legacy); session payloads use session_checkpoints table. */
const SESSION_CHECKPOINT_STAGE = "session";

function sessionCheckpointUnitId(sessionId: string): string {
  return `__session__:${sessionId}`;
}

type DbCheckpointFacade = {
  save(input: {
    unitId: string;
    sessionId: string;
    stage: string;
    cursor?: Record<string, unknown>;
    state?: Record<string, unknown>;
  }): Promise<unknown>;
  saveSession?(input: {
    sessionId: string;
    stage: string;
    cursor?: Record<string, unknown>;
    state?: Record<string, unknown>;
  }): Promise<unknown>;
  getSessionStage?(
    sessionId: string,
    stage: string,
  ): Promise<{ sessionId: string; state: Record<string, unknown>; id: string } | undefined>;
  getByUnitStage(
    unitId: string,
    stage: string,
  ): Promise<{ sessionId: string; state: Record<string, unknown>; id: string } | undefined>;
  listForSession(sessionId: string): Promise<Array<{ id: string; state: Record<string, unknown> }>>;
  delete(id: string): Promise<boolean>;
};

async function tryDbCheckpoints(): Promise<DbCheckpointFacade | null> {
  if (process.env.DATABASE_URL == null || process.env.DATABASE_URL === "") {
    return null;
  }
  try {
    // Optional: packages/db when DATABASE_URL is configured
    const mod = (await import("@codesteward/db")) as {
      tryCreateStewardDb?: () => { checkpoints: DbCheckpointFacade } | undefined;
      createStewardDb?: () => { checkpoints: DbCheckpointFacade };
    };
    const db = mod.tryCreateStewardDb?.() ?? mod.createStewardDb?.();
    if (!db?.checkpoints) return null;
    return db.checkpoints;
  } catch {
    return null;
  }
}

/**
 * Checkpoint store: prefers packages/db (`session_checkpoints`) when DATABASE_URL
 * is set; always mirrors to `.steward-data/checkpoints/{sessionId}.json`.
 */
export class CheckpointStore {
  private readonly dir: string;
  private dbFacade: DbCheckpointFacade | null | undefined;

  constructor(dir?: string) {
    this.dir = dir ?? checkpointDataDir();
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private async db(): Promise<DbCheckpointFacade | null> {
    if (this.dbFacade !== undefined) return this.dbFacade;
    this.dbFacade = await tryDbCheckpoints();
    return this.dbFacade;
  }

  async save(payload: SessionCheckpointPayload): Promise<void> {
    const next: SessionCheckpointPayload = {
      ...payload,
      updatedAt: nowIso(),
      partialFindingCount: payload.candidates.length,
    };

    const db = await this.db();
    if (db) {
      try {
        const cursor = {
          stage: next.stage,
          completedUnitIds: next.completedUnitIds,
          lastUnitId: next.lastUnitId,
        };
        const state = next as unknown as Record<string, unknown>;
        // Prefer session_checkpoints (no unit FK); fall back to save() which routes synthetics
        if (db.saveSession) {
          await db.saveSession({
            sessionId: payload.sessionId,
            stage: SESSION_CHECKPOINT_STAGE,
            cursor,
            state,
          });
        } else {
          await db.save({
            unitId: sessionCheckpointUnitId(payload.sessionId),
            sessionId: payload.sessionId,
            stage: SESSION_CHECKPOINT_STAGE,
            cursor,
            state,
          });
        }
      } catch (err) {
        console.warn(
          "[self-heal] db checkpoint save failed, using file only:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const file = this.pathFor(payload.sessionId);
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2), "utf8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "";
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Cannot write checkpoint ${file}: permission denied. ` +
            `Ensure STEW_DATA_DIR (${this.dir}) is writable by the process user, ` +
            `or rebuild the app image so docker-entrypoint can chown the volume.`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  async load(sessionId: string): Promise<SessionCheckpointPayload | null> {
    const db = await this.db();
    if (db) {
      try {
        const row =
          (db.getSessionStage
            ? await db.getSessionStage(sessionId, SESSION_CHECKPOINT_STAGE)
            : undefined) ??
          (await db.getByUnitStage(
            sessionCheckpointUnitId(sessionId),
            SESSION_CHECKPOINT_STAGE,
          ));
        if (row?.state && "units" in row.state && "job" in row.state) {
          return row.state as unknown as SessionCheckpointPayload;
        }
      } catch {
        /* fall through to file */
      }
    }

    try {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      return JSON.parse(raw) as SessionCheckpointPayload;
    } catch {
      return null;
    }
  }

  async delete(sessionId: string): Promise<void> {
    const db = await this.db();
    if (db) {
      try {
        const row =
          (db.getSessionStage
            ? await db.getSessionStage(sessionId, SESSION_CHECKPOINT_STAGE)
            : undefined) ??
          (await db.getByUnitStage(
            sessionCheckpointUnitId(sessionId),
            SESSION_CHECKPOINT_STAGE,
          ));
        if (row?.id) await db.delete(row.id);
        // Also clear any unit-level rows for this session
        const rows = await db.listForSession(sessionId);
        for (const r of rows) await db.delete(r.id);
      } catch {
        /* ignore */
      }
    }
    try {
      await unlink(this.pathFor(sessionId));
    } catch {
      /* missing is fine */
    }
  }

  async listSessionIds(): Promise<string[]> {
    const ids = new Set<string>();
    try {
      await mkdir(this.dir, { recursive: true });
      const files = await readdir(this.dir);
      for (const f of files) {
        if (f.endsWith(".json")) ids.add(f.replace(/\.json$/, ""));
      }
    } catch {
      /* empty */
    }
    return [...ids];
  }

  async listIncomplete(): Promise<SessionCheckpointPayload[]> {
    const ids = await this.listSessionIds();
    const out: SessionCheckpointPayload[] = [];
    for (const id of ids) {
      const cp = await this.load(id);
      if (!cp) continue;
      const hasPending = cp.units.some(
        (u) =>
          u.status === "pending" || u.status === "running" || u.status === "failed",
      );
      const stageDone =
        cp.stage === "completed" || cp.stage === "failed" || cp.stage === "cancelled";
      if (!stageDone || hasPending) out.push(cp);
    }
    return out;
  }
}

export const globalCheckpointStore = new CheckpointStore();

export function toCheckpointSummary(
  payload: SessionCheckpointPayload,
): SessionCheckpointSummary {
  return {
    stage: payload.stage,
    completedUnitIds: payload.completedUnitIds,
    failedUnitIds: payload.failedUnitIds,
    skippedUnitIds: payload.skippedUnitIds,
    lastUnitId: payload.lastUnitId,
    partialFindingCount: payload.partialFindingCount,
    updatedAt: payload.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Unit execution with healing
// ---------------------------------------------------------------------------

export interface HealableUnitRunner {
  run(unit: ReviewUnit, opts: { freshContext: boolean; useSimpleRunner: boolean }): Promise<FindingCandidate[]>;
}

export interface RunUnitWithHealInput {
  sessionId: string;
  unit: ReviewUnit;
  runner: HealableUnitRunner;
  config?: Partial<SelfHealConfig>;
  onEvent?: (event: ProgressEvent) => void | Promise<void>;
  onFailureLog?: (entry: AgentFailureLogEntry) => void | Promise<void>;
  /** Called when split produces child units to re-queue. */
  onSplit?: (parent: ReviewUnit, children: ReviewUnit[]) => void | Promise<void>;
}

export interface RunUnitWithHealResult {
  unit: ReviewUnit;
  findings: FindingCandidate[];
  failureLog: AgentFailureLogEntry[];
  /** Child units when split strategy applied (parent should not be re-run). */
  splitChildren?: ReviewUnit[];
  recovered: boolean;
  strategyUsed?: HealStrategy;
}

/**
 * Execute a unit with ordered self-heal strategies on crash.
 */
export async function runUnitWithHeal(
  input: RunUnitWithHealInput,
): Promise<RunUnitWithHealResult> {
  const config = resolveSelfHealConfig(input.config);
  const failureLog: AgentFailureLogEntry[] = [];
  const used: HealStrategy[] = [];
  let unit: ReviewUnit = {
    ...input.unit,
    status: "running",
    startedAt: input.unit.startedAt ?? nowIso(),
  };
  let useSimpleRunner = false;
  let freshContext = false;
  let lastError = "unknown";
  let recovered = false;
  let lastStrategy: HealStrategy | undefined;
  let splitChildren: ReviewUnit[] | undefined;

  const emit = async (event: ProgressEvent) => {
    await input.onEvent?.(event);
  };

  // First attempt is not a "heal" — just run. Subsequent crashes pick strategies.
  let attempt = unit.attempts ?? 0;

  for (;;) {
    attempt += 1;
    unit = { ...unit, attempts: attempt, status: "running" };

    try {
      const findings = await input.runner.run(unit, {
        freshContext,
        useSimpleRunner,
      });
      unit = {
        ...unit,
        status: "completed",
        completedAt: nowIso(),
        error: undefined,
        healed: recovered || attempt > 1,
        lastStrategy,
      };

      if (unit.healed && lastStrategy) {
        await emit({
          type: "unit_recovered",
          sessionId: input.sessionId,
          unitId: unit.id,
          label: unit.label,
          strategy: lastStrategy,
          attempt,
          ts: nowIso(),
        });
        // Mark last failure as recovered
        const last = failureLog[failureLog.length - 1];
        if (last) last.recovered = true;
      }

      return {
        unit,
        findings,
        failureLog,
        recovered: Boolean(unit.healed),
        strategyUsed: lastStrategy,
        splitChildren,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      unit = {
        ...unit,
        status: "failed",
        error: lastError,
        completedAt: nowIso(),
      };

      const strategy = nextHealStrategy(used, unit, config);
      const entry = makeFailureLogEntry({
        sessionId: input.sessionId,
        unit,
        attempt,
        error: err,
        strategy: strategy ?? undefined,
      });
      failureLog.push(entry);
      await input.onFailureLog?.(entry);

      if (!strategy || attempt >= config.maxUnitRetries) {
        // Terminal skip with coverage gap
        const skipStrategy: HealStrategy = "skip_with_gap_note";
        if (!used.includes(skipStrategy)) {
          used.push(skipStrategy);
          await emit({
            type: "healing",
            sessionId: input.sessionId,
            unitId: unit.id,
            strategy: skipStrategy,
            attempt,
            message: `Skipping unit after ${attempt} attempt(s): ${lastError}`,
            ts: nowIso(),
          });
        }
        unit = {
          ...unit,
          status: "skipped",
          lastStrategy: skipStrategy,
          completedAt: nowIso(),
          error: lastError,
        };
        const gap = coverageGapFinding({
          sessionId: input.sessionId,
          unit,
          error: lastError,
          repoId: (unit.metadata?.repoId as string) ?? "unknown",
        });
        return {
          unit,
          findings: [gap],
          failureLog,
          recovered: false,
          strategyUsed: skipStrategy,
        };
      }

      used.push(strategy);
      lastStrategy = strategy;
      unit = { ...unit, lastStrategy: strategy };

      await emit({
        type: "healing",
        sessionId: input.sessionId,
        unitId: unit.id,
        strategy,
        attempt,
        message: `Applying ${strategy} after: ${lastError}`,
        ts: nowIso(),
      });

      if (strategy === "split_unit") {
        const children = splitReviewUnit(unit);
        if (children.length > 1) {
          splitChildren = children;
          unit = {
            ...unit,
            status: "skipped",
            lastStrategy: strategy,
            completedAt: nowIso(),
            error: `Split into ${children.length} units after failure: ${lastError}`,
          };
          await input.onSplit?.(unit, children);
          await emit({
            type: "unit",
            sessionId: input.sessionId,
            unitId: unit.id,
            label: unit.label,
            status: "skipped",
            ts: nowIso(),
          });
          return {
            unit,
            findings: [],
            failureLog,
            recovered: false,
            strategyUsed: strategy,
            splitChildren: children,
          };
        }
        // Fall through: couldn't split; try next strategy immediately
        continue;
      }

      if (strategy === "fallback_simple_runner") {
        useSimpleRunner = true;
      }
      if (strategy === "retry_fresh_context") {
        freshContext = true;
      }
      if (strategy === "skip_with_gap_note") {
        unit = {
          ...unit,
          status: "skipped",
          lastStrategy: strategy,
          completedAt: nowIso(),
        };
        const gap = coverageGapFinding({
          sessionId: input.sessionId,
          unit,
          error: lastError,
          repoId: (unit.metadata?.repoId as string) ?? "unknown",
        });
        return {
          unit,
          findings: [gap],
          failureLog,
          recovered: false,
          strategyUsed: strategy,
        };
      }

      const delayMs = config.noSleep ? 0 : computeBackoffMs(attempt, config);
      await emit({
        type: "retry",
        sessionId: input.sessionId,
        unitId: unit.id,
        label: unit.label,
        attempt,
        maxAttempts: config.maxUnitRetries,
        delayMs,
        strategy,
        message: `Retrying unit in ${delayMs}ms`,
        ts: nowIso(),
      });
      await sleep(delayMs);
      recovered = true; // mark intent; confirmed only on success
    }
  }
}

// ---------------------------------------------------------------------------
// Partial-failure SCM summary
// ---------------------------------------------------------------------------

export interface HealPublishStats {
  totalUnits: number;
  completedUnits: number;
  recoveredUnits: number;
  skippedUnits: number;
  failedUnits: number;
  failureLog: AgentFailureLogEntry[];
}

export function buildPartialReviewSummary(input: {
  job: ReviewJob;
  findings: Array<{
    path?: string;
    startLine?: number;
    title: string;
    severity: string;
  }>;
  stats: HealPublishStats;
  sessionStatus: "completed" | "completed_with_errors" | "failed";
}): string {
  const { job, findings, stats, sessionStatus } = input;
  const lines: string[] = [
    `## CodeSteward Review`,
    ``,
  ];

  if (sessionStatus === "failed") {
    lines.push(
      `> **Review failed** — no units completed after recovery attempts.`,
      ``,
      stats.failureLog.length
        ? `Last errors:\n${stats.failureLog
            .slice(-5)
            .map((f) => `- \`${f.unitLabel ?? f.unitId}\`: ${f.error}`)
            .join("\n")}`
        : "",
      ``,
      `_Session ${job.sessionId}_`,
    );
    return lines.filter(Boolean).join("\n");
  }

  if (sessionStatus === "completed_with_errors") {
    lines.push(
      `> ⚠️ **Completed with partial coverage** — some units needed recovery or were skipped.`,
      ``,
    );
  }

  lines.push(
    `**Findings:** ${findings.length}`,
    `**Mode:** ${job.mode}`,
    `**Tier:** ${job.riskTier}`,
    ``,
    `### Coverage`,
    `| Units | Count |`,
    `| --- | ---: |`,
    `| Reviewed | ${stats.completedUnits} |`,
    `| Recovered (self-heal) | ${stats.recoveredUnits} |`,
    `| Coverage gaps (skipped) | ${stats.skippedUnits} |`,
    `| Total planned | ${stats.totalUnits} |`,
    ``,
  );

  if (stats.skippedUnits > 0) {
    const gaps = stats.failureLog
      .filter((f) => !f.recovered)
      .slice(-10);
    if (gaps.length) {
      lines.push(`### Remaining gaps`);
      for (const g of gaps) {
        lines.push(`- **${g.unitLabel ?? g.unitId}**: ${g.error}`);
      }
      lines.push(``);
    }
  }

  lines.push(
    findings.length
      ? findings
          .slice(0, 30)
          .map(
            (f, i) =>
              `${i + 1}. **[${f.severity}]** ${f.title} (\`${f.path ?? "?"}:${f.startLine ?? "?"}\`)`,
          )
          .join("\n")
      : "_No high-signal findings._",
    ``,
    `_Generated by CodeSteward · session ${job.sessionId}_`,
  );

  return lines.join("\n");
}

/** True if session should resume (incomplete units or mid-pipeline stage). */
export function isSessionResumable(input: {
  status: string;
  stage?: string;
  units?: ReviewUnit[];
  resumeAttempts?: number;
  maxGlobalRetries?: number;
}): boolean {
  const max = input.maxGlobalRetries ?? DEFAULT_SELF_HEAL_CONFIG.maxGlobalRetries;
  if ((input.resumeAttempts ?? 0) >= max) return false;
  if (input.status === "completed" || input.status === "completed_with_errors") {
    return false;
  }
  if (input.status === "cancelled") return false;
  if (input.status === "failed") {
    // Failed sessions may resume if we have partial units
    const units = input.units ?? [];
    return units.some((u) => u.status === "completed" || u.status === "pending");
  }
  if (input.status === "running" || input.status === "pending") {
    const stage = input.stage ?? "";
    if (stage === "completed" || stage === "cancelled") return false;
    return true;
  }
  return false;
}
