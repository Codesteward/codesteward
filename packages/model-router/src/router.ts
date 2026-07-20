import type { AgentRole } from "@codesteward/core";
import { createTokenBudget } from "./budget.js";
import {
  loadEnvModelConfig,
  mergeRoleOverrides,
  resolveModelForRole,
  type EnvModelConfig,
} from "./config.js";
import {
  withLangfuseGeneration,
  type LangfuseCredentials,
} from "./langfuse.js";
import type { ClickHouseWriter } from "./clickhouse.js";
import { createAnthropicModel } from "./providers/anthropic.js";
import { createOpenAICompatModel } from "./providers/openai-compat.js";
import type { ChatModel, ModelRole, TokenBudget } from "./types.js";
import { randomUUID } from "node:crypto";

export interface ModelRouter {
  createChatModel(role: ModelRole | AgentRole): ChatModel;
  getBudget(): TokenBudget;
  getConfig(): EnvModelConfig;
  /**
   * Org/platform Langfuse destinations for this router (if any).
   * Used by DeepAgents path which bypasses createChatModel().complete.
   */
  getLangfuseDestinations(): LangfuseCredentials[];
  /** Platform ClickHouse writer when platform sink is enabled (all orgs). */
  getClickHouseWriter(): ClickHouseWriter | null;
}

export function createModelRouter(
  env: NodeJS.ProcessEnv = process.env,
  opts?: {
    config?: EnvModelConfig;
    sessionId?: string;
    orgId?: string;
    /**
     * Langfuse destination(s). Prefer `langfuseDestinations` when both org + platform
     * projects should receive traces. Single `langfuse` still supported.
     */
    langfuse?: LangfuseCredentials | null;
    langfuseDestinations?: LangfuseCredentials[] | null;
    /** Platform ClickHouse dual-write (enablement is platform-only). */
    clickhouse?: ClickHouseWriter | null;
  },
): ModelRouter {
  const cfg = opts?.config ?? loadEnvModelConfig(env);
  const budget = createTokenBudget(cfg.maxBudgetTokens);
  const lfDests: LangfuseCredentials[] =
    opts?.langfuseDestinations ??
    (opts?.langfuse != null ? [opts.langfuse] : []);
  const ch = opts?.clickhouse?.enabled ? opts.clickhouse : null;

  return {
    getConfig: () => cfg,
    getBudget: () => budget,
    getLangfuseDestinations: () => lfDests,
    getClickHouseWriter: () => ch,
    createChatModel(role: ModelRole | AgentRole): ChatModel {
      const target = resolveModelForRole(role as ModelRole, cfg);
      let model: ChatModel;
      if (target.provider === "anthropic") {
        model = createAnthropicModel(role as ModelRole, target);
      } else {
        model = createOpenAICompatModel(role as ModelRole, target);
      }

      // Wrap to track token budget + Langfuse + optional ClickHouse
      const original = model.complete.bind(model);
      model.complete = async (req) => {
        const started = Date.now();
        const sessionId = opts?.sessionId ?? "";
        const orgId = opts?.orgId ?? opts?.langfuse?.orgId ?? "local";
        const res = await withLangfuseGeneration(
          {
            role: String(role),
            sessionId,
            orgId,
            metadata: {
              provider: target.provider,
              model: target.model,
              orgId,
            },
          },
          target.model,
          target.provider,
          req,
          () => original(req),
          lfDests.length ? lfDests : undefined,
        );
        budget.record({
          promptTokens: res.usage.promptTokens,
          completionTokens: res.usage.completionTokens,
          totalTokens: res.usage.totalTokens,
          model: res.model || target.model,
        });
        if (ch && sessionId) {
          const traceId = `${sessionId}:${role}`;
          ch.record({
            orgId,
            sessionId,
            traceId,
            observationId: randomUUID(),
            kind: "generation",
            name: `steward.${role}`,
            role: String(role),
            model: res.model || target.model,
            runner: "model-router",
            input: {
              system: req.system,
              messages: req.messages,
            },
            output: res.content,
            promptTokens: res.usage.promptTokens,
            completionTokens: res.usage.completionTokens,
            totalTokens: res.usage.totalTokens,
            durationMs: Date.now() - started,
            metadata: {
              provider: target.provider,
              orgId,
            },
          });
        }
        return res;
      };
      return model;
    },
  };
}

export { mergeRoleOverrides };

/** Convenience for one-off completions. */
export function createChatModel(
  role: ModelRole | AgentRole = "default",
  env: NodeJS.ProcessEnv = process.env,
): ChatModel {
  return createModelRouter(env).createChatModel(role);
}
