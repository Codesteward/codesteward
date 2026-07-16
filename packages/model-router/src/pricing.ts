/**
 * Approximate list-price USD cost estimates for common models.
 * Used for session UI only — not billing. Prices drift; mark UI as "estimate".
 *
 * Units: USD per 1 million tokens (input / output).
 */

export interface ModelTokenPrice {
  /** USD per 1M prompt/input tokens */
  inputPerMTok: number;
  /** USD per 1M completion/output tokens */
  outputPerMTok: number;
  label?: string;
}

/** Ordered: first match wins (more specific patterns first). */
const PRICE_TABLE: Array<{ match: RegExp; price: ModelTokenPrice }> = [
  // OpenAI
  { match: /gpt-4\.1-nano/i, price: { inputPerMTok: 0.1, outputPerMTok: 0.4, label: "gpt-4.1-nano" } },
  { match: /gpt-4\.1-mini/i, price: { inputPerMTok: 0.4, outputPerMTok: 1.6, label: "gpt-4.1-mini" } },
  { match: /gpt-4\.1/i, price: { inputPerMTok: 2.0, outputPerMTok: 8.0, label: "gpt-4.1" } },
  { match: /gpt-4o-mini/i, price: { inputPerMTok: 0.15, outputPerMTok: 0.6, label: "gpt-4o-mini" } },
  { match: /gpt-4o/i, price: { inputPerMTok: 2.5, outputPerMTok: 10.0, label: "gpt-4o" } },
  { match: /o4-mini/i, price: { inputPerMTok: 1.1, outputPerMTok: 4.4, label: "o4-mini" } },
  { match: /o3-mini/i, price: { inputPerMTok: 1.1, outputPerMTok: 4.4, label: "o3-mini" } },
  { match: /\bo3\b/i, price: { inputPerMTok: 10, outputPerMTok: 40, label: "o3" } },
  { match: /gpt-5/i, price: { inputPerMTok: 1.25, outputPerMTok: 10, label: "gpt-5-family" } },
  // Anthropic
  { match: /claude-opus-4|claude-4-opus|opus-4/i, price: { inputPerMTok: 15, outputPerMTok: 75, label: "claude-opus-4" } },
  { match: /claude-sonnet-4|claude-4-sonnet|sonnet-4/i, price: { inputPerMTok: 3, outputPerMTok: 15, label: "claude-sonnet-4" } },
  { match: /claude-3-5-sonnet|claude-3\.5-sonnet/i, price: { inputPerMTok: 3, outputPerMTok: 15, label: "claude-3.5-sonnet" } },
  { match: /claude-3-5-haiku|claude-3\.5-haiku|haiku/i, price: { inputPerMTok: 0.8, outputPerMTok: 4, label: "claude-haiku" } },
  { match: /claude-3-opus/i, price: { inputPerMTok: 15, outputPerMTok: 75, label: "claude-3-opus" } },
  // SpaceXAI (Grok)
  { match: /grok-3-mini|grok-mini/i, price: { inputPerMTok: 0.3, outputPerMTok: 0.5, label: "grok-3-mini" } },
  { match: /grok-3|grok-2/i, price: { inputPerMTok: 3, outputPerMTok: 15, label: "grok-3" } },
  // OpenRouter-style prefixes: strip provider/ and retry via normalize
];

/** Fallback when model is unknown — conservative mid-tier estimate. */
const DEFAULT_PRICE: ModelTokenPrice = {
  inputPerMTok: 2.0,
  outputPerMTok: 8.0,
  label: "default-estimate",
};

export function normalizeModelId(model: string | undefined | null): string {
  if (!model) return "";
  // openrouter: "openai/gpt-4.1-mini" → "gpt-4.1-mini"
  const s = model.trim();
  const slash = s.lastIndexOf("/");
  if (slash >= 0 && slash < s.length - 1) return s.slice(slash + 1);
  // "openai:gpt-4.1" → "gpt-4.1"
  const colon = s.indexOf(":");
  if (colon >= 0 && colon < s.length - 1 && !s.slice(0, colon).includes(".")) {
    return s.slice(colon + 1);
  }
  return s;
}

export function lookupModelPrice(model: string | undefined | null): ModelTokenPrice {
  const id = normalizeModelId(model);
  if (!id) return DEFAULT_PRICE;
  for (const row of PRICE_TABLE) {
    if (row.match.test(id) || row.match.test(model ?? "")) return row.price;
  }
  return DEFAULT_PRICE;
}

/**
 * Estimate USD cost for a completion.
 * If only totalTokens is known, split 75/25 prompt/completion (typical review mix).
 */
export function estimateCostUsd(input: {
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}): { costUsd: number; price: ModelTokenPrice; estimated: boolean } {
  const price = lookupModelPrice(input.model);
  let prompt = Math.max(0, input.promptTokens ?? 0);
  let completion = Math.max(0, input.completionTokens ?? 0);
  let estimated = false;
  if (prompt === 0 && completion === 0 && (input.totalTokens ?? 0) > 0) {
    const total = input.totalTokens ?? 0;
    prompt = Math.round(total * 0.75);
    completion = total - prompt;
    estimated = true;
  }
  const costUsd =
    (prompt / 1_000_000) * price.inputPerMTok +
    (completion / 1_000_000) * price.outputPerMTok;
  return { costUsd, price, estimated };
}
