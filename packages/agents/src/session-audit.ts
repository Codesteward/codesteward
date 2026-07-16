import { createHash } from "node:crypto";
import {
  createId,
  nowIso,
  type ContextReceipt,
  type JudgeNoiseSummary,
  type SessionAudit,
  type SpecialistRun,
  type ToolTraceEntry,
  type ZeroFindingsRationale,
} from "@codesteward/core";

const MAX_TOOL_ENTRIES = 200;
const MAX_DROPPED = 50;
const MAX_FILES = 500;

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

  constructor(private readonly sessionId: string) {}

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
      status: patch.status ?? (patch.error ? "error" : "ok"),
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
    };
    this.openRuns.delete(id);
    this.runs.push(finished);
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

    let zeroFindings: ZeroFindingsRationale | undefined;
    if (opts.findingCount === 0) {
      zeroFindings = buildZeroFindingsRationale({
        context,
        runs: this.runs,
        judge: this.judge,
        emptyDiff: opts.emptyDiff,
        unitsFailed: opts.unitsFailed,
      });
    }

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
      heal: this.heal,
      completedAt: nowIso(),
    };
  }
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

export function buildZeroFindingsRationale(input: {
  context: ContextReceipt;
  runs: SpecialistRun[];
  judge?: JudgeNoiseSummary;
  emptyDiff?: boolean;
  unitsFailed?: boolean;
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
  evidence.push(
    `${input.runs.length} specialist run(s), ${okRuns.length} ok` +
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
