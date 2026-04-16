import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { BenderConfig, ModelTier, ProviderConfig } from "../state/config.js";

const LOCAL_PROVIDER_TIMEOUT_MS = 120_000;

const PROVIDER_DEFAULT_CAPABILITIES: Record<string, { supportsTools: boolean; supportsJson: boolean; supportsStreaming: boolean }> = {
  anthropic: { supportsTools: true, supportsJson: true, supportsStreaming: true },
  openai: { supportsTools: true, supportsJson: true, supportsStreaming: true },
  google: { supportsTools: true, supportsJson: true, supportsStreaming: true },
  groq: { supportsTools: true, supportsJson: true, supportsStreaming: true },
  ollama: { supportsTools: false, supportsJson: false, supportsStreaming: true },
  // Many OpenAI-compatible local servers do not implement stable SSE semantics.
  // Prefer non-streaming by default for reliability.
  "openai-compatible": { supportsTools: false, supportsJson: false, supportsStreaming: false },
};

function normalizeOpenAiCompatibleBaseUrl(value?: string): string {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://localhost:1234/v1";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function openAiCompatibleBaseCandidates(value?: string): string[] {
  const normalized = normalizeOpenAiCompatibleBaseUrl(value);
  if (!normalized) return [];
  if (normalized.endsWith("/v1")) {
    const withoutV1 = normalized.slice(0, -"/v1".length);
    return [normalized, withoutV1].filter(Boolean);
  }
  return [`${normalized}/v1`, normalized];
}

function deriveBaseUrlFromEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  if (trimmed.endsWith("/responses")) {
    return trimmed.slice(0, -"/responses".length);
  }
  return undefined;
}

function resolveOpenAiCompatibleApiStyle(
  cfg: ProviderConfig,
  modelId: string,
): "chat" | "responses" {
  const explicit = cfg.modelCapabilities?.[modelId]?.apiStyle;
  if (explicit === "chat" || explicit === "responses") {
    return explicit;
  }
  const endpoint = cfg.modelCapabilities?.[modelId]?.endpoint?.toLowerCase() ?? "";
  if (endpoint.endsWith("/chat/completions") || endpoint.includes("/chat/completions")) return "chat";
  if (endpoint.endsWith("/responses") || endpoint.includes("/responses")) return "responses";
  // Default unknown local endpoints to chat-completions for broad OpenAI-compatible support.
  return "chat";
}

function resolveOpenAiCompatibleBaseUrlForModel(cfg: ProviderConfig, modelId: string): string {
  const hinted = deriveBaseUrlFromEndpoint(cfg.modelCapabilities?.[modelId]?.endpoint);
  return normalizeOpenAiCompatibleBaseUrl(hinted ?? cfg.baseUrl);
}

function resolveOpenAiCompatibleBaseUrlCandidatesForModel(cfg: ProviderConfig, modelId: string): string[] {
  const hinted = deriveBaseUrlFromEndpoint(cfg.modelCapabilities?.[modelId]?.endpoint);
  if (hinted) return [normalizeOpenAiCompatibleBaseUrl(hinted)];
  return openAiCompatibleBaseCandidates(cfg.baseUrl);
}

function stringifyProviderError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    const causeText = cause ? ` ${stringifyProviderError(cause)}` : "";
    return `${error.message}${causeText}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isEndpointMismatchError(error: unknown): boolean {
  const text = stringifyProviderError(error).toLowerCase();
  const hasEndpointHint = (
    text.includes("/chat/completions")
    || text.includes("chat/completions")
    || text.includes("/responses")
    || text.includes(" post /responses")
  );
  if (!hasEndpointHint && !text.includes("unexpected endpoint or method")) return false;
  return (
    text.includes("unexpected endpoint or method")
    || text.includes("invalid json response")
    || text.includes("type validation failed")
    || text.includes("invalid_type")
    || text.includes("invalid input")
  );
}

function isTerminalOpenAiCompatibleError(error: unknown): boolean {
  const text = stringifyProviderError(error).toLowerCase();
  return (
    text.includes("unauthorized")
    || text.includes("forbidden")
    || text.includes("invalid api key")
    || text.includes("authentication")
    || text.includes("insufficient_quota")
    || text.includes("rate limit")
    || text.includes("rate_limit")
    || text.includes("429")
    || text.includes("timed out")
    || text.includes("timeout")
    || text.includes("operation was aborted")
  );
}

function shouldRetryOpenAiCompatibleFallback(error: unknown): boolean {
  if (isTerminalOpenAiCompatibleError(error)) return false;
  if (isEndpointMismatchError(error)) return true;
  const text = stringifyProviderError(error).toLowerCase();
  return (
    text.includes("bad request")
    || text.includes("not found")
    || text.includes("404")
    || text.includes("400")
    || text.includes("invalid json response")
    || text.includes("type validation failed")
    || text.includes("invalid input")
    || text.includes("fetch failed")
    || text.includes("econnrefused")
    || text.includes("invalid url")
  );
}

type FallbackCapableModel = LanguageModel & {
  doGenerate?: (options: unknown) => Promise<unknown>;
  doStream?: (options: unknown) => Promise<unknown>;
};

function withEndpointFallback(
  primaryFactory: () => LanguageModel,
  fallbackFactories: Array<() => LanguageModel>,
): LanguageModel {
  const modelCache = new Map<number, FallbackCapableModel>();
  const factories = [primaryFactory, ...fallbackFactories];

  const ensureModel = (index: number): FallbackCapableModel => {
    const existing = modelCache.get(index);
    if (existing) return existing;
    const created = factories[index]!() as FallbackCapableModel;
    modelCache.set(index, created);
    return created;
  };
  const primaryModel = ensureModel(0);
  const wrapped = Object.create(primaryModel) as FallbackCapableModel;

  const withGenerateFallback = async (options: unknown, startIndex: number): Promise<unknown> => {
    for (let i = startIndex; i < factories.length; i += 1) {
      const candidate = ensureModel(i);
      if (typeof candidate.doGenerate !== "function") continue;
      try {
        return await candidate.doGenerate(options);
      } catch (error) {
        if (!shouldRetryOpenAiCompatibleFallback(error) || i === factories.length - 1) throw error;
      }
    }
    throw new Error("No OpenAI-compatible generate model available.");
  };

  const withStreamFallback = async (options: unknown, startIndex: number): Promise<unknown> => {
    for (let i = startIndex; i < factories.length; i += 1) {
      const candidate = ensureModel(i);
      if (typeof candidate.doStream !== "function") continue;
      try {
        return await candidate.doStream(options);
      } catch (error) {
        if (!shouldRetryOpenAiCompatibleFallback(error) || i === factories.length - 1) throw error;
      }
    }
    throw new Error("No OpenAI-compatible stream model available.");
  };

  if (typeof primaryModel.doGenerate === "function") {
    wrapped.doGenerate = async (options: unknown) => withGenerateFallback(options, 0);
  }

  if (typeof primaryModel.doStream === "function") {
    wrapped.doStream = async (options: unknown) => withStreamFallback(options, 0);
  }

  return wrapped as LanguageModel;
}

function resolveOpenAiCompatibleModel(
  modelId: string,
  cfg: ProviderConfig,
  apiKey: string,
): LanguageModel {
  const style = resolveOpenAiCompatibleApiStyle(cfg, modelId);
  const baseCandidates = resolveOpenAiCompatibleBaseUrlCandidatesForModel(cfg, modelId);
  const fallbackAttempts: Array<{ style: "chat" | "responses"; baseURL: string }> = [];
  for (const baseURL of baseCandidates) {
    if (style === "chat") {
      fallbackAttempts.push({ style: "chat", baseURL }, { style: "responses", baseURL });
    } else {
      fallbackAttempts.push({ style: "responses", baseURL }, { style: "chat", baseURL });
    }
  }

  const uniqueAttempts: Array<{ style: "chat" | "responses"; baseURL: string }> = [];
  const seen = new Set<string>();
  for (const attempt of fallbackAttempts) {
    const key = `${attempt.style}|${attempt.baseURL}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAttempts.push(attempt);
  }

  if (uniqueAttempts.length === 0) {
    uniqueAttempts.push({ style, baseURL: normalizeOpenAiCompatibleBaseUrl(cfg.baseUrl) });
  }

  const toFactory = (attempt: { style: "chat" | "responses"; baseURL: string }) => () => {
    const provider = createOpenAI({
      baseURL: attempt.baseURL,
      apiKey,
      fetch: withTimeoutFetch(LOCAL_PROVIDER_TIMEOUT_MS),
    });
    return attempt.style === "chat"
      ? provider.chat(modelId) as LanguageModel
      : provider.responses(modelId) as LanguageModel;
  };

  return withEndpointFallback(
    toFactory(uniqueAttempts[0]!),
    uniqueAttempts.slice(1).map((attempt) => toFactory(attempt)),
  );
}

function withTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const signal = AbortSignal.timeout(Math.max(1000, timeoutMs));
    if (init?.signal) {
      return fetch(input, init);
    }
    return fetch(input, { ...init, signal });
  };
}

function getProviderConfig(config: BenderConfig, provider: string): ProviderConfig {
  return config.providers?.[provider] ?? {};
}

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
    return (modelId) => provider.chat(modelId) as LanguageModel;
  },
  groq: (apiKey) => {
    const provider = createOpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey });
    return (modelId) => provider.chat(modelId) as LanguageModel;
  },
  "openai-compatible": (apiKey) => {
    const provider = createOpenAI({ apiKey });
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
  return provider !== "ollama" && provider !== "openai-compatible";
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
  rootConfig?: BenderConfig,
): LanguageModel {
  if (typeof tierConfig === "string") {
    if (defaultProvider === "openai-compatible") {
      const cfg = rootConfig ? getProviderConfig(rootConfig, defaultProvider) : {};
      const resolvedModel = tierConfig.trim() || cfg.model?.trim() || "local-model";
      return resolveOpenAiCompatibleModel(
        resolvedModel,
        cfg,
        defaultApiKey?.trim() || cfg.apiKey?.trim() || "not-required",
      );
    }
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
  if (tierConfig.provider === "openai-compatible") {
    const cfg = rootConfig ? getProviderConfig(rootConfig, tierConfig.provider) : {};
    const resolvedModel = tierConfig.model.trim() || cfg.model?.trim() || "local-model";
    return resolveOpenAiCompatibleModel(
      resolvedModel,
      cfg,
      tierConfig.apiKey?.trim() || cfg.apiKey?.trim() || "not-required",
    );
  }
  const providerApiKey = tierConfig.apiKey?.trim()
    || (rootConfig ? getProviderConfig(rootConfig, tierConfig.provider).apiKey?.trim() : undefined)
    || (tierConfig.provider === defaultProvider ? defaultApiKey?.trim() : undefined);
  assertProviderApiKeyAvailable(tierConfig.provider, providerApiKey);
  // Tier-level apiKey wins over anything else
  return factory(providerApiKey)(tierConfig.model);
}

export interface ModelSet {
  fast: LanguageModel;
  default: LanguageModel;
  strong: LanguageModel;
}

export interface ProviderModelSelection {
  provider: string;
  model: string;
  apiKey?: string;
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
    fast: resolveModelConfig(models.fast, provider, apiKey, config),
    default: resolveModelConfig(models.default, provider, apiKey, config),
    strong: resolveModelConfig(models.strong, provider, apiKey, config),
  };
}

export function createModelForSelection(
  config: BenderConfig,
  selection: ProviderModelSelection,
): LanguageModel {
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!provider) {
    throw new Error("provider is required");
  }
  if (!model) {
    throw new Error("model is required");
  }
  const apiKey = selection.apiKey
    ?? config.providers?.[provider]?.apiKey
    ?? (config.llm.provider === provider ? config.llm.apiKey : undefined);

  return resolveModelConfig(
    { provider, model, ...(apiKey ? { apiKey } : {}) },
    config.llm.provider,
    config.providers?.[config.llm.provider]?.apiKey ?? config.llm.apiKey,
    config,
  );
}

export function getProviderCapabilities(
  config: BenderConfig,
  provider: string,
  model?: string,
): {
  supportsTools: boolean;
  supportsJson: boolean;
  supportsStreaming: boolean;
} {
  const defaults = PROVIDER_DEFAULT_CAPABILITIES[provider] ?? {
    supportsTools: false,
    supportsJson: false,
    supportsStreaming: true,
  };
  const providerConfig = getProviderConfig(config, provider);
  const modelCaps = model ? providerConfig.modelCapabilities?.[model] : undefined;
  if (provider === "openai-compatible") {
    return {
      supportsTools: modelCaps?.supportsTools ?? providerConfig.supportsTools ?? defaults.supportsTools,
      supportsJson: modelCaps?.supportsJson ?? providerConfig.supportsJson ?? defaults.supportsJson,
      // Force non-streaming for compatibility; endpoint failover is handled in non-streaming mode.
      supportsStreaming: false,
    };
  }
  return {
    supportsTools: modelCaps?.supportsTools ?? providerConfig.supportsTools ?? defaults.supportsTools,
    supportsJson: modelCaps?.supportsJson ?? providerConfig.supportsJson ?? defaults.supportsJson,
    supportsStreaming: modelCaps?.supportsStreaming ?? providerConfig.supportsStreaming ?? defaults.supportsStreaming,
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
