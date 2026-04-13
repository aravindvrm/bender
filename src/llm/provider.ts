import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { BenderConfig, ModelTier } from "../state/config.js";

type ProviderFactory = (config: BenderConfig) => LanguageModel;

const providerFactories: Record<string, (apiKey?: string) => (modelId: string) => LanguageModel> = {
  anthropic: (apiKey) => {
    const provider = createAnthropic({ apiKey });
    return (modelId) => provider(modelId) as LanguageModel;
  },
  openai: (apiKey) => {
    const provider = createOpenAI({ apiKey });
    return (modelId) => provider(modelId) as LanguageModel;
  },
  google: (apiKey) => {
    const provider = createGoogleGenerativeAI({ apiKey });
    return (modelId) => provider(modelId) as LanguageModel;
  },
  ollama: () => {
    const provider = createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
    return (modelId) => provider(modelId) as LanguageModel;
  },
  groq: (apiKey) => {
    const provider = createOpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey });
    return (modelId) => provider(modelId) as LanguageModel;
  },
};

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
};

function providerNeedsApiKey(provider: string): boolean {
  return provider !== "ollama";
}

function hasProviderEnvKey(provider: string): boolean {
  const keys = PROVIDER_ENV_KEYS[provider] ?? [];
  return keys.some((key) => !!process.env[key]);
}

function assertProviderApiKeyAvailable(provider: string, apiKey?: string): void {
  if (!providerNeedsApiKey(provider)) return;
  if (apiKey || hasProviderEnvKey(provider)) return;

  const envHints = PROVIDER_ENV_KEYS[provider];
  const hint = envHints && envHints.length > 0
    ? ` or set ${envHints.join(" / ")}`
    : "";
  throw new Error(`Missing API key for provider '${provider}'. Add it in Settings${hint}.`);
}

/**
 * Resolve a model tier config entry into a LanguageModel instance.
 * Supports both simple string format ("sonnet-4.6") and object format ({ provider, model }).
 */
function resolveModelConfig(
  tierConfig: string | { provider: string; model: string; apiKey?: string },
  defaultProvider: string,
  defaultApiKey?: string,
): LanguageModel {
  if (typeof tierConfig === "string") {
    const factory = providerFactories[defaultProvider];
    if (!factory) {
      throw new Error(`Unknown LLM provider: ${defaultProvider}. Supported: ${Object.keys(providerFactories).join(", ")}`);
    }
    assertProviderApiKeyAvailable(defaultProvider, defaultApiKey);
    return factory(defaultApiKey)(tierConfig);
  }

  const factory = providerFactories[tierConfig.provider];
  if (!factory) {
    throw new Error(`Unknown LLM provider: ${tierConfig.provider}. Supported: ${Object.keys(providerFactories).join(", ")}`);
  }
  assertProviderApiKeyAvailable(tierConfig.provider, tierConfig.apiKey);
  // Tier-level apiKey wins over anything else
  return factory(tierConfig.apiKey)(tierConfig.model);
}

export interface ModelSet {
  fast: LanguageModel;
  default: LanguageModel;
  strong: LanguageModel;
}

export function getModelForTier(models: ModelSet, tier: ModelTier): LanguageModel {
  return models[tier];
}

/**
 * Create the full set of tiered models from a BenderConfig.
 */
export function createModelSet(config: BenderConfig): ModelSet {
  const provider = config.llm.provider;
  // Per-provider key (from config.providers) takes precedence over the global llm.apiKey
  const apiKey = config.providers?.[provider]?.apiKey ?? config.llm.apiKey;
  const models = config.llm.models;

  return {
    fast: resolveModelConfig(models.fast, provider, apiKey),
    default: resolveModelConfig(models.default, provider, apiKey),
    strong: resolveModelConfig(models.strong, provider, apiKey),
  };
}

/**
 * Get the appropriate model for a given role.
 */
const roleTierMap: Record<string, ModelTier> = {
  clarifier: "fast",
  architect: "strong",
  planner: "default",
  implementer: "strong",
  reviewer: "default",
};

export function getModelForRole(models: ModelSet, role: string): LanguageModel {
  const tier = roleTierMap[role] ?? "default";
  return getModelForTier(models, tier);
}
