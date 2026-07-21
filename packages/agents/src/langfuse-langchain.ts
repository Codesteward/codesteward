/**
 * Dual-write LangChain callback → Langfuse (org + platform when both configured).
 *
 * Captures every LLM/chat turn, tool call, and chain/subagent span so DeepAgents
 * multi-turn runs appear fully in Langfuse Sessions (sessionId = review session).
 *
 * @see https://langfuse.com/docs/observability/features/sessions
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  buildLangfuseTraceArgs,
  getLangfuse,
  redactForLangfuse,
  redactSecretsOnly,
  sanitizeLangfuseSessionId,
  type ClickHouseWriter,
  type LangfuseCredentials,
  type LangfuseTraceContext,
} from "@codesteward/model-router";

/** Loose Serialized shape from LangChain (avoid deep path imports). */
type Serialized = {
  id?: string[];
  name?: string;
  lc?: number;
  type?: string;
  kwargs?: Record<string, unknown>;
};

type Endable = {
  end: (args?: Record<string, unknown>) => void;
};

type DestRun = {
  source?: string;
  obs: Endable;
};

export interface DualLangfuseCallbackOptions {
  destinations: LangfuseCredentials[];
  /** Platform ClickHouse sink — when set, every observation is dual-written (full I/O). */
  clickhouse?: ClickHouseWriter | null;
  sessionId: string;
  orgId?: string;
  userId?: string;
  role: string;
  unitId?: string;
  unitLabel?: string;
  metadata?: Record<string, unknown>;
  /** Optional stable trace id; defaults to sessionId in session mode */
  traceId?: string;
  traceName?: string;
  repoId?: string;
  tenantId?: string;
}

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        try {
          return JSON.stringify(part);
        } catch {
          return "";
        }
      })
      .join("");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isLcSerialized(v: unknown): v is {
  lc: number;
  type?: string;
  id?: string[];
  kwargs?: Record<string, unknown>;
} {
  return Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "lc" in v &&
      (v as { lc?: unknown }).lc != null,
  );
}

function lcMessageRole(id: string[] | undefined, kwargs?: Record<string, unknown>): string {
  const last = id?.[id.length - 1] ?? "";
  if (/human/i.test(last) || last === "HumanMessage") return "user";
  if (/ai|assistant/i.test(last) || last === "AIMessage") return "assistant";
  if (/system/i.test(last)) return "system";
  if (/tool/i.test(last)) return "tool";
  if (typeof kwargs?.type === "string") return String(kwargs.type);
  return last || "message";
}

/**
 * Flatten LangChain / LangGraph values into JSON Langfuse UI can render.
 * Raw LC wire format (`{lc:1,type:"constructor",id:[...],kwargs:{...}}`) is opaque
 * in the Langfuse span I/O panel — normalize to {role, content} / plain tool payloads.
 */
export function normalizeLangfuseValue(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? redactForLangfuse(value) : value;
  }

  // Live BaseMessage-like
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { _getType?: () => string })._getType === "function"
  ) {
    const m = value as {
      _getType: () => string;
      content?: unknown;
      name?: string;
      tool_calls?: unknown;
      additional_kwargs?: Record<string, unknown>;
    };
    const role = m._getType();
    const out: Record<string, unknown> = {
      role,
      content: redactForLangfuse(messageContentToString(m.content)),
    };
    if (m.name) out.name = m.name;
    const toolCalls = m.tool_calls ?? m.additional_kwargs?.tool_calls;
    if (toolCalls) out.tool_calls = normalizeLangfuseValue(toolCalls, depth + 1);
    return out;
  }

  // LangChain serialized constructor blob
  if (isLcSerialized(value)) {
    const id = value.id ?? [];
    const kwargs = value.kwargs ?? {};
    const kind = id[id.length - 1] ?? value.type ?? "object";

    // Messages
    if (id.some((p) => /messages/i.test(p)) || /Message$/i.test(String(kind))) {
      const out: Record<string, unknown> = {
        role: lcMessageRole(id, kwargs),
        content: redactForLangfuse(messageContentToString(kwargs.content)),
      };
      if (kwargs.name) out.name = kwargs.name;
      if (kwargs.tool_call_id) out.tool_call_id = kwargs.tool_call_id;
      if (kwargs.tool_calls) out.tool_calls = normalizeLangfuseValue(kwargs.tool_calls, depth + 1);
      if (kwargs.status) out.status = kwargs.status;
      return out;
    }

    // Tool / Command / Send wrappers — unwrap useful fields
    if (kwargs.content != null && Object.keys(kwargs).length <= 6) {
      return {
        type: kind,
        content: redactForLangfuse(messageContentToString(kwargs.content)),
        ...Object.fromEntries(
          Object.entries(kwargs)
            .filter(([k]) => k !== "content" && k !== "id" && k !== "additional_kwargs")
            .map(([k, v]) => [k, normalizeLangfuseValue(v, depth + 1)]),
        ),
      };
    }

    return {
      type: kind,
      ...Object.fromEntries(
        Object.entries(kwargs)
          .filter(([k]) => !["id", "additional_kwargs", "response_metadata", "usage_metadata"].includes(k))
          .slice(0, 20)
          .map(([k, v]) => [k, normalizeLangfuseValue(v, depth + 1)]),
      ),
    };
  }

  if (Array.isArray(value)) {
    // Message list → chat-style array Langfuse renders well
    if (
      value.length &&
      value.every(
        (x) =>
          isLcSerialized(x) ||
          (x &&
            typeof x === "object" &&
            typeof (x as { _getType?: () => string })._getType === "function"),
      )
    ) {
      return value.map((x) => normalizeLangfuseValue(x, depth + 1));
    }
    return value.map((x) => normalizeLangfuseValue(x, depth + 1));
  }

  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Graph state often { messages: [...] }
    if (Array.isArray(o.messages)) {
      const rest = Object.fromEntries(
        Object.entries(o)
          .filter(([k]) => k !== "messages")
          .map(([k, v]) => [k, normalizeLangfuseValue(v, depth + 1)]),
      );
      return {
        messages: o.messages.map((m) => normalizeLangfuseValue(m, depth + 1)),
        ...rest,
      };
    }
    // LangGraph Command-like { output: [...] } or { update: { messages } }
    if (o.output != null && Object.keys(o).length <= 3) {
      return { output: normalizeLangfuseValue(o.output, depth + 1) };
    }
    if (o.update && typeof o.update === "object") {
      return {
        type: o.lg_name ?? "update",
        update: normalizeLangfuseValue(o.update, depth + 1),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o).slice(0, 40)) {
      // Drop huge binary / internal keys
      if (k.startsWith("lc_") || k === "id" && isLcSerialized(o)) continue;
      out[k] = normalizeLangfuseValue(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

/**
 * Safe payload for Langfuse span/generation I/O (normalized + redacted + size-capped).
 */
export function safeJson(value: unknown, max = 12_000): unknown {
  try {
    if (value == null) return value;
    const normalized = normalizeLangfuseValue(value);
    if (typeof normalized === "string") {
      const red = redactForLangfuse(normalized);
      return red.length > max ? `${red.slice(0, max)}\n…[truncated]` : red;
    }
    const s = JSON.stringify(normalized);
    const red = redactForLangfuse(s);
    if (red.length > max) {
      // Prefer truncated string over invalid half-JSON for UI
      return `${red.slice(0, max)}\n…[truncated]`;
    }
    try {
      return JSON.parse(red) as unknown;
    } catch {
      return red;
    }
  } catch {
    return "[unserializable]";
  }
}

/** Full messages for product ClickHouse (secrets redacted, never truncated). */
function serializeMessages(messages: BaseMessage[][]): unknown {
  return messages.map((thread) =>
    thread.map((m) => {
      const role =
        typeof (m as { _getType?: () => string })._getType === "function"
          ? (m as { _getType: () => string })._getType()
          : ((m as { role?: string }).role ?? m.constructor?.name ?? "message");
      const row: Record<string, unknown> = {
        role,
        content: redactSecretsOnly(messageContentToString(m.content)),
      };
      const toolCalls =
        (m as { tool_calls?: unknown }).tool_calls ??
        (m as { additional_kwargs?: { tool_calls?: unknown } }).additional_kwargs?.tool_calls;
      if (toolCalls) row.tool_calls = normalizeLangfuseValue(toolCalls);
      return row;
    }),
  );
}

/** Size-capped copy for Langfuse UI only (not product storage). */
function forLangfuseIo(value: unknown): unknown {
  return safeJson(value, 12_000);
}

/**
 * Langfuse modelParameters values must be MapValue:
 *   string | number | boolean | string[] | null
 * Passing LangChain invocation_params (tools as object[]) causes HTTP 400
 * and generations never land — traces appear empty.
 */
export function sanitizeModelParameters(
  params: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | string[] | null> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const out: Record<string, string | number | boolean | string[] | null> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (raw == null) {
      out[key] = null;
      continue;
    }
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.every((x) => typeof x === "string")) {
        out[key] = raw as string[];
        continue;
      }
      // tools / functions / etc. — keep names only + count
      if (key === "tools" || key === "functions") {
        const names = raw
          .map((t) => {
            if (typeof t === "string") return t;
            if (t && typeof t === "object") {
              const o = t as Record<string, unknown>;
              const fn = o.function as Record<string, unknown> | undefined;
              return String(fn?.name ?? o.name ?? o.type ?? "tool");
            }
            return null;
          })
          .filter((n): n is string => Boolean(n));
        out[`${key}Count`] = raw.length;
        if (names.length) out[`${key}Names`] = names.slice(0, 40);
        continue;
      }
      // other arrays of mixed types → JSON string
      try {
        out[key] = redactForLangfuse(JSON.stringify(raw)).slice(0, 2000);
      } catch {
        out[key] = `[array:${raw.length}]`;
      }
      continue;
    }
    if (typeof raw === "object") {
      try {
        out[key] = redactForLangfuse(JSON.stringify(raw)).slice(0, 2000);
      } catch {
        out[key] = "[object]";
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Flatten metadata to JSON-safe primitives (avoid nested objects that break ingestion). */
function sanitizeMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
      out[k] = v;
      continue;
    }
    try {
      out[k] = redactForLangfuse(JSON.stringify(v)).slice(0, 1500);
    } catch {
      out[k] = String(v);
    }
  }
  return out;
}

function extractLlmOutput(output: LLMResult): {
  text: unknown;
  usage?: Record<string, number>;
  model?: string;
} {
  const gens = output.generations?.[0] ?? [];
  const parts: unknown[] = [];
  for (const g of gens) {
    const msg = (g as { message?: unknown }).message;
    if (msg) {
      parts.push(normalizeLangfuseValue(msg));
      continue;
    }
    const t = (g as { text?: string }).text;
    if (t) parts.push(redactForLangfuse(t));
  }
  const llmOut = output.llmOutput as Record<string, unknown> | undefined;
  const tokenUsage =
    (llmOut?.tokenUsage as Record<string, unknown> | undefined) ??
    (llmOut?.token_usage as Record<string, unknown> | undefined) ??
    (llmOut?.usage as Record<string, unknown> | undefined);
  let usage: Record<string, number> | undefined;
  if (tokenUsage) {
    const promptTokens = Number(
      tokenUsage.promptTokens ?? tokenUsage.prompt_tokens ?? tokenUsage.input_tokens ?? 0,
    );
    const completionTokens = Number(
      tokenUsage.completionTokens ??
        tokenUsage.completion_tokens ??
        tokenUsage.output_tokens ??
        0,
    );
    const totalTokens = Number(
      tokenUsage.totalTokens ?? tokenUsage.total_tokens ?? promptTokens + completionTokens,
    );
    usage = {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };
  }
  const model =
    typeof llmOut?.model_name === "string"
      ? llmOut.model_name
      : typeof llmOut?.model === "string"
        ? llmOut.model
        : undefined;

  let text: unknown;
  if (parts.length === 1) text = parts[0];
  else if (parts.length > 1) text = parts;
  else text = safeJson(output);

  return { text, usage, model };
}

function serializedName(ser: Serialized, fallback: string): string {
  if (ser && typeof ser === "object") {
    const id = (ser as { id?: string[] }).id;
    if (Array.isArray(id) && id.length) return String(id[id.length - 1]);
    const name = (ser as { name?: string }).name;
    if (name) return String(name);
  }
  return fallback;
}

type BoundTrace = {
  lf: NonNullable<Awaited<ReturnType<typeof getLangfuse>>>;
  /** Langfuse trace id — always prefixed with review sessionId when set */
  traceId: string;
  /** Review session id for Langfuse Sessions UI (must match current review) */
  sessionId: string | undefined;
};

/**
 * One handler dual-writes to every configured Langfuse destination.
 *
 * Important isolation rules:
 * - Handler `name` includes sessionId so LangChain never merges/reuses handlers across reviews
 * - Observation ids are prefixed with sessionId (prevents cross-session observation upsert)
 * - Use client.generation/span directly with explicit `traceId` (TraceClient.generation
 *   overwrites parentObservationId with null and can confuse nesting)
 */
type PendingCh = {
  kind: "generation" | "span" | "tool";
  name: string;
  input?: unknown;
  model?: string;
  startedAt: number;
  metadata?: Record<string, unknown>;
};

export class DualLangfuseCallbackHandler extends BaseCallbackHandler {
  /** Unique per review so ALS/inherit never reuses another session's handler by name */
  override name: string;
  override awaitHandlers = true;

  private readonly destinations: LangfuseCredentials[];
  private readonly clickhouse: ClickHouseWriter | null;
  private readonly ctx: LangfuseTraceContext;
  private readonly role: string;
  private readonly unitId?: string;
  private readonly unitLabel?: string;
  private readonly repoId?: string;
  private readonly tenantId?: string;
  private readonly resolvedTraceId: string;

  /** runId → open observations (one per destination) */
  private readonly open = new Map<string, DestRun[]>();
  /** Per-destination bound client + trace (this handler instance only) */
  private readonly bound = new Map<string, BoundTrace>();
  /** Pending ClickHouse rows until end (full input+output) */
  private readonly chPending = new Map<string, PendingCh>();
  private loggedSession = false;

  constructor(opts: DualLangfuseCallbackOptions) {
    super();
    this.destinations = (opts.destinations ?? []).filter(
      (d) => d.enabled !== false && d.publicKey?.trim() && d.secretKey?.trim(),
    );
    this.clickhouse = opts.clickhouse?.enabled ? opts.clickhouse : null;
    const sessionId = sanitizeLangfuseSessionId(opts.sessionId);
    this.role = opts.role;
    this.unitId = opts.unitId;
    this.unitLabel = opts.unitLabel;
    this.repoId = opts.repoId;
    this.tenantId = opts.tenantId;
    // Unique handler name → no cross-session callback reuse by name
    this.name = `cs_lf_${sessionId ?? "nosession"}_${opts.role}_${opts.unitId ?? "u"}`;

    // Trace id must stay under this review's session — never a prior session's id
    let traceId = String(opts.traceId ?? "").trim() || sessionId || `trace_${Date.now()}`;
    if (sessionId && !traceId.startsWith(sessionId)) {
      traceId = `${sessionId}:${traceId}`;
    }
    // Allow structured ids (colons); only strip non-ASCII / cap length
    traceId = (sanitizeLangfuseSessionId(traceId) ?? traceId).slice(0, 200);
    this.resolvedTraceId = traceId;

    this.ctx = {
      sessionId,
      userId: opts.userId,
      orgId: opts.orgId,
      role: opts.role,
      traceId: this.resolvedTraceId,
      traceName: opts.traceName ?? "codesteward.review",
      metadata: {
        runner: "deepagents",
        unitId: opts.unitId,
        unitLabel: opts.unitLabel,
        reviewSessionId: sessionId,
        ...opts.metadata,
      },
    };
  }

  static create(opts: DualLangfuseCallbackOptions): DualLangfuseCallbackHandler | null {
    const hasLf = (opts.destinations ?? []).some(
      (d) => d.enabled !== false && d.publicKey?.trim() && d.secretKey?.trim(),
    );
    const hasCh = Boolean(opts.clickhouse?.enabled);
    if (!hasLf && !hasCh) return null;
    if (!sanitizeLangfuseSessionId(opts.sessionId) && !opts.sessionId?.trim()) {
      console.warn(
        "[langfuse] DeepAgents callback created without sessionId — session grouping will be weak",
      );
    }
    return new DualLangfuseCallbackHandler(opts);
  }

  private destKey(d: LangfuseCredentials): string {
    // Include sessionId so even process-level mistakes cannot reuse another review's binding
    return `${d.publicKey}\0${d.baseUrl ?? ""}\0${this.ctx.sessionId ?? ""}`;
  }

  /** Observation ids scoped to this review — never collide with another session's runs */
  private obsId(runId: string): string {
    const sid = this.ctx.sessionId ?? "nosession";
    return `${sid}:obs:${runId}`.slice(0, 200);
  }

  private async ensureTrace(dest: LangfuseCredentials): Promise<BoundTrace | null> {
    const key = this.destKey(dest);
    const cached = this.bound.get(key);
    if (cached) {
      // Guard: never return a binding for a different review session
      if (cached.sessionId !== this.ctx.sessionId) {
        console.error(
          `[langfuse] refusing sticky session binding: bound=${cached.sessionId} current=${this.ctx.sessionId}`,
        );
        this.bound.delete(key);
      } else {
        return cached;
      }
    }
    const lf = await getLangfuse(dest);
    if (!lf) return null;

    const sessionId = this.ctx.sessionId;
    const args = buildLangfuseTraceArgs(
      { ...this.ctx, sessionId, traceId: this.resolvedTraceId },
      dest.source,
      { name: this.ctx.traceName ?? "codesteward.review" },
    );
    // Force authoritative session fields (Langfuse Sessions UI groups on body.sessionId)
    args.id = this.resolvedTraceId;
    if (sessionId) {
      args.sessionId = sessionId;
    } else {
      delete args.sessionId;
    }
    args.metadata = {
      ...((args.metadata as Record<string, unknown>) ?? {}),
      sessionId,
      reviewSessionId: sessionId,
      traceId: this.resolvedTraceId,
    };

    if (!this.loggedSession) {
      this.loggedSession = true;
      console.info(
        `[langfuse] open trace sessionId=${sessionId ?? "(none)"} traceId=${this.resolvedTraceId} role=${this.role} dest=${dest.source ?? "?"}`,
      );
    }

    lf.trace(args);
    const binding: BoundTrace = { lf, traceId: this.resolvedTraceId, sessionId };
    this.bound.set(key, binding);
    return binding;
  }

  private async startObs(
    runId: string,
    parentRunId: string | undefined,
    kind: "generation" | "span",
    body: Record<string, unknown>,
  ): Promise<void> {
    const handles: DestRun[] = [];
    const { metadata: bodyMeta, ...rest } = body;
    const obsName = String(rest.name ?? kind);
    const chKind: PendingCh["kind"] =
      kind === "generation"
        ? "generation"
        : String(obsName).startsWith("tool:")
          ? "tool"
          : "span";

    // Product ClickHouse: prefer full payload (inputFull); never use Langfuse-capped copy
    const chInput = rest.inputFull !== undefined ? rest.inputFull : rest.input;
    if (this.clickhouse && this.ctx.sessionId) {
      this.chPending.set(runId, {
        kind: chKind,
        name: obsName,
        input: chInput,
        model: rest.model != null ? String(rest.model) : undefined,
        startedAt: Date.now(),
        metadata: {
          parentObservationId: parentRunId ? this.obsId(parentRunId) : undefined,
          ...((bodyMeta as Record<string, unknown> | undefined) ?? {}),
        },
      });
    }

    for (const dest of this.destinations) {
      try {
        const binding = await this.ensureTrace(dest);
        if (!binding) continue;
        if (binding.sessionId !== this.ctx.sessionId) {
          console.error(
            `[langfuse] session mismatch at observation: bound=${binding.sessionId} expected=${this.ctx.sessionId}`,
          );
          continue;
        }

        const rawParams = rest.modelParameters as Record<string, unknown> | undefined;
        const modelParameters = sanitizeModelParameters(rawParams);
        const {
          modelParameters: _drop,
          inputFull: _if,
          outputFull: _of,
          ...restWithoutParams
        } = rest;
        // Langfuse may size-cap; product store keeps full via inputFull
        const lfInput =
          rest.inputLf !== undefined ? rest.inputLf : forLangfuseIo(rest.input);
        const args: Record<string, unknown> = {
          ...restWithoutParams,
          input: lfInput,
          // Session-scoped ids prevent Langfuse upsert into a prior review's observation
          id: this.obsId(runId),
          traceId: binding.traceId,
          parentObservationId: parentRunId ? this.obsId(parentRunId) : undefined,
          ...(modelParameters ? { modelParameters } : {}),
          metadata: sanitizeMetadata({
            sessionId: this.ctx.sessionId,
            reviewSessionId: this.ctx.sessionId,
            orgId: this.ctx.orgId,
            role: this.role,
            unitId: this.unitId,
            unitLabel: this.unitLabel,
            langfuseSource: dest.source,
            ...((bodyMeta as Record<string, unknown> | undefined) ?? {}),
          }),
        };
        delete (args as { inputLf?: unknown }).inputLf;

        // Call client.generation/span DIRECTLY (not TraceClient) so parentObservationId
        // is preserved and traceId is explicit for this review.
        let obs: Endable | undefined;
        if (kind === "generation") {
          obs = binding.lf.generation(args);
        } else if (typeof binding.lf.span === "function") {
          obs = binding.lf.span(args);
        } else {
          obs = binding.lf.generation({
            ...args,
            name: `span:${String(args.name ?? "run")}`,
          });
        }
        if (obs) handles.push({ source: dest.source, obs });
      } catch (err) {
        console.warn(
          "[langfuse] start observation failed",
          dest.source,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (handles.length) this.open.set(runId, handles);
  }

  private endObs(runId: string, endArgs: Record<string, unknown>): void {
    const handles = this.open.get(runId);
    if (handles) {
      this.open.delete(runId);
      const { outputFull: _omit, ...lfEnd } = endArgs;
      for (const h of handles) {
        try {
          h.obs.end(lfEnd);
        } catch {
          /* per-dest */
        }
      }
    }

    const pending = this.chPending.get(runId);
    if (pending && this.clickhouse && this.ctx.sessionId) {
      this.chPending.delete(runId);
      const usage = endArgs.usage as
        | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
        | undefined;
      const level =
        endArgs.level === "ERROR" || endArgs.level === "WARNING" || endArgs.level === "DEBUG"
          ? (endArgs.level as "ERROR" | "WARNING" | "DEBUG")
          : "DEFAULT";
      try {
        this.clickhouse.record({
          orgId: this.ctx.orgId ?? "local",
          sessionId: this.ctx.sessionId,
          traceId: this.resolvedTraceId,
          observationId: this.obsId(runId),
          parentObservationId:
            typeof pending.metadata?.parentObservationId === "string"
              ? pending.metadata.parentObservationId
              : undefined,
          kind: pending.kind,
          name: pending.name,
          role: this.role,
          model:
            (typeof endArgs.model === "string" ? endArgs.model : undefined) ?? pending.model,
          unitId: this.unitId,
          unitLabel: this.unitLabel,
          repoId: this.repoId,
          tenantId: this.tenantId,
          runner: "deepagents",
          level,
          statusMessage:
            typeof endArgs.statusMessage === "string" ? endArgs.statusMessage : undefined,
          input: pending.input,
          // Prefer full output for product store (Langfuse may get a capped copy)
          output:
            endArgs.outputFull !== undefined ? endArgs.outputFull : endArgs.output,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          durationMs: Math.max(0, Date.now() - pending.startedAt),
          metadata: {
            sessionId: this.ctx.sessionId,
            reviewSessionId: this.ctx.sessionId,
            ...pending.metadata,
          },
        });
      } catch (err) {
        console.warn(
          "[clickhouse] record failed",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  override async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const model =
      (extraParams?.invocation_params as { model?: string } | undefined)?.model ??
      (metadata?.ls_model_name as string | undefined) ??
      serializedName(llm, "chat_model");
    const inv = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const fullMessages = serializeMessages(messages);
    await this.startObs(runId, parentRunId, "generation", {
      name: runName ?? `chat.${this.role}`,
      model: String(model),
      input: fullMessages,
      inputFull: fullMessages,
      inputLf: forLangfuseIo(fullMessages),
      modelParameters: inv,
      metadata: {
        langfuseKind: "chat_model",
        ls_model_name: metadata?.ls_model_name,
        ls_provider: metadata?.ls_provider,
        langgraph_node: metadata?.langgraph_node,
        checkpoint_ns: metadata?.checkpoint_ns,
      },
    });
  }

  override async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    // Chat models also fire handleChatModelStart in modern LC — skip double if already open
    if (this.open.has(runId)) return;
    const model =
      (extraParams?.invocation_params as { model?: string } | undefined)?.model ??
      serializedName(llm, "llm");
    const inv = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    await this.startObs(runId, parentRunId, "generation", {
      name: runName ?? `llm.${this.role}`,
      model: String(model),
      input: prompts.map((p) => redactForLangfuse(p)),
      modelParameters: inv,
      metadata: {
        langfuseKind: "llm",
        ls_model_name: metadata?.ls_model_name,
        ls_provider: metadata?.ls_provider,
        langgraph_node: metadata?.langgraph_node,
      },
    });
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const { text, usage, model } = extractLlmOutput(output);
    this.endObs(runId, {
      output: forLangfuseIo(text),
      outputFull: text,
      ...(usage
        ? {
            usage: {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            },
          }
        : {}),
      ...(model ? { model } : {}),
    });
  }

  override async handleLLMError(err: Error, runId: string): Promise<void> {
    this.endObs(runId, {
      output: err instanceof Error ? err.message : String(err),
      level: "ERROR",
      statusMessage: err instanceof Error ? err.message : String(err),
    });
  }

  override async handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    _runType?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
  ): Promise<void> {
    const name = runName ?? serializedName(chain, "chain");
    const fullIn = normalizeLangfuseValue(inputs);
    await this.startObs(runId, parentRunId, "span", {
      name: String(name),
      input: fullIn,
      inputFull: fullIn,
      inputLf: forLangfuseIo(fullIn),
      metadata: {
        langfuseKind: "chain",
        langgraph_node: metadata?.langgraph_node,
        checkpoint_ns: metadata?.checkpoint_ns,
        ls_run_depth: metadata?.ls_run_depth,
      },
    });
  }

  override async handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
  ): Promise<void> {
    const full = normalizeLangfuseValue(outputs);
    this.endObs(runId, {
      output: forLangfuseIo(full),
      outputFull: full,
    });
  }

  override async handleChainError(err: Error, runId: string): Promise<void> {
    this.endObs(runId, {
      output: err instanceof Error ? err.message : String(err),
      level: "ERROR",
      statusMessage: err instanceof Error ? err.message : String(err),
    });
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const name = runName ?? serializedName(tool, "tool");
    // Tool input is often a JSON string; parse when possible for structured UI
    let parsedInput: unknown = input;
    if (typeof input === "string") {
      const t = input.trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        try {
          parsedInput = JSON.parse(t) as unknown;
        } catch {
          parsedInput = redactForLangfuse(input);
        }
      } else {
        parsedInput = redactForLangfuse(input);
      }
    }
    const fullIn = normalizeLangfuseValue(parsedInput);
    await this.startObs(runId, parentRunId, "span", {
      name: `tool:${name}`,
      input: fullIn,
      inputFull: fullIn,
      inputLf: forLangfuseIo(fullIn),
      metadata: {
        langfuseKind: "tool",
        toolName: name,
        langgraph_node: metadata?.langgraph_node,
      },
    });
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    const full = normalizeLangfuseValue(output);
    this.endObs(runId, {
      output: forLangfuseIo(full),
      outputFull: full,
    });
  }

  override async handleToolError(err: Error, runId: string): Promise<void> {
    this.endObs(runId, {
      output: err instanceof Error ? err.message : String(err),
      level: "ERROR",
      statusMessage: err instanceof Error ? err.message : String(err),
    });
  }

  override async handleAgentAction(
    action: AgentAction,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    await this.startObs(runId, parentRunId, "span", {
      name: `agent_action:${action.tool}`,
      input: safeJson({ tool: action.tool, toolInput: action.toolInput, log: action.log }),
      metadata: { langfuseKind: "agent_action" },
    });
    // Agent actions are often not paired with end on same runId — end immediately as event-like span
    this.endObs(runId, { output: safeJson({ tool: action.tool }) });
  }

  override async handleAgentEnd(
    action: AgentFinish,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    await this.startObs(runId, parentRunId, "span", {
      name: "agent_end",
      input: safeJson(action.returnValues),
      metadata: { langfuseKind: "agent_end" },
    });
    this.endObs(runId, { output: safeJson(action.returnValues) });
  }
}

export function createDualLangfuseCallbacks(
  opts: DualLangfuseCallbackOptions,
): DualLangfuseCallbackHandler[] {
  const h = DualLangfuseCallbackHandler.create(opts);
  return h ? [h] : [];
}

/** @deprecated alias — dual-write Langfuse + optional ClickHouse */
export const createTraceCallbacks = createDualLangfuseCallbacks;
