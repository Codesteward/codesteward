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
