import type { AgentRole, ModelProvider } from "@codesteward/core";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompleteRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Optional JSON mode hint for providers that support it. */
  jsonMode?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompleteResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  provider: ModelProvider;
  raw?: unknown;
}

export interface ChatModel {
  readonly role: AgentRole | "default";
  readonly provider: ModelProvider;
  readonly model: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

export interface TokenUsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  /** Model id used for this call (for cost estimate). */
  model?: string;
  /** Optional provider-reported cost override. */
  costUsd?: number;
}

export interface TokenBudgetSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated USD from list prices (not invoice). */
  costUsd: number;
  costEstimated: boolean;
  calls: number;
  byModel?: Record<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      costUsd: number;
      calls: number;
    }
  >;
}

export interface TokenBudget {
  maxTokens: number;
  usedTokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  calls: number;
  remaining(): number;
  record(usage: TokenUsageRecord): void;
  /** Full session rollup for persistence / UI. */
  snapshot(): TokenBudgetSnapshot;
  reset(): void;
}

export interface ResolvedModelTarget {
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  temperature?: number;
  maxTokens?: number;
}

export type ModelRole =
  | AgentRole
  | "judge"
  | "security"
  | "summary"
  | "specialist"
  | "default";
