/**
 * Optional Langfuse tracing for model completions.
 *
 * Destinations (can be BOTH at once):
 *   - Org project: per-tenant keys from org settings
 *   - Platform project: install keys (UI platform store and/or LANGFUSE_* env)
 *
 * When both are fully configured, every generation is dual-written to both projects.
 *
 * Gates:
 *   STEW_LICENSE_LANGFUSE=0 or STEW_LANGFUSE_ENABLED=0 → off entirely
 *   credentials.enabled === false → that destination skipped
 *
 * STEW_LANGFUSE_TRACE_MODE=session|per_call  (default session)
 */
import type { CompleteRequest, CompleteResponse } from "./types.js";

export interface LangfuseTraceContext {
  sessionId?: string;
  userId?: string;
  role?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
  traceName?: string;
  orgId?: string;
}

/**
 * Langfuse Sessions require a US-ASCII sessionId &lt; 200 chars.
 * @see https://langfuse.com/docs/observability/features/sessions
 * Returns undefined when empty after sanitization (caller may skip session grouping).
 */
export function sanitizeLangfuseSessionId(
  sessionId: string | null | undefined,
): string | undefined {
  if (sessionId == null) return undefined;
  const trimmed = String(sessionId).trim();
  if (!trimmed) return undefined;
  // Keep printable US-ASCII only; replace others so IDs stay valid
  const ascii = trimmed.replace(/[^\x20-\x7E]/g, "_");
  if (!ascii) return undefined;
  return ascii.length > 200 ? ascii.slice(0, 200) : ascii;
}

/** Resolved credentials for one Langfuse project (org or platform). */
export interface LangfuseCredentials {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  /** Explicit disable for this destination. */
  enabled?: boolean;
  orgId?: string;
  source?: "org" | "platform" | "explicit";
}

type LangfuseGeneration = {
  end: (args?: Record<string, unknown>) => void;
  id?: string;
};

type LangfuseSpan = {
  end: (args?: Record<string, unknown>) => void;
  id?: string;
  generation?: (args: Record<string, unknown>) => LangfuseGeneration;
  span?: (args: Record<string, unknown>) => LangfuseSpan;
};

type LangfuseTrace = {
  generation: (args: Record<string, unknown>) => LangfuseGeneration;
  span?: (args: Record<string, unknown>) => LangfuseSpan;
  update?: (args: Record<string, unknown>) => void;
  id?: string;
};

type LangfuseClient = {
  trace: (args: Record<string, unknown>) => LangfuseTrace;
  generation: (args: Record<string, unknown>) => LangfuseGeneration;
  span?: (args: Record<string, unknown>) => LangfuseSpan;
  flushAsync?: () => Promise<void>;
  shutdownAsync?: () => Promise<void>;
};

/** @internal exported for agent LangChain callback dual-write */
export type { LangfuseClient, LangfuseTrace, LangfuseGeneration, LangfuseSpan };

const clients = new Map<string, LangfuseClient | null>();

function cacheKey(c: LangfuseCredentials): string {
  return `${c.publicKey}\0${c.baseUrl ?? ""}`;
}

function isComplete(c: LangfuseCredentials | null | undefined): c is LangfuseCredentials {
  return Boolean(c && c.enabled !== false && c.publicKey?.trim() && c.secretKey?.trim());
}

export function isLangfuseAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STEW_LICENSE_LANGFUSE === "0" || env.STEW_LANGFUSE_ENABLED === "0") {
    return false;
  }
  return true;
}

export function isLangfuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

export function langfuseCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseCredentials | null {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  return {
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL || undefined,
    enabled: true,
    source: "platform",
  };
}

/**
 * Build the list of Langfuse projects to write to.
 * Both org and platform may be included when both are fully set.
 *
 * @param org — org-level config (null/incomplete skipped; enabled:false skips org only)
 * @param platform — platform UI/store config (optional); env fills gaps if not provided
 */
export function resolveLangfuseDestinations(
  org: LangfuseCredentials | null | undefined,
  platform?: LangfuseCredentials | null,
  env: NodeJS.ProcessEnv = process.env,
): LangfuseCredentials[] {
  if (!isLangfuseAllowed(env)) return [];

  const dests: LangfuseCredentials[] = [];
  const seen = new Set<string>();

  const push = (c: LangfuseCredentials) => {
    const k = cacheKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    dests.push({ ...c, enabled: true });
  };

  if (isComplete(org)) {
    push({ ...org, source: org.source ?? "org" });
  }

  const plat = isComplete(platform)
    ? { ...platform, source: platform.source ?? "platform" as const }
    : langfuseCredentialsFromEnv(env);

  if (isComplete(plat)) {
    push(plat);
  }

  return dests;
}

/**
 * Backward-compatible single-destination resolve.
 * Prefer resolveLangfuseDestinations for dual-write.
 */
export function resolveLangfuseCredentials(
  explicit: LangfuseCredentials | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LangfuseCredentials | null {
  const dests = resolveLangfuseDestinations(explicit, null, env);
  return dests[0] ?? null;
}

const SECRETISH =
  /(?<![A-Za-z0-9_])(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|api[_-]?key["'\s:=]+[A-Za-z0-9_-]{12,})/gi;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function redactForLangfuse(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.STEW_LANGFUSE_REDACT === "0") return text;
  let out = text.replace(SECRETISH, "[REDACTED]");
  if (env.STEW_LANGFUSE_REDACT_EMAIL !== "0") {
    out = out.replace(EMAIL_RE, "[EMAIL]");
  }
  const max = Number(env.STEW_LANGFUSE_MAX_CHARS ?? 12_000);
  if (out.length > max) {
    out = `${out.slice(0, max)}\n…[truncated ${out.length - max} chars]`;
  }
  return out;
}

export function redactCompleteRequest(
  req: CompleteRequest,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    system: req.system ? redactForLangfuse(req.system, env) : undefined,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: redactForLangfuse(m.content, env),
    })),
  };
}

export async function getLangfuse(
  credentials?: LangfuseCredentials | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LangfuseClient | null> {
  if (!isLangfuseAllowed(env)) return null;
  const creds = isComplete(credentials)
    ? credentials
    : !credentials
      ? langfuseCredentialsFromEnv(env)
      : null;
  if (!isComplete(creds)) return null;

  const key = cacheKey(creds);
  if (clients.has(key)) return clients.get(key) ?? null;

  try {
    const { Langfuse } = await import("langfuse");
    const client = new Langfuse({
      publicKey: creds.publicKey,
      secretKey: creds.secretKey,
      baseUrl: creds.baseUrl,
    }) as unknown as LangfuseClient;
    clients.set(key, client);
    return client;
  } catch (err) {
    console.warn("[langfuse] init failed", err);
    clients.set(key, null);
    return null;
  }
}

export function resetLangfuseClient(): void {
  clients.clear();
}

export async function flushLangfuse(
  credentials?: LangfuseCredentials | LangfuseCredentials[] | null,
): Promise<void> {
  const list = Array.isArray(credentials)
    ? credentials
    : credentials
      ? [credentials]
      : null;

  if (list) {
    for (const c of list) {
      const lf = await getLangfuse(c);
      if (lf?.flushAsync) {
        try {
          await lf.flushAsync();
          if (process.env.STEW_LANGFUSE_DEBUG === "1") {
            console.info(
              `[langfuse] flush ok dest=${c.source ?? "?"} pk=${c.publicKey?.slice(0, 12) ?? "?"}`,
            );
          }
        } catch (err) {
          console.warn(
            "[langfuse] flush failed",
            c.source,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return;
  }

  for (const lf of clients.values()) {
    if (lf?.flushAsync) {
      try {
        await lf.flushAsync();
      } catch (err) {
        console.warn("[langfuse] flush failed", err);
      }
    }
  }
}

/**
 * Upsert top-level trace input/output so Langfuse Sessions/Traces list is not empty
 * (nested generations may still hold full turn history).
 */
export async function upsertLangfuseTraceSummary(
  credentials: LangfuseCredentials | LangfuseCredentials[] | null | undefined,
  args: {
    sessionId: string;
    traceId: string;
    name?: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    orgId?: string;
    role?: string;
  },
): Promise<void> {
  const list = Array.isArray(credentials)
    ? credentials.filter(isComplete)
    : credentials
      ? [credentials]
      : [];
  if (!list.length) return;

  const sessionId = sanitizeLangfuseSessionId(args.sessionId);
  let traceId = String(args.traceId || "").trim();
  if (sessionId && traceId && !traceId.startsWith(sessionId)) {
    traceId = `${sessionId}:${traceId}`;
  }
  if (!traceId) traceId = sessionId ?? `trace_${Date.now()}`;

  for (const dest of list) {
    try {
      const lf = await getLangfuse(dest);
      if (!lf) continue;
      lf.trace({
        id: traceId.slice(0, 200),
        sessionId,
        name: args.name ?? "codesteward.review",
        input: args.input,
        output: args.output,
        metadata: {
          sessionId,
          reviewSessionId: sessionId,
          orgId: args.orgId,
          role: args.role,
          langfuseSource: dest.source,
          ...args.metadata,
        },
        tags: [
          "codesteward",
          args.role,
          args.orgId ? `org:${args.orgId}` : undefined,
          dest.source ? `lf:${dest.source}` : undefined,
          sessionId ? "session" : undefined,
        ].filter(Boolean),
      });
    } catch (err) {
      console.warn(
        "[langfuse] trace summary upsert failed",
        dest.source,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Resolve a Langfuse trace id that is always scoped to the current review session.
 * Never returns another session's id (prevents sticky/cross-session traces).
 */
export function resolveLangfuseTraceId(
  ctx: Pick<LangfuseTraceContext, "sessionId" | "traceId" | "role">,
): string | undefined {
  const sessionId = sanitizeLangfuseSessionId(ctx.sessionId);
  let raw = ctx.traceId?.trim() || undefined;
  if (raw) {
    raw = sanitizeLangfuseSessionId(raw) ?? raw.slice(0, 200);
  }
  if (sessionId) {
    // Prefer role-scoped traces under the session so specialists don't interleave
    if (!raw || raw === sessionId) {
      return ctx.role ? `${sessionId}:${ctx.role}`.slice(0, 200) : sessionId;
    }
    if (!raw.startsWith(sessionId)) {
      return `${sessionId}:${raw}`.slice(0, 200);
    }
    return raw.slice(0, 200);
  }
  return raw;
}

/**
 * Build trace args so Langfuse Sessions UI groups by CodeSteward review session.
 * Always sets `sessionId` on the trace when a valid id is available.
 */
export function buildLangfuseTraceArgs(
  ctx: LangfuseTraceContext,
  destSource?: string,
  opts?: { name?: string; mode?: string },
): Record<string, unknown> {
  const sessionId = sanitizeLangfuseSessionId(ctx.sessionId);
  const mode = (opts?.mode ?? process.env.STEW_LANGFUSE_TRACE_MODE ?? "session").toLowerCase();
  const tags = [
    "codesteward",
    ctx.role,
    ctx.orgId ? `org:${ctx.orgId}` : undefined,
    destSource ? `lf:${destSource}` : undefined,
    sessionId ? "session" : undefined,
  ].filter(Boolean) as string[];

  const meta = {
    sessionId,
    reviewSessionId: sessionId,
    orgId: ctx.orgId,
    langfuseSource: destSource,
    ...ctx.metadata,
  };

  const traceId = resolveLangfuseTraceId(ctx);

  if (sessionId && mode !== "per_call") {
    return {
      id: traceId ?? sessionId,
      sessionId,
      userId: ctx.userId,
      name: opts?.name ?? ctx.traceName ?? "codesteward.review",
      metadata: meta,
      tags,
    };
  }
  if (sessionId) {
    return {
      // per_call: still set sessionId so Sessions UI groups traces
      sessionId,
      userId: ctx.userId,
      name: opts?.name ?? ctx.traceName ?? `steward.${ctx.role ?? "model"}`,
      metadata: meta,
      tags,
    };
  }
  return {
    userId: ctx.userId,
    name: opts?.name ?? ctx.traceName ?? `steward.${ctx.role ?? "model"}`,
    metadata: meta,
    tags,
  };
}

function startGeneration(
  lf: LangfuseClient,
  ctx: LangfuseTraceContext,
  model: string,
  provider: string,
  req: CompleteRequest,
  destSource?: string,
): LangfuseGeneration {
  const sessionId = sanitizeLangfuseSessionId(ctx.sessionId);
  const mode = (process.env.STEW_LANGFUSE_TRACE_MODE ?? "session").toLowerCase();
  const genName = `steward.${ctx.role ?? "model"}`;
  const genArgs: Record<string, unknown> = {
    name: genName,
    model,
    modelParameters: {
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      provider,
    },
    input: redactCompleteRequest(req),
    metadata: {
      role: ctx.role,
      provider,
      orgId: ctx.orgId,
      sessionId,
      reviewSessionId: sessionId,
      langfuseSource: destSource,
      redacted: process.env.STEW_LANGFUSE_REDACT !== "0",
      ...ctx.metadata,
    },
  };

  // Always open a session-scoped trace, then create generation with explicit traceId
  // (do not use TraceClient.generation — it forces parentObservationId=null).
  if (sessionId) {
    const traceArgs = buildLangfuseTraceArgs(ctx, destSource, { mode });
    const traceId = String(traceArgs.id ?? resolveLangfuseTraceId(ctx) ?? sessionId);
    // Re-assert session on every trace-create (idempotent upsert by id)
    lf.trace({ ...traceArgs, id: traceId, sessionId });
    return lf.generation({
      ...genArgs,
      traceId,
    });
  }
  return lf.generation(genArgs);
}

/**
 * Wrap a completion; dual-writes to all destinations when multiple are configured.
 *
 * @param credentials — single destination (legacy) OR array of destinations
 */
export async function withLangfuseGeneration(
  ctx: LangfuseTraceContext,
  model: string,
  provider: string,
  req: CompleteRequest,
  run: () => Promise<CompleteResponse>,
  credentials?: LangfuseCredentials | LangfuseCredentials[] | null,
): Promise<CompleteResponse> {
  const dests: LangfuseCredentials[] = Array.isArray(credentials)
    ? credentials.filter(isComplete)
    : credentials
      ? resolveLangfuseDestinations(credentials, null)
      : resolveLangfuseDestinations(null, null);

  if (!dests.length) return run();

  const gens: LangfuseGeneration[] = [];
  for (const dest of dests) {
    try {
      const lf = await getLangfuse(dest);
      if (!lf) continue;
      gens.push(startGeneration(lf, ctx, model, provider, req, dest.source));
    } catch (err) {
      console.warn("[langfuse] create generation failed", dest.source, err);
    }
  }

  if (!gens.length) return run();

  try {
    const res = await run();
    const endArgs = {
      output: redactForLangfuse(res.content),
      usage: {
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        totalTokens: res.usage.totalTokens,
      },
    };
    for (const gen of gens) {
      try {
        gen.end(endArgs);
      } catch {
        /* ignore per-dest end errors */
      }
    }
    return res;
  } catch (err) {
    const endArgs = {
      output: err instanceof Error ? err.message : String(err),
      level: "ERROR" as const,
    };
    for (const gen of gens) {
      try {
        gen.end(endArgs);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}
