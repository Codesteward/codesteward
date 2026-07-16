import type { AgentRole, FindingCandidate } from "@codesteward/core";
import { TimeoutError } from "./concurrency.js";
import type { SessionAuditCollector } from "./session-audit.js";
import {
  emitSpecialistProgress,
  type SpecialistProgressSink,
} from "./specialist-progress.js";

export function isTimeoutError(err: unknown): err is TimeoutError {
  return (
    err instanceof TimeoutError ||
    (err instanceof Error &&
      (err.name === "TimeoutError" || /timed out after \d+ms/i.test(err.message)))
  );
}

export function timeoutMsFromError(err: unknown): number | undefined {
  if (err instanceof TimeoutError) return err.timeoutMs;
  if (err instanceof Error) {
    const m = /timed out after (\d+)ms/i.exec(err.message);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Explicit coverage-gap finding so a timed-out specialist is never mistaken for
 * "role looked and found nothing." Severity is elevated for security.
 */
export function specialistTimeoutGapFinding(input: {
  role: string;
  unitLabel?: string;
  unitPaths?: string[];
  sessionId?: string;
  repoId?: string;
  timeoutMs: number;
  durationMs?: number;
  runner?: string;
}): FindingCandidate {
  const path = input.unitPaths?.[0] || ".";
  const budgetSec = Math.round(input.timeoutMs / 1000);
  const ranSec =
    input.durationMs != null ? Math.round(input.durationMs / 1000) : budgetSec;
  const isSecurity = input.role === "security";
  return {
    title: `Coverage gap: “${input.role}” specialist timed out (incomplete review)`,
    body: [
      `**Do not treat this unit as fully reviewed by ${input.role}.**`,
      `The ${input.role} specialist did **not** complete analysis within the product timeout ` +
        `(~${budgetSec}s budget` +
        (input.unitLabel ? `, unit \`${input.unitLabel}\`` : "") +
        `). It ran ~${ranSec}s then was aborted.`,
      "This is **not** an empty scan and **not** evidence that the code is free of " +
        `${input.role} issues. No trustworthy findings from this role for this unit.`,
      "Sibling specialists may still have produced findings on the same paths — that does not replace this role.",
      "Mitigations: raise `STEW_SPECIALIST_TIMEOUT_MS`, lower `STEW_MAX_SPECIALISTS_PER_UNIT` / `STEW_MAX_CONCURRENT`, or shrink the unit batch.",
    ].join("\n\n"),
    path,
    category: isSecurity ? "security" : "other",
    // High for security so gate/UI cannot bury "we didn't finish looking"
    severity: isSecurity ? "high" : "medium",
    confidence: 0.95,
    modelConfidence: undefined,
    agents: [input.role as AgentRole],
    ruleIds: ["steward.specialist_timeout"],
    suggestion:
      "Re-run this review (or the timed-out unit) with a higher specialist timeout before relying on a clean result for this role.",
    reasoning:
      `TIMEOUT (not empty-scan): product budget ${budgetSec}s, elapsed ~${ranSec}s. ` +
      "Partial DeepAgents tool traces are not recovered after abort.",
    sessionId: input.sessionId,
    repoId: input.repoId,
    tags: [
      "coverage-gap",
      "specialist-timeout",
      "incomplete-review",
      `role:${input.role}`,
      "not-empty-scan",
    ],
    evidence: [
      {
        id: `timeout-${input.role}-${Date.now()}`,
        type: "policy" as const,
        summary: `INCOMPLETE: ${input.role} specialist timed out after ${ranSec}s — not a clean empty scan`,
        payload: {
          role: input.role,
          unitLabel: input.unitLabel,
          timeoutMs: input.timeoutMs,
          durationMs: input.durationMs,
          runner: input.runner,
          emptyScan: false,
          completeReview: false,
        },
      },
    ],
  };
}

/** Audit findingsSummary row so ledger never shows "No findings" / empty-scan conf on timeout. */
export function specialistTimeoutFindingsSummary(role: string): Array<{
  title: string;
  severity: string;
  category: string;
  confidence?: number;
}> {
  return [
    {
      title: "TIMED OUT — incomplete review (not an empty scan)",
      severity: role === "security" ? "high" : "medium",
      category: role === "security" ? "security" : "other",
      confidence: 0.95,
    },
  ];
}

/** Close audit + emit SSE when a specialist times out or fails. */
export function recordSpecialistFailure(input: {
  audit?: SessionAuditCollector;
  onEvent?: SpecialistProgressSink;
  sessionId: string;
  unitId: string;
  unitLabel?: string;
  role: string;
  model?: string;
  runner?: string;
  err: unknown;
  startedAtMs: number;
  /** Open audit run id when known (DeepAgents path). */
  runId?: string;
}): { timedOut: boolean; timeoutMs?: number; durationMs: number; message: string } {
  const durationMs = Math.max(0, Date.now() - input.startedAtMs);
  const timedOut = isTimeoutError(input.err);
  const timeoutMs = timeoutMsFromError(input.err);
  const message =
    input.err instanceof Error ? input.err.message : String(input.err);

  const status = timedOut ? ("truncated" as const) : ("error" as const);
  const endPatch = {
    status,
    // Timeout gap finding is emitted separately; ledger must not look like empty-scan
    findingCount: timedOut ? 1 : 0,
    error: message,
    timedOut,
    timeoutMs,
    avgConfidence: timedOut ? undefined : undefined,
    findingsSummary: timedOut
      ? specialistTimeoutFindingsSummary(input.role)
      : undefined,
  };
  if (input.runId && input.audit) {
    input.audit.endRun(input.runId, endPatch);
  } else if (input.audit) {
    input.audit.endOpenRunsForUnitRole(input.unitId, input.role, endPatch);
  }

  emitSpecialistProgress(input.onEvent, {
    sessionId: input.sessionId,
    unitId: input.unitId,
    unitLabel: input.unitLabel,
    role: input.role,
    status: timedOut ? "timeout" : "failed",
    model: input.model,
    runner: input.runner,
    error: message.slice(0, 500),
    durationMs,
    timedOut,
    timeoutMs,
    message: timedOut
      ? `timed out after ${Math.round(durationMs / 1000)}s` +
        (timeoutMs ? ` (budget ${Math.round(timeoutMs / 1000)}s)` : "")
      : undefined,
  });

  return { timedOut, timeoutMs, durationMs, message };
}
