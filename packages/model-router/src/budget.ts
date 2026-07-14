import { estimateCostUsd } from "./pricing.js";
import type { TokenBudget, TokenBudgetSnapshot } from "./types.js";

export function createTokenBudget(maxTokens = 500_000): TokenBudget {
  let used = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let calls = 0;
  /** Per-model rollup for diagnostics */
  const byModel = new Map<
    string,
    { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; calls: number }
  >();

  return {
    maxTokens,
    get usedTokens() {
      return used;
    },
    get promptTokens() {
      return promptTokens;
    },
    get completionTokens() {
      return completionTokens;
    },
    get costUsd() {
      return costUsd;
    },
    get calls() {
      return calls;
    },
    remaining() {
      return Math.max(0, maxTokens - used);
    },
    record(usage) {
      const p = Math.max(0, usage.promptTokens ?? 0);
      const c = Math.max(0, usage.completionTokens ?? 0);
      let total = Math.max(0, usage.totalTokens ?? 0);
      if (total === 0) total = p + c;
      // If provider only gave total, still count it
      if (p === 0 && c === 0 && total > 0) {
        used += total;
        // attribute as prompt-heavy for budget only; snapshot still has zeros split
      } else {
        used += p + c;
      }
      promptTokens += p;
      completionTokens += c;
      calls += 1;

      const est = estimateCostUsd({
        model: usage.model,
        promptTokens: p,
        completionTokens: c,
        totalTokens: total,
      });
      const callCost =
        typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)
          ? usage.costUsd
          : est.costUsd;
      costUsd += callCost;

      const modelKey = usage.model?.trim() || "unknown";
      const prev = byModel.get(modelKey) ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        calls: 0,
      };
      prev.promptTokens += p;
      prev.completionTokens += c;
      prev.totalTokens += total || p + c;
      prev.costUsd += callCost;
      prev.calls += 1;
      byModel.set(modelKey, prev);
    },
    snapshot(): TokenBudgetSnapshot {
      // When only totals were recorded (deep-agent path with total only),
      // surface used as totalTokens and leave split as tracked.
      const totalTokens =
        promptTokens + completionTokens > 0
          ? promptTokens + completionTokens
          : used;
      return {
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd: Number(costUsd.toFixed(6)),
        costEstimated: true,
        calls,
        byModel: Object.fromEntries(byModel.entries()),
      };
    },
    reset() {
      used = 0;
      promptTokens = 0;
      completionTokens = 0;
      costUsd = 0;
      calls = 0;
      byModel.clear();
    },
  };
}
