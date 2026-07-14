import type { TokenBudget } from "./types.js";

export function createTokenBudget(maxTokens = 500_000): TokenBudget {
  let used = 0;
  return {
    maxTokens,
    get usedTokens() {
      return used;
    },
    remaining() {
      return Math.max(0, maxTokens - used);
    },
    record(usage) {
      used += usage.promptTokens + usage.completionTokens;
    },
    reset() {
      used = 0;
    },
  };
}
