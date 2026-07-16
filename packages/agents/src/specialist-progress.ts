import { nowIso, type ProgressEvent } from "@codesteward/core";

export type SpecialistProgressSink = (
  event: ProgressEvent,
) => void | Promise<void>;

/**
 * Emit specialist_run lifecycle events for UI live status / heartbeats.
 * Heartbeats reuse status "running" so clients can update elapsed timers.
 */
export function emitSpecialistProgress(
  onEvent: SpecialistProgressSink | undefined,
  input: {
    sessionId: string;
    unitId: string;
    unitLabel?: string;
    role: string;
    status: "started" | "running" | "completed" | "failed" | "timeout";
    model?: string;
    runner?: string;
    findingCount?: number;
    durationMs?: number;
    error?: string;
    message?: string;
    timedOut?: boolean;
    timeoutMs?: number;
  },
): void {
  if (!onEvent) return;
  void onEvent({
    type: "specialist_run",
    sessionId: input.sessionId,
    unitId: input.unitId,
    unitLabel: input.unitLabel,
    role: input.role,
    status: input.status,
    model: input.model,
    runner: input.runner,
    findingCount: input.findingCount,
    durationMs: input.durationMs,
    error: input.error,
    message: input.message,
    timedOut: input.timedOut,
    timeoutMs: input.timeoutMs,
    ts: nowIso(),
  } as ProgressEvent);
}

/**
 * Start SSE heartbeats while a specialist is in-flight.
 * Default every 15s (STEW_SPECIALIST_HEARTBEAT_MS).
 */
export function startSpecialistHeartbeat(input: {
  onEvent?: SpecialistProgressSink;
  sessionId: string;
  unitId: string;
  unitLabel?: string;
  role: string;
  model?: string;
  runner?: string;
  startedAtMs?: number;
}): () => void {
  const intervalMs = Number(process.env.STEW_SPECIALIST_HEARTBEAT_MS ?? 15_000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !input.onEvent) {
    return () => undefined;
  }
  const t0 = input.startedAtMs ?? Date.now();
  const tick = () => {
    const elapsedMs = Math.max(0, Date.now() - t0);
    emitSpecialistProgress(input.onEvent, {
      sessionId: input.sessionId,
      unitId: input.unitId,
      unitLabel: input.unitLabel,
      role: input.role,
      status: "running",
      model: input.model,
      runner: input.runner,
      durationMs: elapsedMs,
      message: `still running · ${formatElapsed(elapsedMs)}`,
    });
  };
  const id = setInterval(tick, intervalMs);
  id.unref?.();
  return () => clearInterval(id);
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
