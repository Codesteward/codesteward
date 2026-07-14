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
import { createAnthropicModel } from "./providers/anthropic.js";
import { createOpenAICompatModel } from "./providers/openai-compat.js";
import type { ChatModel, ModelRole, TokenBudget } from "./types.js";

export interface ModelRouter {
  createChatModel(role: ModelRole | AgentRole): ChatModel;
  getBudget(): TokenBudget;
  getConfig(): EnvModelConfig;
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
  },
): ModelRouter {
  const cfg = opts?.config ?? loadEnvModelConfig(env);
  const budget = createTokenBudget(cfg.maxBudgetTokens);
  const lfDests =
    opts?.langfuseDestinations ??
    (opts?.langfuse != null ? [opts.langfuse] : undefined);

  return {
    getConfig: () => cfg,
    getBudget: () => budget,
    createChatModel(role: ModelRole | AgentRole): ChatModel {
      const target = resolveModelForRole(role as ModelRole, cfg);
      let model: ChatModel;
      if (target.provider === "anthropic") {
        model = createAnthropicModel(role as ModelRole, target);
      } else {
        model = createOpenAICompatModel(role as ModelRole, target);
      }

      // Wrap to track token budget + Langfuse (dual-write when multiple destinations)
      const original = model.complete.bind(model);
      model.complete = async (req) => {
        const res = await withLangfuseGeneration(
          {
            role: String(role),
            sessionId: opts?.sessionId,
            orgId: opts?.orgId ?? opts?.langfuse?.orgId,
            metadata: {
              provider: target.provider,
              model: target.model,
              orgId: opts?.orgId,
            },
          },
          target.model,
          target.provider,
          req,
          () => original(req),
          lfDests,
        );
        budget.record({
          promptTokens: res.usage.promptTokens,
          completionTokens: res.usage.completionTokens,
          totalTokens: res.usage.totalTokens,
          model: res.model || target.model,
        });
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
