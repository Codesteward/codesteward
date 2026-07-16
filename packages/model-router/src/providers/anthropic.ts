import type {
  ChatModel,
  CompleteRequest,
  CompleteResponse,
  ResolvedModelTarget,
  ModelRole,
} from "../types.js";
import { fetchWithLlmRetry } from "../llm-retry.js";

/** Anthropic Messages API. */
export function createAnthropicModel(
  role: ModelRole,
  target: ResolvedModelTarget,
): ChatModel {
  return {
    role: role as ChatModel["role"],
    provider: "anthropic",
    model: target.model,
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      if (!target.apiKey) {
        return {
          content: JSON.stringify({
            findings: [],
            note: `mock-llm:anthropic/${target.model} role=${String(role)} (no API key)`,
          }),
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: target.model,
          provider: "anthropic",
        };
      }

      const messages = req.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const body: Record<string, unknown> = {
        model: target.model,
        max_tokens: req.maxTokens ?? target.maxTokens ?? 4096,
        temperature: req.temperature ?? target.temperature ?? 0.2,
        system: req.system ?? "",
        messages: messages.length
          ? messages
          : [{ role: "user", content: "Respond." }],
      };

      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }

      const res = await fetchWithLlmRetry(
        `${target.baseUrl}/v1/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": target.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        },
        { label: `anthropic/${target.model}` },
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Anthropic error ${res.status}: ${text.slice(0, 500)}` +
            (res.status === 429
              ? " — rate limited after retries; reduce concurrent specialists or raise quota."
              : ""),
        );
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      };

      const textParts = (data.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      const toolCalls = (data.content ?? [])
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id ?? "tool",
          name: c.name ?? "unknown",
          arguments: JSON.stringify(c.input ?? {}),
        }));

      const promptTokens = data.usage?.input_tokens ?? 0;
      const completionTokens = data.usage?.output_tokens ?? 0;

      return {
        content: textParts,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: data.stop_reason,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model: data.model ?? target.model,
        provider: "anthropic",
        raw: data,
      };
    },
  };
}
