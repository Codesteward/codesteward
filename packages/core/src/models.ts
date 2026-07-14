import { z } from "zod";
import { AgentRoleSchema, ModelProviderSchema } from "./enums.js";

export const ModelProviderConfigSchema = z.object({
  provider: ModelProviderSchema,
  model: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderConfigSchema>;

export const RoleModelRoutingSchema = z.object({
  role: AgentRoleSchema,
  provider: ModelProviderSchema.optional(),
  model: z.string().optional(),
  /** Prefer "strong" | "cheap" tier when role-specific model not set. */
  tier: z.enum(["strong", "cheap", "default"]).default("default"),
});
export type RoleModelRouting = z.infer<typeof RoleModelRoutingSchema>;

export const ModelRouterConfigSchema = z.object({
  defaultProvider: ModelProviderSchema.default("openai"),
  defaultModel: z.string().default("gpt-4.1"),
  strongModel: z.string().optional(),
  cheapModel: z.string().optional(),
  providers: z.array(ModelProviderConfigSchema).default([]),
  roleRouting: z.array(RoleModelRoutingSchema).default([]),
});
export type ModelRouterConfig = z.infer<typeof ModelRouterConfigSchema>;
