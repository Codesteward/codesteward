import type { AgentRole, FindingCandidate, ReviewUnit } from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";
import {
  resolveModelForRole,
  type ModelRouter,
} from "@codesteward/model-router";
import type { Policy } from "@codesteward/policy";
import type { Sandbox } from "@codesteward/sandbox";
import { createSandbox } from "@codesteward/sandbox";
import {
  extractFindingsFromLlm,
  resolveSpecialistRunConfidence,
} from "./extract.js";
import type { AgentRunner, RunnerDeps } from "./runner.js";
import { SimpleAgentRunner } from "./runner.js";
import type { SpecialistContext } from "./specialists.js";
import { renderSpecialistSystem, renderSpecialistUser } from "./prompt-pack.js";
import { createGraphTools } from "./tools/graph-tools.js";
import { createSandboxTools } from "./tools/sandbox-tools.js";
import {
  mapPool,
  maxSpecialistsPerUnit,
  specialistTimeoutMs,
  withTimeout,
} from "./concurrency.js";

export interface DeepAgentRunnerOptions extends RunnerDeps {
  sandbox?: Sandbox;
  /** Model string for DeepAgents, e.g. openai:gpt-4.1-mini */
  modelName?: string;
  /** Force SimpleAgentRunner even if deepagents is installed */
  forceSimple?: boolean;
}

/**
 * Build a concrete LangChain chat model from the org matrix so DeepAgents
 * uses the same keys/base URL as SimpleAgentRunner (not host process.env alone).
 */
async function resolveDeepAgentsModel(
  router: ModelRouter,
  role: AgentRole,
): Promise<unknown> {
  try {
    const target = resolveModelForRole(role as never, router.getConfig());
    const provider = String(target.provider ?? "openai").toLowerCase();
    // Cap LangChain internal retries — default can be high and look like a hang under 429.
    const maxRetries = (() => {
      const n = Number(process.env.STEW_LLM_MAX_RETRIES ?? 4);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
    })();
    // Per-request timeout (ms) so a single tool-step LLM call cannot hang forever.
    const requestTimeout = (() => {
      const n = Number(process.env.STEW_LLM_REQUEST_TIMEOUT_MS ?? 120_000);
      return Number.isFinite(n) && n > 0 ? n : 120_000;
    })();

    if (provider === "anthropic") {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({
        model: target.model,
        anthropicApiKey: target.apiKey,
        maxRetries,
        timeout: requestTimeout,
      } as ConstructorParameters<typeof ChatAnthropic>[0]);
    }
    const { ChatOpenAI } = await import("@langchain/openai");
    const baseURL = target.baseUrl
      ? target.baseUrl.replace(/\/+$/, "").replace(/\/v1\/v1$/i, "/v1")
      : undefined;
    const isGpt5Family =
      /\bgpt-5\b/i.test(target.model) || /codex/i.test(target.model);
    const defaultHeaders =
      provider === "openrouter"
        ? {
            "HTTP-Referer":
              process.env.OPENROUTER_HTTP_REFERER ||
              process.env.STEW_PUBLIC_URL ||
              process.env.STEW_API_PUBLIC_URL ||
              "https://codesteward.ai",
            "X-Title":
              process.env.OPENROUTER_APP_TITLE ||
              process.env.STEW_OPENROUTER_TITLE ||
              "Codesteward Review",
            "X-OpenRouter-Title":
              process.env.OPENROUTER_APP_TITLE ||
              process.env.STEW_OPENROUTER_TITLE ||
              "Codesteward Review",
          }
        : undefined;
    return new ChatOpenAI({
      model: target.model,
      apiKey: target.apiKey,
      configuration: baseURL
        ? { baseURL, ...(defaultHeaders ? { defaultHeaders } : {}) }
        : defaultHeaders
          ? { defaultHeaders }
          : undefined,
      temperature: isGpt5Family ? 1 : 0.2,
      maxRetries,
      // Bound each model call; overall specialist still has STEW_SPECIALIST_TIMEOUT_MS
      timeout: requestTimeout,
    } as ConstructorParameters<typeof ChatOpenAI>[0]);
  } catch (err) {
    console.warn("[agents] resolveDeepAgentsModel failed, using string model", err);
  }
  // Fallback string (env-bound) — last resort
  const fromEnv =
    process.env.DEEPAGENTS_MODEL ??
    process.env.MODEL_NAME ??
    process.env.OPENAI_MODEL;
  if (fromEnv?.includes(":")) return fromEnv;
  if (fromEnv) return `openai:${fromEnv}`;
  if (role === "security" || role === "judge" || role === "verifier") {
    return process.env.MODEL_STRONG
      ? `openai:${process.env.MODEL_STRONG}`
      : "openai:gpt-4.1";
  }
  return "openai:gpt-4.1-mini";
}

/**
 * DeepAgents-backed runner with graph + sandbox tools.
 * Falls back to SimpleAgentRunner if deepagents cannot be loaded or STEW_USE_DEEPAGENTS=0.
 */
export class DeepAgentRunner implements AgentRunner {
  private readonly deps: DeepAgentRunnerOptions;
  private readonly fallback: SimpleAgentRunner;
  private readonly sandbox: Sandbox;
  private ready: boolean | null = null;
  private createDeepAgent: ((params: Record<string, unknown>) => { invoke: (i: unknown) => Promise<unknown> } | Promise<{ invoke: (i: unknown) => Promise<unknown> }>) | null =
    null;

  constructor(deps: DeepAgentRunnerOptions) {
    this.deps = deps;
    this.fallback = new SimpleAgentRunner(deps);
    this.sandbox = deps.sandbox ?? createSandbox("null");
  }

  private requireToolAgents(): boolean {
    return (
      process.env.STEW_REQUIRE_TOOL_AGENTS === "1" ||
      process.env.STEW_AUTH_STRICT === "1" ||
      process.env.NODE_ENV === "production"
    );
  }

  private async ensureDeepAgents(): Promise<boolean> {
    if (this.deps.forceSimple) return false;
    if (process.env.STEW_USE_DEEPAGENTS === "0") return false;
    if (this.ready !== null) return this.ready;
    try {
      const mod = await import("deepagents");
      this.createDeepAgent = mod.createDeepAgent as unknown as typeof this.createDeepAgent;
      this.ready = true;
      console.log("[agents] DeepAgents runner active");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.requireToolAgents()) {
        throw new Error(
          `deepagents package required under STEW_REQUIRE_TOOL_AGENTS/strict/prod: ${msg}`,
        );
      }
      console.warn("[agents] deepagents unavailable, using SimpleAgentRunner:", msg);
      this.ready = false;
      return false;
    }
  }

  async runSpecialist(role: AgentRole, ctx: SpecialistContext): Promise<FindingCandidate[]> {
    const ok = await this.ensureDeepAgents();
    if (!ok || !this.createDeepAgent) {
      if (this.requireToolAgents() && process.env.STEW_USE_DEEPAGENTS !== "0") {
        throw new Error(
          "Tool-using agents required; refusing silent SimpleAgentRunner fallback",
        );
      }
      return this.fallback.runSpecialist(role, {
        ...ctx,
        runnerKind: "simple",
      });
    }

    const graph = ctx.graph ?? this.deps.graph;
    const policy = ctx.policy ?? this.deps.policy;
    const modelRouter = ctx.modelRouter ?? this.deps.modelRouter;
    const unit = ctx.unit;

    let modelLabel: string | undefined;
    try {
      const target = resolveModelForRole(role as never, modelRouter.getConfig());
      modelLabel = `${target.provider}:${target.model}`;
    } catch {
      /* optional */
    }
    const runId = ctx.audit?.startRun({
      pathsReviewed: unit.paths,
      unitId: unit.id,
      unitLabel: unit.label,
      role,
      runner: "deepagents",
      model: modelLabel,
    });

    const { emitSpecialistProgress, startSpecialistHeartbeat } = await import(
      "./specialist-progress.js"
    );
    const startedAtMs = Date.now();
    emitSpecialistProgress(ctx.onEvent, {
      sessionId: ctx.sessionId,
      unitId: unit.id,
      unitLabel: unit.label,
      role,
      status: "started",
      model: modelLabel,
      runner: "deepagents",
    });
    const stopHeartbeat = startSpecialistHeartbeat({
      onEvent: ctx.onEvent,
      sessionId: ctx.sessionId,
      unitId: unit.id,
      unitLabel: unit.label,
      role,
      model: modelLabel,
      runner: "deepagents",
      startedAtMs,
    });

    let sandboxSessionId: string | undefined;
    try {
      // Prefer review-bound tree (clone/mount from job), not host REPO_PATH alone
      const repoPath =
        (unit.metadata?.repoPath as string | undefined) ||
        process.env.REPO_PATH;
      const session = await this.sandbox.createSession({
        repoPath,
        labels: { unit: unit.id, role },
      });
      sandboxSessionId = session.id;
    } catch {
      /* null sandbox may still work */
    }

    const tools = [
      ...createGraphTools(graph, {
        tenantId: ctx.tenantId,
        repoId: ctx.repoId,
      }),
      ...(sandboxSessionId ? createSandboxTools(this.sandbox, sandboxSessionId) : []),
    ];

    const rulesForPaths = policy.pathRules
      .slice(0, 20)
      .map((r) => `- ${r.pathScope}: ${r.title ?? r.id}`)
      .join("\n");
    const promptVars = {
      severity_floor: String(policy.severityFloor ?? "medium"),
      path_rules: rulesForPaths,
      org_learning: ctx.learningGuidance ?? "",
      session_id: ctx.sessionId,
      unit_label: unit.label,
      paths: unit.paths.map((p) => `- ${p}`).join("\n"),
      context_text: ctx.contextText
        ? ctx.contextText.slice(0, 16000)
        : "WARNING: No packed source/diff — use sandbox_read on unit paths before concluding.",
      graph_context: "",
    };
    const system = renderSpecialistSystem(ctx.promptPack, role, promptVars, { deep: true });
    let user = renderSpecialistUser(ctx.promptPack, role, promptVars);
    if (unit.metadata && Object.keys(unit.metadata).length) {
      user += `\n\nUnit metadata: ${JSON.stringify(unit.metadata).slice(0, 2000)}`;
    }

    try {
      // DeepAgents / LangGraph: framework-level checkpointing is opt-in.
      // Product session resume is still CodeSteward CheckpointStore (self-heal).
      // Pass a LangChain chat model bound to org matrix keys/base (LiteLLM etc.), not bare env.
      const model =
        this.deps.modelName ??
        (await resolveDeepAgentsModel(modelRouter, role));
      const agentArgs: Record<string, unknown> = {
        model,
        tools,
        systemPrompt: system,
      };
      if (process.env.STEW_LANGGRAPH_CHECKPOINT === "1") {
        console.warn(
          "[agents] STEW_LANGGRAPH_CHECKPOINT=1: framework checkpointer not fully integrated; using CodeSteward session checkpoints only",
        );
      }
      const agentMaybe = this.createDeepAgent(agentArgs);
      const agent = await Promise.resolve(agentMaybe);

      const timeoutMs = specialistTimeoutMs();
      console.info(
        `[agents] deepagent start role=${role} unit=${unit.label} timeoutMs=${timeoutMs}`,
      );
      const result = await withTimeout(
        agent.invoke({
          messages: [{ role: "user", content: user }],
        }),
        timeoutMs,
        `DeepAgent specialist ${role} (${unit.label})`,
      );

      // DeepAgents bypasses ModelRouter.complete — fold LangChain usage into session budget
      try {
        const deepUsage = extractUsageFromDeepResult(result);
        if (deepUsage.promptTokens + deepUsage.completionTokens + deepUsage.totalTokens > 0) {
          const target = resolveModelForRole(role as never, modelRouter.getConfig());
          modelRouter.getBudget().record({
            promptTokens: deepUsage.promptTokens,
            completionTokens: deepUsage.completionTokens,
            totalTokens: deepUsage.totalTokens,
            model: target.model,
          });
        }
      } catch {
        /* optional — never fail review on accounting */
      }

      const content = extractMessageContent(result);
      if (process.env.STEW_DEBUG_LLM === "1") {
        try {
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const dir = join(
            process.env.STEW_DATA_DIR ?? ".steward-data",
            "debug-llm",
            ctx.sessionId,
          );
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, `${role}-${Date.now()}.txt`),
            content || "(empty)",
            "utf8",
          );
          console.warn(
            `[deep-agent] role=${role} contentChars=${content.length} head=${content.slice(0, 120).replace(/\n/g, " ")}`,
          );
        } catch (e) {
          console.warn("[deep-agent] debug dump failed", e);
        }
      }
      const findings = extractFindingsFromLlm(content, {
        role,
        sessionId: ctx.sessionId,
        repoId: ctx.repoId,
        // deepagents path does not currently surface provider logprobs
      });
      if (findings.length === 0 && content.length > 50) {
        console.warn(
          `[deep-agent] role=${role} model returned ${content.length} chars but 0 findings extracted (peel/schema?)`,
        );
      }
      if (runId && ctx.audit) {
        const runConf = resolveSpecialistRunConfidence({
          findings,
          responseContent: content,
          pathsReviewed: unit.paths.length,
          usedGraph: true,
        });
        const findingsSummary =
          findings.length > 0
            ? findings.map((f) => ({
                title: f.title,
                severity: f.severity,
                confidence: f.confidence,
                modelConfidence: f.modelConfidence,
                tokenConfidence: f.tokenConfidence,
                path: f.path,
                startLine: f.startLine,
                category: f.category,
              }))
            : [
                {
                  title: "No findings",
                  severity: "info",
                  confidence: runConf.avgConfidence,
                  modelConfidence: runConf.modelEmptyScanConfidence,
                  category: "other",
                },
              ];
        ctx.audit.endRun(runId, {
          status: "ok",
          findingCount: findings.length,
          responseContent: content,
          toolCallCount: tools.length,
          usedGraph: true,
          pathsReviewed: unit.paths,
          avgConfidence: runConf.avgConfidence,
          findingsSummary,
        });
      }
      stopHeartbeat();
      emitSpecialistProgress(ctx.onEvent, {
        sessionId: ctx.sessionId,
        unitId: unit.id,
        unitLabel: unit.label,
        role,
        status: "completed",
        model: modelLabel,
        runner: "deepagents",
        findingCount: findings.length,
        durationMs: Date.now() - startedAtMs,
      });
      // Mark tool-using path for evals/product metrics (K11)
      for (const f of findings) {
        const ev = Array.isArray(f.evidence) ? f.evidence : [];
        f.evidence = [
          ...ev,
          {
            type: "tool" as const,
            id: `deepagent-${role}`,
            summary: "DeepAgent tool-using runner",
            payload: { runner: "deepagents", tools: tools.map((x) => (x as { name?: string }).name ?? "tool") },
          },
        ];
      }
      return findings;
    } catch (err) {
      stopHeartbeat();
      const { recordSpecialistFailure, isTimeoutError, specialistTimeoutGapFinding } =
        await import("./specialist-timeout.js");
      const fail = recordSpecialistFailure({
        audit: ctx.audit,
        onEvent: ctx.onEvent,
        sessionId: ctx.sessionId,
        unitId: unit.id,
        unitLabel: unit.label,
        role,
        model: modelLabel,
        runner: "deepagents",
        err,
        startedAtMs,
        runId,
      });
      // Timeouts: do not waste another full simple run; surface coverage gap instead
      if (isTimeoutError(err)) {
        console.warn(
          `[agents] DeepAgent specialist ${role} TIMED OUT after ${fail.durationMs}ms (budget ${fail.timeoutMs ?? "?"}ms) unit=${unit.label}`,
        );
        return [
          specialistTimeoutGapFinding({
            role,
            unitLabel: unit.label,
            unitPaths: unit.paths,
            sessionId: ctx.sessionId,
            repoId: ctx.repoId,
            timeoutMs: fail.timeoutMs ?? specialistTimeoutMs(),
            durationMs: fail.durationMs,
            runner: "deepagents",
          }),
        ];
      }
      if (this.requireToolAgents() && process.env.STEW_USE_DEEPAGENTS !== "0") {
        throw new Error(
          `DeepAgent specialist ${role} failed under tool-agent requirement (no Simple fallback): ${fail.message}`,
        );
      }
      console.warn(`[agents] DeepAgent specialist ${role} failed, fallback:`, fail.message);
      return this.fallback.runSpecialist(role, {
        ...ctx,
        runnerKind: "simple",
      });
    } finally {
      if (sandboxSessionId) {
        try {
          await this.sandbox.destroy(sandboxSessionId);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async runUnit(
    roles: AgentRole[],
    ctx: SpecialistContext,
  ): Promise<FindingCandidate[]> {
    const concurrency = maxSpecialistsPerUnit();
    // Parallel roles with cap; each runSpecialist has its own timeout so one hang cannot block the unit forever
    const batches = await mapPool(roles, concurrency, async (role) => {
      try {
        return await this.runSpecialist(role, ctx);
      } catch (err) {
        const {
          isTimeoutError,
          specialistTimeoutGapFinding,
          timeoutMsFromError,
        } = await import("./specialist-timeout.js");
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[agents] specialist ${role} on ${ctx.unit.label} failed (continuing unit): ${msg}`,
        );
        // Soft-fail: other roles' findings still count; timeouts leave a coverage-gap finding
        if (isTimeoutError(err)) {
          return [
            specialistTimeoutGapFinding({
              role,
              unitLabel: ctx.unit.label,
              unitPaths: ctx.unit.paths,
              sessionId: ctx.sessionId,
              repoId: ctx.repoId,
              timeoutMs: timeoutMsFromError(err) ?? specialistTimeoutMs(),
              runner: "deepagents",
            }),
          ];
        }
        return [];
      }
    });
    return batches.flat();
  }
}

/**
 * Pull token usage from LangChain / DeepAgents invoke result messages.
 * Handles usage_metadata (LC) and response_metadata.usage (OpenAI-style).
 */
function extractUsageFromDeepResult(result: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  if (!result || typeof result !== "object") {
    return { promptTokens, completionTokens, totalTokens };
  }
  const r = result as {
    messages?: Array<Record<string, unknown>>;
    usage_metadata?: Record<string, unknown>;
  };
  const msgs = Array.isArray(r.messages) ? r.messages : [];
  const candidates: Array<Record<string, unknown>> = [...msgs];
  if (r.usage_metadata) candidates.push(r);

  for (const m of candidates) {
    if (!m || typeof m !== "object") continue;
    const um = m.usage_metadata as Record<string, unknown> | undefined;
    if (um) {
      const p = Number(um.input_tokens ?? um.prompt_tokens ?? um.promptTokens ?? 0);
      const c = Number(um.output_tokens ?? um.completion_tokens ?? um.completionTokens ?? 0);
      const t = Number(um.total_tokens ?? um.totalTokens ?? 0);
      if (Number.isFinite(p)) promptTokens += Math.max(0, p);
      if (Number.isFinite(c)) completionTokens += Math.max(0, c);
      if (Number.isFinite(t)) totalTokens += Math.max(0, t);
      continue;
    }
    const rm = m.response_metadata as Record<string, unknown> | undefined;
    const usage =
      (rm?.usage as Record<string, unknown> | undefined) ??
      (rm?.token_usage as Record<string, unknown> | undefined) ??
      (rm?.tokenUsage as Record<string, unknown> | undefined);
    if (usage) {
      const p = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0);
      const c = Number(
        usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0,
      );
      const t = Number(usage.total_tokens ?? usage.totalTokens ?? 0);
      if (Number.isFinite(p)) promptTokens += Math.max(0, p);
      if (Number.isFinite(c)) completionTokens += Math.max(0, c);
      if (Number.isFinite(t)) totalTokens += Math.max(0, t);
    }
  }
  if (totalTokens === 0 && promptTokens + completionTokens > 0) {
    totalTokens = promptTokens + completionTokens;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function extractMessageContent(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as { messages?: Array<{ content?: unknown; type?: string; role?: string }> };
  const messages = r.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return JSON.stringify(result).slice(0, 20000);
  }

  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    // Skip pure human/user echoes when possible
    const role = String(m.role ?? m.type ?? "").toLowerCase();
    if (role === "human" || role === "user") continue;
    const c = m.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part)
            return String((part as { text: string }).text);
          return "";
        })
        .join("");
    }
    if (text.trim()) texts.push(text);
  }

  // Prefer a message that looks like findings JSON
  for (const t of texts) {
    if (/["']findings["']\s*:/.test(t) || /^\s*\{/.test(t.trim())) return t;
  }
  if (texts[0]) return texts[0];
  return JSON.stringify(result).slice(0, 20000);
}

export async function tryCreateDeepAgentRunner(
  deps: DeepAgentRunnerOptions,
): Promise<AgentRunner> {
  const runner = new DeepAgentRunner(deps);
  // Probe load
  if (process.env.STEW_USE_DEEPAGENTS === "0") {
    return new SimpleAgentRunner(deps);
  }
  return runner;
}
