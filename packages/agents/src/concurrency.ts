/** Minimal p-limit style concurrency limiter. */
export function createLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= maxConcurrent) return;
    const job = queue.shift();
    if (job) job();
  };

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}

export function defaultMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STEW_MAX_CONCURRENT ?? env.STEW_WORKER_CONCURRENCY ?? 8);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/**
 * Per-specialist wall-clock budget so one hung DeepAgents/LLM call cannot
 * stall a unit forever (Promise.all barrier).
 * Default 8 minutes; override with STEW_SPECIALIST_TIMEOUT_MS.
 */
export function specialistTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STEW_SPECIALIST_TIMEOUT_MS ?? 480_000);
  return Number.isFinite(n) && n > 0 ? n : 480_000;
}

/** Max parallel roles inside one unit (default 4). */
export function maxSpecialistsPerUnit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STEW_MAX_SPECIALISTS_PER_UNIT ?? 4);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a wall clock. Does not cancel the underlying work
 * (model/HTTP may continue), but unblocks the review pipeline.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = "operation",
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
    // Don't keep the process alive solely for this timer
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Run async work over items with a concurrency cap. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const limit = createLimiter(Math.max(1, concurrency));
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}
