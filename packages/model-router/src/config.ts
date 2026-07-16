import type { ModelProvider } from "@codesteward/core";
import type { ModelRole, ResolvedModelTarget } from "./types.js";

/** Per-role override (judge, security, discourse, …) */
export interface RoleModelOverride {
  provider?: ModelProvider | string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyRef?: string;
}

export interface EnvModelConfig {
  provider: ModelProvider;
  model: string;
  strongModel: string;
  cheapModel: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  xaiApiKey?: string;
  openrouterApiKey?: string;
  openaiBaseUrl: string;
  litellmBaseUrl?: string;
  openrouterBaseUrl?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatApiKey?: string;
  maxBudgetTokens: number;
  /** Org- or env-level per-stage matrix */
  roleOverrides: Record<string, RoleModelOverride>;
}

function loadRoleOverrides(env: NodeJS.ProcessEnv): Record<string, RoleModelOverride> {
  const raw = env.STEW_MODEL_ROLE_MATRIX ?? env.STEW_MODEL_ROLES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, RoleModelOverride>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn("[model-router] STEW_MODEL_ROLE_MATRIX is not valid JSON");
    return {};
  }
}

/** Org-scoped provider credentials (decrypted) merged over host env. */
export type OrgProviderSecrets = {
  openai?: { apiKey?: string; baseUrl?: string };
  anthropic?: { apiKey?: string; baseUrl?: string };
  /** SpaceXAI (Grok); key id `xai` for compatibility */
  xai?: { apiKey?: string; baseUrl?: string };
  spacexai?: { apiKey?: string; baseUrl?: string };
  litellm?: { apiKey?: string; baseUrl?: string };
  "openai-compatible"?: { apiKey?: string; baseUrl?: string };
  openrouter?: { apiKey?: string; baseUrl?: string };
};

/** Default OpenRouter OpenAI-compatible base (chat/completions). */
export const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";

/** Merge org matrix (from API) into env config for request-scoped routing. */
export function mergeRoleOverrides(
  cfg: EnvModelConfig,
  matrix?: {
    defaultProvider?: string;
    defaultModel?: string;
    strongModel?: string;
    cheapModel?: string;
    roles?: Record<string, RoleModelOverride>;
    /** Decrypted org provider keys/base URLs (preferred over process.env in multi-org) */
    providers?: OrgProviderSecrets | null;
  } | null,
): EnvModelConfig {
  if (!matrix) return cfg;
  const p = matrix.providers ?? {};
  return {
    ...cfg,
    provider: (matrix.defaultProvider as ModelProvider) ?? cfg.provider,
    model: matrix.defaultModel ?? cfg.model,
    strongModel: matrix.strongModel ?? cfg.strongModel,
    cheapModel: matrix.cheapModel ?? cfg.cheapModel,
    openaiApiKey: p.openai?.apiKey || cfg.openaiApiKey,
    anthropicApiKey: p.anthropic?.apiKey || cfg.anthropicApiKey,
    xaiApiKey: p.xai?.apiKey || p.spacexai?.apiKey || cfg.xaiApiKey,
    openrouterApiKey: p.openrouter?.apiKey || cfg.openrouterApiKey,
    openaiBaseUrl: p.openai?.baseUrl || cfg.openaiBaseUrl,
    litellmBaseUrl: p.litellm?.baseUrl || cfg.litellmBaseUrl,
    openrouterBaseUrl: p.openrouter?.baseUrl || cfg.openrouterBaseUrl,
    openaiCompatBaseUrl:
      p["openai-compatible"]?.baseUrl || p.litellm?.baseUrl || cfg.openaiCompatBaseUrl,
    openaiCompatApiKey:
      p["openai-compatible"]?.apiKey || p.litellm?.apiKey || cfg.openaiCompatApiKey,
    roleOverrides: { ...cfg.roleOverrides, ...(matrix.roles ?? {}) },
  };
}

export function loadEnvModelConfig(env: NodeJS.ProcessEnv = process.env): EnvModelConfig {
  const provider = (env.MODEL_PROVIDER ?? "openai") as ModelProvider;
  const model =
    env.MODEL_NAME ??
    env.STEW_MODEL_SPECIALIST ??
    (provider === "openrouter" ? "openai/gpt-4.1" : "gpt-4.1");
  return {
    provider,
    model,
    strongModel:
      env.STEW_MODEL_JUDGE ??
      env.STEW_MODEL_STRONG ??
      (provider === "anthropic"
        ? "claude-sonnet-4-20250514"
        : provider === "openrouter"
          ? "anthropic/claude-sonnet-4"
          : model),
    cheapModel:
      env.STEW_MODEL_CHEAP ??
      env.STEW_MODEL_SUMMARY ??
      (provider === "openai" ||
      provider === "openai-compatible" ||
      provider === "litellm" ||
      provider === "openrouter"
        ? provider === "openrouter"
          ? "openai/gpt-4.1-mini"
          : "gpt-4.1-mini"
        : model),
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    // SpaceXAI (formerly xAI); accept both env names
    xaiApiKey: env.SPACEXAI_API_KEY || env.XAI_API_KEY,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    litellmBaseUrl: env.LITELLM_BASE_URL,
    openrouterBaseUrl: env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE,
    openaiCompatBaseUrl: env.OPENAI_COMPAT_BASE_URL ?? env.OPENAI_BASE_URL,
    openaiCompatApiKey: env.OPENAI_COMPAT_API_KEY ?? env.OPENAI_API_KEY,
    maxBudgetTokens: Number(env.STEW_TOKEN_BUDGET ?? 500_000),
    roleOverrides: loadRoleOverrides(env),
  };
}

const STRONG_ROLES = new Set<ModelRole>([
  "judge",
  "security",
  "verifier",
  "coordinator",
  "prove",
  "discourse",
]);

const CHEAP_ROLES = new Set<ModelRole>([
  "summary" as ModelRole,
  "generalist",
  "rules",
]);

/**
 * Host-only escape hatch for `STEW_MODEL_ROLE_MATRIX` (process env JSON).
 * Org product matrices must not set apiKeyRef — use org `providers` encrypted keys.
 */
function resolveApiKeyRef(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("env:")) return env[ref.slice(4)];
  // Never accept raw API keys in matrix — secrets stay in env/vault or org providers
  if (/^(sk-|ghp_|gho_|xai-|key-)/i.test(ref) || ref.length > 40) {
    throw new Error("apiKeyRef must be env:VAR_NAME — raw secrets are not accepted in model matrix");
  }
  return undefined;
}

export function resolveModelForRole(
  role: ModelRole,
  cfg: EnvModelConfig = loadEnvModelConfig(),
): ResolvedModelTarget {
  const override = cfg.roleOverrides[role] ?? cfg.roleOverrides[String(role)];
  let model = cfg.model;
  if (STRONG_ROLES.has(role) || role === "judge" || role === "security") {
    model = cfg.strongModel;
  } else if (CHEAP_ROLES.has(role) || role === "summary") {
    model = cfg.cheapModel;
  }
  if (override?.model) model = override.model;

  const providerRaw = String(override?.provider ?? cfg.provider);
  // SpaceXAI rebrand: accept `spacexai` as alias of stored id `xai`
  const provider = (
    providerRaw === "spacexai" ? "xai" : providerRaw
  ) as ModelProvider;
  const overrideKey =
    resolveApiKeyRef(override?.apiKeyRef) ?? override?.apiKey;

  switch (provider) {
    case "anthropic":
      return {
        provider: "anthropic",
        model: model.includes("/") ? model.split("/").pop()! : model,
        baseUrl: override?.baseUrl ?? "https://api.anthropic.com",
        apiKey: overrideKey ?? cfg.anthropicApiKey,
      };
    case "xai": {
      // SpaceXAI (Grok) — OpenAI-compatible chat API (api.x.ai)
      let grokModel = model;
      if (!model.startsWith("grok")) {
        if (model.includes("xai/")) grokModel = model.slice(4);
        else if (model.includes("spacexai/")) grokModel = model.slice("spacexai/".length);
        else grokModel = "grok-3";
      }
      return {
        provider: "xai",
        model: grokModel,
        baseUrl: override?.baseUrl ?? "https://api.x.ai/v1",
        apiKey: overrideKey ?? cfg.xaiApiKey,
      };
    }
    case "litellm":
      return {
        provider: "litellm",
        model,
        baseUrl: normalizeOpenAiBase(
          override?.baseUrl ?? cfg.litellmBaseUrl ?? "http://localhost:4000",
        ),
        // Prefer org-scoped litellm key (merged into openaiCompatApiKey), then OPENAI_*, then a non-empty placeholder
        apiKey:
          overrideKey ||
          cfg.openaiCompatApiKey ||
          cfg.openaiApiKey ||
          process.env.LITELLM_API_KEY ||
          process.env.OPENAI_API_KEY ||
          "sk-litellm",
      };
    case "openai-compatible":
      return {
        provider: "openai-compatible",
        model,
        baseUrl: normalizeOpenAiBase(
          override?.baseUrl ??
            cfg.openaiCompatBaseUrl ??
            "http://localhost:11434/v1",
        ),
        apiKey:
          overrideKey ||
          cfg.openaiCompatApiKey ||
          cfg.openaiApiKey ||
          undefined,
      };
    case "openrouter":
      return {
        provider: "openrouter",
        // OpenRouter expects vendor/model ids (e.g. anthropic/claude-sonnet-4, openai/gpt-4.1)
        model: model.includes("/")
          ? model
          : model.startsWith("claude")
            ? `anthropic/${model}`
            : model.startsWith("grok")
              ? `x-ai/${model}`
              : `openai/${model}`,
        baseUrl: normalizeOpenAiBase(
          override?.baseUrl ?? cfg.openrouterBaseUrl ?? OPENROUTER_DEFAULT_BASE,
        ),
        apiKey:
          overrideKey ||
          cfg.openrouterApiKey ||
          process.env.OPENROUTER_API_KEY ||
          undefined,
      };
    case "openai":
    default:
      return {
        provider: "openai",
        model,
        baseUrl: normalizeOpenAiBase(override?.baseUrl ?? cfg.openaiBaseUrl),
        apiKey: overrideKey || cfg.openaiApiKey,
      };
  }
}

/** Collapse accidental /v1/v1 and trailing slashes for OpenAI-compatible gateways. */
export function normalizeOpenAiBase(url: string): string {
  let u = (url || "").trim().replace(/\/+$/, "");
  // Common UI mistake: paste ".../v1" then stack also assumes /v1
  while (u.endsWith("/v1/v1")) u = u.slice(0, -3);
  // LiteLLM/OpenAI chat path is {base}/chat/completions — base must end with /v1 for most gateways
  if (u && !/\/v1$/i.test(u) && !/ollama/i.test(u) && !/:\d+$/.test(u.split("/").pop() ?? "")) {
    // leave as-is if user gave a full custom path without /v1 (e.g. pure host:port)
  }
  return u;
}
