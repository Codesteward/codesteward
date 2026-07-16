/**
 * Rate-limit / transient error retries for LLM HTTP calls.
 * DeepAgents uses LangChain (separate path) — see resolveDeepAgentsModel maxRetries.
 */

export function llmMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STEW_LLM_MAX_RETRIES ?? 4);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

export function llmRetryBaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STEW_LLM_RETRY_BASE_MS ?? 1_000);
  return Number.isFinite(n) && n > 0 ? n : 1_000;
}

export function llmRetryMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STEW_LLM_RETRY_MAX_MS ?? 60_000);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** True when status / body looks like rate limit or transient provider fault. */
export function isRetryableLlmStatus(status: number, body = ""): boolean {
  if (status === 429 || status === 408 || status === 409) return true;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  // Some gateways return 400 with rate limit wording
  if (status === 400 && /rate.?limit|too many requests|quota|overloaded/i.test(body)) {
    return true;
  }
  return false;
}

export function isRetryableLlmError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate.?limit|too many requests|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|503|502|504/i.test(msg)) {
    return true;
  }
  return false;
}

/** Prefer Retry-After header (seconds or HTTP-date). */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined;
  const sec = Number(header.trim());
  if (Number.isFinite(sec) && sec >= 0) return Math.min(llmRetryMaxMs(), sec * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.min(llmRetryMaxMs(), Math.max(0, when - Date.now()));
  }
  return undefined;
}

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(llmRetryMaxMs(), retryAfterMs);
  }
  const base = llmRetryBaseMs();
  const exp = Math.min(llmRetryMaxMs(), base * 2 ** Math.max(0, attempt));
  // ±20% jitter
  const jitter = exp * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with retries on 429/5xx. Does not retry non-retryable 4xx (except 408/409).
 * attempt 0 is the first try; retries up to maxRetries additional times.
 */
export async function fetchWithLlmRetry(
  url: string,
  init: RequestInit,
  opts?: { label?: string; maxRetries?: number },
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? llmMaxRetries();
  const label = opts?.label ?? "llm";
  let last: Response | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      last = res;
      if (res.ok) return res;

      const text = await res.text();
      // Re-wrap body so callers can still read text
      const rebuilt = new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });

      if (!isRetryableLlmStatus(res.status, text) || attempt >= maxRetries) {
        return rebuilt;
      }

      const wait = backoffMs(
        attempt,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
      console.warn(
        `[model-router] ${label} HTTP ${res.status} — retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${text.slice(0, 160).replace(/\s+/g, " ")}`,
      );
      await sleep(wait);
      continue;
    } catch (err) {
      lastErr = err;
      if (!isRetryableLlmError(err) || attempt >= maxRetries) {
        throw err;
      }
      const wait = backoffMs(attempt);
      console.warn(
        `[model-router] ${label} network error — retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await sleep(wait);
    }
  }

  if (last) return last;
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${label}: exhausted retries`);
}
