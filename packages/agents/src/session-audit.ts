import { createHash } from "node:crypto";
import {
  createId,
  nowIso,
  type ContextReceipt,
  type CoverageGaps,
  type JudgeNoiseSummary,
  type SessionAudit,
  type SessionTimings,
  type SpecialistRun,
  type StageTiming,
  type TimingsSummary,
  type ToolTraceEntry,
  type UnitTiming,
  type ZeroFindingsRationale,
} from "@codesteward/core";

const MAX_TOOL_ENTRIES = 200;
const MAX_DROPPED = 50;
const MAX_FILES = 500;
const MAX_UNIT_TIMINGS = 500;

export class SessionAuditCollector {
  private context: ContextReceipt | null = null;
  private runs: SpecialistRun[] = [];
  private tools: ToolTraceEntry[] = [];
  private toolErrors = 0;
  private toolsTruncated = false;
  private byTool: Record<string, number> = {};
  private judge: JudgeNoiseSummary | undefined;
  private heal:
    | { recoveredUnits?: number; failedUnits?: number; failureCount?: number }
    | undefined;
  private readonly openRuns = new Map<string, SpecialistRun>();
  private sessionStartedAt = nowIso();
  private stages: StageTiming[] = [];
  private openStage: StageTiming | null = null;
  private units: UnitTiming[] = [];

  constructor(private readonly sessionId: string) {}

  /** Mark orchestrator start (call once at beginning of run). */
  beginSession(startedAt?: string): void {
    this.sessionStartedAt = startedAt ?? nowIso();
  }

  /**
   * Enter a pipeline stage. Closes any open stage first (barrier semantics).
   */
  startStage(stage: string, message?: string): void {
    this.endStage();
    this.openStage = {
      stage,
      startedAt: nowIso(),
      message: message?.slice(0, 300),
    };
  }

  /** Close the current stage (or a named one if still open under that name). */
  endStage(stage?: string): void {
    if (!this.openStage) return;
    if (stage && this.openStage.stage !== stage) return;
    const endedAt = nowIso();
    const started = Date.parse(this.openStage.startedAt);
    const durationMs = Number.isFinite(started)
      ? Math.max(0, Date.now() - started)
      : undefined;
    this.stages.push({
      ...this.openStage,
      endedAt,
      durationMs,
    });
    this.openStage = null;
  }

  recordUnitTiming(input: {
    unitId: string;
    unitLabel?: string;
    startedAt?: string;
    endedAt?: string;
    status?: string;
    roles?: string[];
    findingCount?: number;
  }): void {
    if (this.units.length >= MAX_UNIT_TIMINGS) return;
    const startedAt = input.startedAt;
    const endedAt = input.endedAt ?? nowIso();
    let durationMs: number | undefined;
    if (startedAt) {
      const a = Date.parse(startedAt);
      const b = Date.parse(endedAt);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        durationMs = Math.max(0, b - a);
      }
    }
    // Correlate specialist runs for this unit
    const unitRuns = this.runs.filter((r) => r.unitId === input.unitId);
    const openForUnit = [...this.openRuns.values()].filter((r) => r.unitId === input.unitId);
    const all = [...unitRuns, ...openForUnit];
    const durs = all
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
    const specialistMaxMs = durs.length ? Math.max(...durs) : undefined;
    const specialistSumMs = durs.length ? durs.reduce((a, b) => a + b, 0) : undefined;
    const findingCount =
      input.findingCount ??
      unitRuns.reduce((n, r) => n + (r.findingCount ?? 0), 0);

    const row: UnitTiming = {
      unitId: input.unitId,
      unitLabel: input.unitLabel,
      startedAt,
      endedAt,
      durationMs,
      status: input.status,
      roles: input.roles,
      specialistMaxMs,
      specialistSumMs,
      findingCount,
    };
    const idx = this.units.findIndex((u) => u.unitId === input.unitId);
    if (idx >= 0) this.units[idx] = row;
    else this.units.push(row);
  }

  /** Snapshot of timings so far (for mid-run UI / checkpoints). */
  peekTimings(): SessionTimings {
    return this.buildTimings(false);
  }

  setContext(ctx: ContextReceipt): void {
    this.context = {
      ...ctx,
      filesIncluded: ctx.filesIncluded.slice(0, MAX_FILES),
      filesOmitted: ctx.filesOmitted.slice(0, MAX_FILES),
      notes: (ctx.notes ?? []).map(scrubSecrets),
      graph: ctx.graph
        ? { ...ctx.graph, message: ctx.graph.message ? scrubSecrets(ctx.graph.message) : undefined }
        : undefined,
    };
  }

  patchContext(patch: Partial<ContextReceipt>): void {
    if (!this.context) return;
    this.context = { ...this.context, ...patch };
  }

  startRun(input: {
    unitId: string;
    unitLabel?: string;
    role: string;
    runner?: SpecialistRun["runner"];
    model?: string;
    pathsReviewed?: string[];
    filesReviewed?: string[];
    stepIndex?: number;
  }): string {
    const id = createId("srun");
    const run: SpecialistRun = {
      id,
      unitId: input.unitId,
      unitLabel: input.unitLabel,
      role: input.role,
      runner: input.runner ?? "unknown",
      model: input.model,
      startedAt: nowIso(),
      status: "ok",
      findingCount: 0,
      pathsReviewed: input.pathsReviewed?.slice(0, 50),
      filesReviewed: input.filesReviewed?.slice(0, 80),
      stepIndex: input.stepIndex ?? this.runs.length + this.openRuns.size,
    };
    this.openRuns.set(id, run);
    return id;
  }

  endRun(
    id: string,
    patch: {
      status?: SpecialistRun["status"];
      findingCount?: number;
      error?: string;
      responseContent?: string;
      promptChars?: number;
      toolCallCount?: number;
      findingsSummary?: SpecialistRun["findingsSummary"];
      avgConfidence?: number;
      usedGraph?: boolean;
      filesReviewed?: string[];
      pathsReviewed?: string[];
      timedOut?: boolean;
      timeoutMs?: number;
    },
  ): void {
    const run = this.openRuns.get(id) ?? this.runs.find((r) => r.id === id);
    if (!run) return;
    const endedAt = nowIso();
    const started = Date.parse(run.startedAt);
    const durationMs = Number.isFinite(started)
      ? Math.max(0, Date.now() - started)
      : undefined;
    let responseSha256: string | undefined;
    let responseExcerpt: string | undefined;
    let completionChars: number | undefined;
    if (patch.responseContent != null) {
      const raw = patch.responseContent;
      completionChars = raw.length;
      responseSha256 = createHash("sha256").update(raw).digest("hex");
      responseExcerpt = redactExcerpt(raw.slice(0, 500));
    }
    const findingsSummary = patch.findingsSummary?.slice(0, 25).map((f) => ({
      title: scrubSecrets(f.title).slice(0, 200),
      severity: f.severity,
      confidence: f.confidence,
      modelConfidence: f.modelConfidence,
      tokenConfidence: f.tokenConfidence,
      path: f.path?.slice(0, 300),
      startLine: f.startLine,
      category: f.category,
    }));
    const finished: SpecialistRun = {
      ...run,
      endedAt,
      durationMs,
      status:
        patch.status ??
        (patch.timedOut ? "truncated" : patch.error ? "error" : "ok"),
      findingCount: patch.findingCount ?? run.findingCount,
      error: patch.error ? scrubSecrets(patch.error) : undefined,
      responseSha256,
      responseExcerpt,
      promptChars: patch.promptChars ?? run.promptChars,
      completionChars,
      toolCallCount: patch.toolCallCount ?? run.toolCallCount,
      findingsSummary: findingsSummary ?? run.findingsSummary,
      avgConfidence: patch.avgConfidence ?? run.avgConfidence,
      usedGraph: patch.usedGraph ?? run.usedGraph,
      filesReviewed: patch.filesReviewed?.slice(0, 80) ?? run.filesReviewed,
      pathsReviewed: patch.pathsReviewed?.slice(0, 50) ?? run.pathsReviewed,
      timedOut: patch.timedOut ?? run.timedOut,
      timeoutMs: patch.timeoutMs ?? run.timeoutMs,
    };
    this.openRuns.delete(id);
    // Replace if already pushed (re-end); else append
    const existingIdx = this.runs.findIndex((r) => r.id === id);
    if (existingIdx >= 0) this.runs[existingIdx] = finished;
    else this.runs.push(finished);
  }

  /**
   * Close open specialist runs matching unit+role (e.g. SimpleAgentRunner outer timeout).
   */
  endOpenRunsForUnitRole(
    unitId: string,
    role: string,
    patch: {
      status?: SpecialistRun["status"];
      findingCount?: number;
      error?: string;
      timedOut?: boolean;
      timeoutMs?: number;
    },
  ): void {
    for (const [id, run] of [...this.openRuns.entries()]) {
      if (run.unitId === unitId && run.role === role) {
        this.endRun(id, patch);
      }
    }
  }

  recordTool(entry: Omit<ToolTraceEntry, "id" | "ts"> & { id?: string; ts?: string }): void {
    const row: ToolTraceEntry = {
      id: entry.id ?? createId("tool"),
      ts: entry.ts ?? nowIso(),
      unitId: entry.unitId,
      role: entry.role,
      tool: entry.tool,
      name: entry.name,
      summary: scrubSecrets(entry.summary).slice(0, 400),
      ok: entry.ok,
      durationMs: entry.durationMs,
      detail: entry.detail,
    };
    this.byTool[row.tool] = (this.byTool[row.tool] ?? 0) + 1;
    if (!row.ok) this.toolErrors += 1;
    if (this.tools.length >= MAX_TOOL_ENTRIES) {
      this.toolsTruncated = true;
      return;
    }
    this.tools.push(row);
  }

  setJudge(j: JudgeNoiseSummary): void {
    this.judge = {
      ...j,
      dropped: j.dropped.slice(0, MAX_DROPPED),
    };
  }

  setHeal(h: {
    recoveredUnits?: number;
    failedUnits?: number;
    failureCount?: number;
  }): void {
    this.heal = h;
  }

  finalize(opts: {
    findingCount: number;
    emptyDiff?: boolean;
    unitsFailed?: boolean;
    unitsSkippedClean?: boolean;
  }): SessionAudit {
    // Flush any open runs as errors
    for (const [id] of this.openRuns) {
      this.endRun(id, { status: "error", error: "run incomplete at finalize" });
    }
    // Close open stage so total timings are complete
    this.endStage();

    const context =
      this.context ??
      ({
        repoId: "unknown",
        source: "unverified_mount" as const,
        verified: false,
        pathsRequested: [],
        pathsEffective: [],
        filesIncluded: [],
        filesOmitted: [],
        notes: ["No context receipt was recorded"],
        preparedAt: nowIso(),
      } satisfies ContextReceipt);

    const coverageGaps = buildCoverageGaps(this.runs);

    let zeroFindings: ZeroFindingsRationale | undefined;
    if (opts.findingCount === 0) {
      zeroFindings = buildZeroFindingsRationale({
        context,
        runs: this.runs,
        judge: this.judge,
        emptyDiff: opts.emptyDiff,
        unitsFailed: opts.unitsFailed,
        coverageGaps,
      });
    }

    const completedAt = nowIso();
    const timings = this.buildTimings(true, completedAt);

    return {
      version: 1,
      sessionId: this.sessionId,
      context,
      specialistRuns: this.runs,
      tools: {
        total: this.tools.length + (this.toolsTruncated ? 1 : 0),
        byTool: { ...this.byTool },
        errors: this.toolErrors,
        entries: this.tools,
        truncated: this.toolsTruncated,
      },
      judge: this.judge,
      zeroFindings,
      coverageGaps,
      heal: this.heal,
      timings,
      completedAt,
    };
  }

  private buildTimings(final: boolean, sessionEndedAt?: string): SessionTimings {
    // Include still-open stage as in-progress snapshot when not finalizing
    const stages = [...this.stages];
    if (!final && this.openStage) {
      const started = Date.parse(this.openStage.startedAt);
      stages.push({
        ...this.openStage,
        durationMs: Number.isFinite(started)
          ? Math.max(0, Date.now() - started)
          : undefined,
      });
    }

    const endedAt = sessionEndedAt ?? (final ? nowIso() : undefined);
    const startMs = Date.parse(this.sessionStartedAt);
    const endMs = endedAt ? Date.parse(endedAt) : Date.now();
    const totalDurationMs =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0, endMs - startMs)
        : undefined;

    const summary = buildTimingsSummary({
      stages,
      units: this.units,
      runs: this.runs,
      tools: this.tools,
    });

    return {
      sessionStartedAt: this.sessionStartedAt,
      sessionEndedAt: endedAt,
      totalDurationMs,
      stages,
      units: this.units,
      summary,
    };
  }
}

export function buildTimingsSummary(input: {
  stages: StageTiming[];
  units: UnitTiming[];
  runs: SpecialistRun[];
  tools: ToolTraceEntry[];
}): TimingsSummary {
  const byStageMs: Record<string, number> = {};
  for (const s of input.stages) {
    if (s.durationMs == null) continue;
    // Sum if stage appears multiple times (resume / retry)
    byStageMs[s.stage] = (byStageMs[s.stage] ?? 0) + s.durationMs;
  }

  let longestStage: string | undefined;
  let longestStageMs: number | undefined;
  for (const [stage, ms] of Object.entries(byStageMs)) {
    if (longestStageMs == null || ms > longestStageMs) {
      longestStage = stage;
      longestStageMs = ms;
    }
  }

  let longestUnitId: string | undefined;
  let longestUnitMs: number | undefined;
  for (const u of input.units) {
    if (u.durationMs == null) continue;
    if (longestUnitMs == null || u.durationMs > longestUnitMs) {
      longestUnitId = u.unitId;
      longestUnitMs = u.durationMs;
    }
  }

  let longestSpecialistRole: string | undefined;
  let longestSpecialistMs: number | undefined;
  let specialistRunsSumMs = 0;
  let specialistRunsCount = 0;
  for (const r of input.runs) {
    if (r.durationMs == null) continue;
    specialistRunsCount += 1;
    specialistRunsSumMs += r.durationMs;
    if (longestSpecialistMs == null || r.durationMs > longestSpecialistMs) {
      longestSpecialistMs = r.durationMs;
      longestSpecialistRole = r.role;
    }
  }

  let toolsSumMs = 0;
  let toolsWithMs = 0;
  for (const t of input.tools) {
    if (t.durationMs == null) continue;
    toolsSumMs += t.durationMs;
    toolsWithMs += 1;
  }

  return {
    longestStage,
    longestStageMs,
    longestUnitId,
    longestUnitMs,
    longestSpecialistRole,
    longestSpecialistMs,
    byStageMs,
    specialistsMs: byStageMs.specialists,
    verificationMs: byStageMs.verification,
    discourseMs: byStageMs.discourse,
    judgeMs: byStageMs.judge,
    proveMs: byStageMs.prove,
    publishMs: byStageMs.publish,
    graphMs: byStageMs.graph,
    planningMs: byStageMs.planning,
    policyMs: byStageMs.policy,
    specialistRunsCount: specialistRunsCount || input.runs.length,
    specialistRunsSumMs: specialistRunsCount ? specialistRunsSumMs : undefined,
    specialistRunsMaxMs: longestSpecialistMs,
    toolsCount: input.tools.length,
    toolsSumMs: toolsWithMs ? toolsSumMs : undefined,
    unitCount: input.units.length,
  };
}

/** Scrub secrets from any durable audit string (notes, errors, excerpts). */
export function scrubSecrets(s: string): string {
  return s
    .replace(/https?:\/\/[^/\s]*:[^@/\s]+@/gi, "https://***@")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/glpat-[A-Za-z0-9\-_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_KEY]")
    .replace(/x-access-token:[^@\s]+/gi, "x-access-token:***")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
}

function redactExcerpt(s: string): string {
  return scrubSecrets(s);
}

export function buildCoverageGaps(runs: SpecialistRun[]): CoverageGaps | undefined {
  const timed = runs.filter(
    (r) => r.timedOut === true || r.status === "truncated",
  );
  if (!timed.length) return undefined;
  const roles = timed.map((r) => r.role);
  const unitLabels = [
    ...new Set(timed.map((r) => r.unitLabel ?? r.unitId).filter(Boolean)),
  ];
  const criticalRolesAffected = roles.some((r) => r === "security");
  const uniqueRoles = [...new Set(roles)];
  return {
    specialistTimeouts: timed.length,
    roles,
    unitLabels,
    criticalRolesAffected,
    message:
      `${timed.length} specialist run(s) timed out (${uniqueRoles.join(", ")})` +
      (criticalRolesAffected ? " — includes security" : "") +
      ". Those roles did **not** complete a clean scan; do not interpret missing findings as a clean pass for timed-out roles.",
  };
}

export function buildZeroFindingsRationale(input: {
  context: ContextReceipt;
  runs: SpecialistRun[];
  judge?: JudgeNoiseSummary;
  emptyDiff?: boolean;
  unitsFailed?: boolean;
  coverageGaps?: CoverageGaps;
}): ZeroFindingsRationale {
  const evidence: string[] = [];
  evidence.push(
    `Code source: ${input.context.source}${input.context.verified ? " (SHA verified)" : " (SHA not verified)"}`,
  );
  if (input.context.repoPath) evidence.push(`repoPath: ${input.context.repoPath}`);
  if (input.context.pathsEffective?.length)
    evidence.push(`${input.context.pathsEffective.length} effective path(s)`);
  if (input.context.filesIncluded?.length)
    evidence.push(
      `${input.context.filesIncluded.length} file(s) in context` +
        (input.context.estimatedTokens != null
          ? ` · ~${input.context.estimatedTokens} tokens`
          : ""),
    );
  if (input.context.graph?.degraded)
    evidence.push(`Graph degraded: ${input.context.graph.message ?? "unavailable"}`);
  else if (input.context.graph?.mock) evidence.push("Graph mock mode");
  else if (input.context.graph?.lastBuild)
    evidence.push(`Graph last_build: ${input.context.graph.lastBuild}`);

  const okRuns = input.runs.filter((r) => r.status === "ok");
  const timedRuns = input.runs.filter(
    (r) => r.timedOut === true || r.status === "truncated",
  );
  evidence.push(
    `${input.runs.length} specialist run(s), ${okRuns.length} ok` +
      (timedRuns.length ? `, ${timedRuns.length} timed out` : "") +
      (input.runs.length
        ? ` · roles: ${[...new Set(input.runs.map((r) => r.role))].join(", ")}`
        : ""),
  );

  if (input.emptyDiff) {
    return {
      reason: "empty_diff",
      message:
        "0 findings: empty or missing diff/context — review had little or no code to inspect.",
      evidence,
    };
  }
  if (
    input.context.source === "unverified_mount" &&
    !input.context.filesIncluded?.length &&
    !input.context.pathsEffective?.length
  ) {
    return {
      reason: "context_missing",
      message:
        "0 findings: code context may be missing or bound to an unverified local mount — treat as incomplete review.",
      evidence,
    };
  }
  // Timeouts before "all clean" — never claim a clean pass when a role did not finish
  if (input.coverageGaps?.specialistTimeouts || timedRuns.length) {
    const roles = input.coverageGaps?.roles?.length
      ? [...new Set(input.coverageGaps.roles)]
      : [...new Set(timedRuns.map((r) => r.role))];
    evidence.push(...timedRuns.map((r) => `TIMEOUT ${r.role} on ${r.unitLabel ?? r.unitId}`));
    return {
      reason: "specialist_timeouts",
      message:
        `0 product findings, but ${roles.join(", ")} specialist(s) **timed out** — ` +
        "this is **not** a clean empty scan for those roles. Coverage is incomplete.",
      evidence,
    };
  }
  if (input.unitsFailed) {
    return {
      reason: "units_failed",
      message:
        "0 findings: one or more review units failed or were skipped after errors — not a clean pass.",
      evidence,
    };
  }
  if (input.judge && input.judge.inputCount > 0 && input.judge.outputCount === 0) {
    evidence.push(
      `Judge dropped all ${input.judge.inputCount} candidate(s)` +
        (input.judge.dropped[0]
          ? ` (e.g. ${input.judge.dropped[0].reason})`
          : ""),
    );
    return {
      reason: "all_candidates_dropped",
      message:
        "0 findings: specialists produced candidates but judge/noise filtered all of them.",
      evidence,
    };
  }
  if (input.runs.length > 0 && okRuns.length === input.runs.length) {
    return {
      reason: "all_units_clean",
      message: `0 findings after ${okRuns.length} successful specialist run(s) — no issues above the severity floor.`,
      evidence,
    };
  }
  return {
    reason: "unknown",
    message: "0 findings recorded; see audit evidence for what ran.",
    evidence,
  };
}
