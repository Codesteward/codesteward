import type { ModelProvider } from "@codesteward/core";
import type {
  ChatModel,
  CompleteRequest,
  CompleteResponse,
  ResolvedModelTarget,
  ModelRole,
} from "../types.js";

/** OpenAI Chat Completions API (also xAI, LiteLLM, OpenRouter, openai-compatible). */
export function createOpenAICompatModel(
  role: ModelRole,
  target: ResolvedModelTarget,
): ChatModel {
  const provider = target.provider;
  return {
    role: role as ChatModel["role"],
    provider,
    model: target.model,
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const gatewayProviders = new Set([
        "openai-compatible",
        "litellm",
        "openrouter",
      ]);
      // Only mock when no key and not a remote gateway provider
      if (!target.apiKey && !gatewayProviders.has(provider)) {
        return mockComplete(role, target, req, provider);
      }
      if (!target.apiKey && gatewayProviders.has(provider)) {
        const hint =
          provider === "openrouter"
            ? "OPENROUTER_API_KEY"
            : provider === "litellm"
              ? "LITELLM_API_KEY / OPENAI_API_KEY"
              : "OPENAI_COMPAT_API_KEY / OPENAI_API_KEY";
        throw new Error(
          `LLM ${provider}: no API key configured for this org. Set it under Models → Provider API keys (or host ${hint}).`,
        );
      }

      const messages: Array<Record<string, unknown>> = [];
      if (req.system) {
        messages.push({ role: "system", content: req.system });
      }
      for (const m of req.messages) {
        messages.push({
          role: m.role,
          content: m.content,
          ...(m.name ? { name: m.name } : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        });
      }

      const modelName = String(target.model ?? "");
      // gpt-5 / codex family: many gateways only accept temperature=1 (or omit)
      const isGpt5Family = /\bgpt-5\b/i.test(modelName) || /codex/i.test(modelName);
      const temperature = isGpt5Family
        ? 1
        : (req.temperature ?? target.temperature ?? 0.2);
      const body: Record<string, unknown> = {
        model: target.model,
        messages,
        temperature,
        max_tokens: req.maxTokens ?? target.maxTokens ?? 4096,
      };

      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }
      if (req.jsonMode) {
        // Azure Responses API / LiteLLM→Azure: text.format=json_object requires the
        // word "json" in *input* (user) messages — system alone is not enough.
        ensureJsonWordInUserMessages(messages);
        body.response_format = { type: "json_object" };
      }

      const base = (target.baseUrl ?? "").replace(/\/+$/, "").replace(/\/v1\/v1$/i, "/v1");
      const url = `${base}/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
      };
      // OpenRouter app attribution (optional but recommended)
      if (provider === "openrouter") {
        const site =
          process.env.OPENROUTER_HTTP_REFERER ||
          process.env.STEW_PUBLIC_URL ||
          process.env.STEW_API_PUBLIC_URL ||
          "https://codesteward.ai";
        const title =
          process.env.OPENROUTER_APP_TITLE ||
          process.env.STEW_OPENROUTER_TITLE ||
          "Codesteward Review";
        headers["HTTP-Referer"] = site;
        headers["X-Title"] = title;
        headers["X-OpenRouter-Title"] = title;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `LLM ${provider} error ${res.status} ${url}: ${text.slice(0, 500)}` +
            (res.status === 401
              ? provider === "openrouter"
                ? " — check org OpenRouter API key under Models (or OPENROUTER_API_KEY)."
                : " — check org LiteLLM/OpenAI API key under Models (not host env alone)."
              : ""),
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        model?: string;
      };

      const choice = data.choices?.[0];
      const msg = choice?.message;
      const usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      };

      return {
        content: msg?.content ?? "",
        toolCalls: msg?.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
        finishReason: choice?.finish_reason,
        usage,
        model: data.model ?? target.model,
        provider,
        raw: data,
      };
    },
  };
}

/**
 * Azure OpenAI Responses API (and LiteLLM→Azure for gpt-5 / codex) reject
 * response_format / text.format = json_object unless an *input* message
 * contains the word "json". System prompts alone do not count — only user
 * (and typically developer) roles are treated as input.
 *
 * @see Azure error: "Response input messages must contain the word 'json'…"
 */
function messageTextHasJson(content: unknown): boolean {
  if (typeof content === "string") return /json/i.test(content);
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === "string") return /json/i.test(part);
      if (part && typeof part === "object" && "text" in part) {
        return /json/i.test(String((part as { text: unknown }).text));
      }
      return false;
    });
  }
  return false;
}

function ensureJsonWordInUserMessages(
  messages: Array<Record<string, unknown>>,
): void {
  const inputRoles = new Set(["user", "developer"]);
  if (
    messages.some(
      (m) => inputRoles.has(String(m.role)) && messageTextHasJson(m.content),
    )
  ) {
    return;
  }

  const suffix =
    "\n\nRespond with a single valid json object only (no markdown fences).";

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      m.content = `${m.content}${suffix}`;
      return;
    }
    if (Array.isArray(m.content)) {
      (m.content as unknown[]).push({ type: "text", text: suffix });
      return;
    }
  }

  messages.push({
    role: "user",
    content: "Respond with a single valid json object only.",
  });
}

function mockComplete(
  role: ModelRole,
  target: ResolvedModelTarget,
  req: CompleteRequest,
  provider: ModelProvider,
): CompleteResponse {
  const userLast = [...req.messages].reverse().find((m) => m.role === "user");
  const content = JSON.stringify(
    {
      findings: [],
      note: `mock-llm:${provider}/${target.model} role=${String(role)} (no API key)`,
      echo: (userLast?.content ?? "").slice(0, 200),
    },
    null,
    2,
  );
  return {
    content,
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: target.model,
    provider,
  };
}
