/**
 * Install-wide (platform operator) performance analytics.
 * Aggregates sessions/jobs/timings — not tenant-facing product analytics.
 */
import type { ReviewSession } from "@codesteward/core";
import type { JobQueue } from "./queue.js";
import type { SessionStore } from "./store.js";
import { getInlineWorkerStatus } from "./worker-loop.js";

export interface PlatformAnalytics {
  windowDays: number;
  generatedAt: string;
  sessions: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    completedWithErrors: number;
    cancelled: number;
    byMode: Record<string, number>;
    byStage: Record<string, number>;
    successRate: number | null;
  };
  latency: {
    sampleSize: number;
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
    maxMs: number | null;
    byStageAvgMs: Record<string, number>;
    longestStages: Array<{ stage: string; avgMs: number; samples: number }>;
  };
  specialists: {
    runs: number;
    avgMs: number | null;
    maxMs: number | null;
    byRole: Array<{
      role: string;
      runs: number;
      avgMs: number | null;
      maxMs: number | null;
      errorRate: number | null;
    }>;
  };
  workers: {
    jobsPending: number;
    jobsRunning: number;
    jobsDead: number;
    jobsCompletedSample: number;
    distinctWorkers: number;
    workerIds: string[];
    inlineWorker: ReturnType<typeof getInlineWorkerStatus>;
  };
  tokens: {
    totalPrompt: number;
    totalCompletion: number;
    total: number;
    estimatedCostUsd: number | null;
    sessionsWithUsage: number;
  };
  recentSlow: Array<{
    sessionId: string;
    repoId: string;
    mode: string;
    totalDurationMs: number;
    longestStage?: string;
    status: string;
    completedAt?: string;
  }>;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sessionDurationMs(s: ReviewSession): number | null {
  const meta = s.metadata as Record<string, unknown> | undefined;
  const timings =
    (s.audit?.timings as { totalDurationMs?: number } | undefined) ??
    (meta?.timings as { totalDurationMs?: number } | undefined) ??
    (meta?.audit as { timings?: { totalDurationMs?: number } } | undefined)?.timings;
  if (typeof timings?.totalDurationMs === "number") return timings.totalDurationMs;
  if (s.completedAt && s.createdAt) {
    const a = Date.parse(s.createdAt);
    const b = Date.parse(s.completedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
  }
  return null;
}

function sessionTimings(s: ReviewSession): {
  byStageMs?: Record<string, number>;
  longestStage?: string;
  specialistRuns?: Array<{ role: string; durationMs?: number; status?: string }>;
} {
  const meta = s.metadata as Record<string, unknown> | undefined;
  const audit =
    s.audit ??
    (meta?.audit as ReviewSession["audit"] | undefined) ??
    undefined;
  const timings =
    audit?.timings ??
    (meta?.timings as
      | {
          summary?: { byStageMs?: Record<string, number>; longestStage?: string };
        }
      | undefined);
  return {
    byStageMs: timings?.summary?.byStageMs,
    longestStage: timings?.summary?.longestStage,
    specialistRuns: audit?.specialistRuns?.map((r) => ({
      role: r.role,
      durationMs: r.durationMs,
      status: r.status,
    })),
  };
}

export async function buildPlatformAnalytics(opts: {
  sessions: SessionStore;
  queue: JobQueue;
  days?: number;
  limit?: number;
}): Promise<PlatformAnalytics> {
  const days = Math.min(90, Math.max(1, opts.days ?? 14));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = await opts.sessions.listLive({});
  const sessions = all
    .filter((s) => {
      const t = Date.parse(s.createdAt);
      return Number.isFinite(t) && t >= since;
    })
    .slice(0, opts.limit ?? 500);

  const byMode: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  let completed = 0;
  let failed = 0;
  let running = 0;
  let completedWithErrors = 0;
  let cancelled = 0;
  const durations: number[] = [];
  const stageAcc: Record<string, { sum: number; n: number }> = {};
  const roleAcc: Record<
    string,
    { sum: number; n: number; max: number; errors: number; runs: number }
  > = {};
  let specialistRuns = 0;
  let specialistSum = 0;
  let specialistMax = 0;
  let prompt = 0;
  let completion = 0;
  let cost = 0;
  let costSessions = 0;
  const slow: PlatformAnalytics["recentSlow"] = [];

  for (const s of sessions) {
    byMode[s.mode] = (byMode[s.mode] ?? 0) + 1;
    byStage[s.stage] = (byStage[s.stage] ?? 0) + 1;
    if (s.status === "completed") completed += 1;
    else if (s.status === "failed") failed += 1;
    else if (s.status === "running" || s.status === "pending") running += 1;
    else if (s.status === "completed_with_errors") completedWithErrors += 1;
    else if (s.status === "cancelled") cancelled += 1;

    const dur = sessionDurationMs(s);
    if (dur != null) {
      durations.push(dur);
      const t = sessionTimings(s);
      slow.push({
        sessionId: s.id,
        repoId: s.repoId,
        mode: s.mode,
        totalDurationMs: dur,
        longestStage: t.longestStage,
        status: s.status,
        completedAt: s.completedAt,
      });
      if (t.byStageMs) {
        for (const [stage, ms] of Object.entries(t.byStageMs)) {
          const row = stageAcc[stage] ?? { sum: 0, n: 0 };
          row.sum += ms;
          row.n += 1;
          stageAcc[stage] = row;
        }
      }
      for (const r of t.specialistRuns ?? []) {
        specialistRuns += 1;
        const acc = roleAcc[r.role] ?? { sum: 0, n: 0, max: 0, errors: 0, runs: 0 };
        acc.runs += 1;
        if (r.status === "error") acc.errors += 1;
        if (typeof r.durationMs === "number") {
          acc.sum += r.durationMs;
          acc.n += 1;
          acc.max = Math.max(acc.max, r.durationMs);
          specialistSum += r.durationMs;
          specialistMax = Math.max(specialistMax, r.durationMs);
        }
        roleAcc[r.role] = acc;
      }
    }

    const u = s.tokenUsage;
    if (u && (u.totalTokens > 0 || u.promptTokens > 0)) {
      prompt += u.promptTokens ?? 0;
      completion += u.completionTokens ?? 0;
      if (typeof u.costUsd === "number") {
        cost += u.costUsd;
        costSessions += 1;
      }
    }
  }

  durations.sort((a, b) => a - b);
  slow.sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  const byStageAvgMs: Record<string, number> = {};
  const longestStages: PlatformAnalytics["latency"]["longestStages"] = [];
  for (const [stage, row] of Object.entries(stageAcc)) {
    const a = row.n ? row.sum / row.n : 0;
    byStageAvgMs[stage] = Math.round(a);
    longestStages.push({ stage, avgMs: Math.round(a), samples: row.n });
  }
  longestStages.sort((a, b) => b.avgMs - a.avgMs);

  const terminal = completed + failed + completedWithErrors;
  const successRate =
    terminal > 0 ? Math.round(((completed + completedWithErrors * 0.5) / terminal) * 1000) / 10 : null;

  // Jobs / workers
  let jobsPending = 0;
  let jobsRunning = 0;
  let jobsDead = 0;
  let jobsCompletedSample = 0;
  const workerIds = new Set<string>();
  try {
    const jobs = await opts.queue.list();
    for (const j of jobs as Array<{
      status?: string;
      lockedBy?: string | null;
      locked_by?: string | null;
    }>) {
      const st = String(j.status ?? "");
      if (st === "pending") jobsPending += 1;
      else if (st === "running") {
        jobsRunning += 1;
        const w = j.lockedBy ?? j.locked_by;
        if (w) workerIds.add(String(w));
      } else if (st === "dead") jobsDead += 1;
      else if (st === "completed") jobsCompletedSample += 1;
    }
  } catch {
    /* queue list optional shape */
  }

  // Prefer PG jobs table if describe is postgres
  try {
    if (process.env.DATABASE_URL?.trim()) {
      const { createStewardDb } = await import("@codesteward/db");
      const db = createStewardDb();
      const rows = await db.jobs.list();
      jobsPending = 0;
      jobsRunning = 0;
      jobsDead = 0;
      jobsCompletedSample = 0;
      workerIds.clear();
      for (const r of rows) {
        if (r.status === "pending") jobsPending += 1;
        else if (r.status === "running") {
          jobsRunning += 1;
          if (r.lockedBy) workerIds.add(r.lockedBy);
        } else if (r.status === "dead") jobsDead += 1;
        else if (r.status === "completed") jobsCompletedSample += 1;
      }
    }
  } catch {
    /* keep queue-based counts */
  }

  return {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    sessions: {
      total: sessions.length,
      completed,
      failed,
      running,
      completedWithErrors,
      cancelled,
      byMode,
      byStage,
      successRate,
    },
    latency: {
      sampleSize: durations.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      avgMs: avg(durations) != null ? Math.round(avg(durations)!) : null,
      maxMs: durations.length ? durations[durations.length - 1]! : null,
      byStageAvgMs,
      longestStages: longestStages.slice(0, 12),
    },
    specialists: {
      runs: specialistRuns,
      avgMs:
        specialistRuns && specialistSum
          ? Math.round(specialistSum / Math.max(1, Object.values(roleAcc).reduce((n, r) => n + r.n, 0)))
          : null,
      maxMs: specialistMax || null,
      byRole: Object.entries(roleAcc)
        .map(([role, r]) => ({
          role,
          runs: r.runs,
          avgMs: r.n ? Math.round(r.sum / r.n) : null,
          maxMs: r.max || null,
          errorRate: r.runs ? Math.round((r.errors / r.runs) * 1000) / 10 : null,
        }))
        .sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0)),
    },
    workers: {
      jobsPending,
      jobsRunning,
      jobsDead,
      jobsCompletedSample,
      distinctWorkers: workerIds.size,
      workerIds: [...workerIds].slice(0, 20),
      inlineWorker: getInlineWorkerStatus(),
    },
    tokens: {
      totalPrompt: prompt,
      totalCompletion: completion,
      total: prompt + completion,
      estimatedCostUsd: costSessions ? Math.round(cost * 10000) / 10000 : null,
      sessionsWithUsage: costSessions || (prompt + completion > 0 ? sessions.length : 0),
    },
    recentSlow: slow.slice(0, 15),
  };
}
