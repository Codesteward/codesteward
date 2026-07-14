import { globalQueue } from "./queue.js";
import { globalSessionStore } from "./store.js";
import { resumeIncompleteSessions, runReviewJob } from "./run-job.js";

export function isInlineWorkerEnabled(): boolean {
  return process.env.STEW_INLINE_WORKER !== "0";
}

export function getInlineWorkerPollMs(): number {
  return Number(process.env.STEW_WORKER_POLL_MS ?? 1500);
}

let running = false;
let stopRequested = false;
let loopPromise: Promise<void> | undefined;
let processing = false;
let lastClaimAt: string | null = null;
let jobsProcessed = 0;

/**
 * Worker health for UI.
 * - `mode: "inline"` — API process drains the queue (STEW_INLINE_WORKER ≠ 0)
 * - `mode: "external"` — dedicated worker(s) expected (STEW_INLINE_WORKER=0)
 * `enabled` means "queue is expected to be processed" (inline running OR external mode).
 * Do not treat `mode === "external"` as "no worker".
 */
export function getInlineWorkerStatus() {
  const inline = isInlineWorkerEnabled();
  const mode: "inline" | "external" = inline ? "inline" : "external";
  return {
    /** True when jobs should be processed (inline loop active, or external workers expected). */
    enabled: inline ? running : true,
    mode,
    inlineEnabled: inline,
    running: inline ? running : false,
    processing: inline ? processing : false,
    lastClaimAt,
    jobsProcessed,
    pollMs: getInlineWorkerPollMs(),
    hint: inline
      ? running
        ? "Inline worker is processing jobs inside the API process"
        : "Inline worker enabled but not started yet"
      : "Dedicated worker mode (STEW_INLINE_WORKER=0). Scale `worker` replicas — do not expect the API process to claim jobs.",
  };
}

/**
 * Background poll loop for self-host UX (default ON).
 * Disable with STEW_INLINE_WORKER=0 when using a dedicated worker process.
 */
export function startInlineWorkerLoop(): void {
  if (!isInlineWorkerEnabled()) {
    console.log(
      "[inline-worker] disabled (STEW_INLINE_WORKER=0) — jobs wait for external worker",
    );
    return;
  }
  if (running) return;
  running = true;
  stopRequested = false;
  const pollMs = getInlineWorkerPollMs();
  console.log(`[inline-worker] starting poll loop every ${pollMs}ms`);

  loopPromise = (async () => {
    try {
      await resumeIncompleteSessions({
        label: "inline-worker",
        log: (msg, ...args) => console.log(`[inline-worker] ${msg}`, ...args),
      });
    } catch (err) {
      console.error("[inline-worker] resume incomplete failed", err);
    }

    while (!stopRequested) {
      try {
        await globalSessionStore.reload();
        await globalQueue.load();
        const job = await globalQueue.dequeue();
        if (!job) {
          await sleep(pollMs);
          continue;
        }
        processing = true;
        lastClaimAt = new Date().toISOString();
        console.log(
          `[inline-worker] processing job ${job.id} session=${job.sessionId} mode=${job.mode}`,
        );
        await runReviewJob(job, {
          label: "inline-worker",
          log: (msg, ...args) => console.log(`[inline-worker] ${msg}`, ...args),
        });
        jobsProcessed += 1;
      } catch (err) {
        console.error("[inline-worker] loop error", err);
        await sleep(pollMs);
      } finally {
        processing = false;
      }
    }
    running = false;
    console.log("[inline-worker] stopped");
  })();
}

export async function stopInlineWorkerLoop(): Promise<void> {
  stopRequested = true;
  await loopPromise;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
