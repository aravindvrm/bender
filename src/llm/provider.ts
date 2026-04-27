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
  "local": { supportsTools: false, supportsJson: false, supportsStreaming: false },
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
  // Even when the user has pinned a specific endpoint via modelCapabilities,
  // still generate /v1 and non-/v1 sibling candidates. Users commonly configure
  // `http://host:port/chat/completions` when the server actually serves at
  // `http://host:port/v1/chat/completions` (or vice-versa). Trying both is
  // cheap and avoids forcing users to guess the correct path.
  const source = hinted ?? cfg.baseUrl;
  return openAiCompatibleBaseCandidates(source);
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

function isHostUnreachableError(error: unknown): boolean {
  const text = stringifyProviderError(error).toLowerCase();
  // Permanent network errors — the host is down/unreachable/unknown. Retrying
  // a different URL candidate won't help, and the ai SDK will still do its own
  // internal retry (maxRetries) so we don't need to add more on top.
  return (
    text.includes("ehostdown")
    || text.includes("ehostunreach")
    || text.includes("enetunreach")
    || text.includes("enetdown")
    || text.includes("enotfound")
    || text.includes("host is down")
    || text.includes("no route to host")
    || text.includes("network is unreachable")
  );
}

function isTerminalOpenAiCompatibleError(error: unknown): boolean {
  if (isHostUnreachableError(error)) return true;
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
  candidateLabels?: string[],
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

  const labelFor = (i: number) => candidateLabels?.[i] ?? `candidate ${i + 1}`;

  const logFallback = (i: number, error: unknown) => {
    const reason = stringifyProviderError(error).split("\n")[0]?.slice(0, 160) ?? "unknown error";
    process.stderr.write(`[local] ${labelFor(i)} failed (${reason}), trying ${labelFor(i + 1)}\n`);
  };

  // Build a rich final error showing *every* candidate's failure, so the user
  // can see exactly what each endpoint variant returned instead of just the
  // last one in the chain.
  const buildAggregateError = (errors: Array<{ label: string; error: unknown }>): Error => {
    const header = `All ${errors.length} local-endpoint candidate(s) failed:`;
    const body = errors
      .map((e, idx) => {
        const reason = stringifyProviderError(e.error).split("\n")[0]?.slice(0, 300) ?? "unknown";
        return `  ${idx + 1}. ${e.label} → ${reason}`;
      })
      .join("\n");
    const hint = "\nHint: check that your server's baseUrl is correct, the model ID matches a loaded model, and that the server speaks the OpenAI chat-completions or responses API.";
    return new Error(`${header}\n${body}${hint}`);
  };

  const withGenerateFallback = async (options: unknown, startIndex: number): Promise<unknown> => {
    const errors: Array<{ label: string; error: unknown }> = [];
    for (let i = startIndex; i < factories.length; i += 1) {
      const candidate = ensureModel(i);
      if (typeof candidate.doGenerate !== "function") continue;
      try {
        return await candidate.doGenerate(options);
      } catch (error) {
        errors.push({ label: labelFor(i), error });
        if (!shouldRetryOpenAiCompatibleFallback(error)) {
          // Terminal error (auth, rate limit, host down) — no point trying more candidates.
          if (errors.length > 1) throw buildAggregateError(errors);
          throw error;
        }
        if (i === factories.length - 1) {
          throw buildAggregateError(errors);
        }
        logFallback(i, error);
      }
    }
    throw new Error("No OpenAI-compatible generate model available.");
  };

  const withStreamFallback = async (options: unknown, startIndex: number): Promise<unknown> => {
    const errors: Array<{ label: string; error: unknown }> = [];
    for (let i = startIndex; i < factories.length; i += 1) {
      const candidate = ensureModel(i);
      if (typeof candidate.doStream !== "function") continue;
      try {
        return await candidate.doStream(options);
      } catch (error) {
        errors.push({ label: labelFor(i), error });
        if (!shouldRetryOpenAiCompatibleFallback(error)) {
          if (errors.length > 1) throw buildAggregateError(errors);
          throw error;
        }
        if (i === factories.length - 1) {
          throw buildAggregateError(errors);
        }
        logFallback(i, error);
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

function isOfficialOpenAiHost(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".api.openai.com");
  } catch {
    return false;
  }
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
    const isOpenAiHost = isOfficialOpenAiHost(baseURL);
    if (style === "chat") {
      fallbackAttempts.push({ style: "chat", baseURL });
      // For the official OpenAI API, interleave responses alongside each base URL.
      // For local/compatible servers: chat-completions is the norm, so exhaust
      // all base-URL variants first, then try responses as a last resort.
      if (isOpenAiHost) fallbackAttempts.push({ style: "responses", baseURL });
    } else {
      fallbackAttempts.push({ style: "responses", baseURL });
      fallbackAttempts.push({ style: "chat", baseURL });
    }
  }

  // For non-OpenAI chat-style: append responses across all base URLs as a
  // last-resort fallback. Some servers (e.g., newer OpenAI-compatible
  // deployments) implement only the /responses endpoint. We try chat
  // exhaustively first to avoid confusing errors on servers that don't support
  // responses, but fall back here rather than giving up entirely.
  if (style === "chat") {
    for (const baseURL of baseCandidates) {
      if (!isOfficialOpenAiHost(baseURL)) {
        fallbackAttempts.push({ style: "responses", baseURL });
      }
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
    const baseURL = normalizeOpenAiCompatibleBaseUrl(cfg.baseUrl);
    uniqueAttempts.push({ style, baseURL });
  }

  const toFactory = (attempt: { style: "chat" | "responses"; baseURL: string }) => () => {
    const provider = createOpenAI({
      baseURL: attempt.baseURL,
      apiKey,
      fetch: withDiagnosticFetch(withTimeoutFetch(LOCAL_PROVIDER_TIMEOUT_MS), attempt.baseURL),
    });
    return attempt.style === "chat"
      ? provider.chat(modelId) as LanguageModel
      : provider.responses(modelId) as LanguageModel;
  };

  const labels = uniqueAttempts.map((a) => {
    const path = a.style === "chat" ? "/chat/completions" : "/responses";
    return `${a.baseURL}${path}`;
  });

  return withEndpointFallback(
    toFactory(uniqueAttempts[0]!),
    uniqueAttempts.slice(1).map((attempt) => toFactory(attempt)),
    labels,
  );
}

/**
 * Wraps a fetch implementation so that JSON bodies from OpenAI-compatible
 * endpoints are sanity-checked before the AI SDK tries to parse them. When the
 * payload is clearly malformed (missing `choices`, missing/typo'd `usage`
 * fields, `message: null`, etc.) we throw an explicit error with the raw body
 * snippet attached, so debugging a local server becomes tractable rather than
 * surfacing a cryptic "data shape mismatch" / Zod validation trace.
 */
function withDiagnosticFetch(inner: typeof fetch, baseURL: string): typeof fetch {
  const debug = process.env.BENDER_LOCAL_DEBUG === "1";
  return async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;

    if (debug) {
      const bodyPreview = typeof init?.body === "string"
        ? init.body.slice(0, 400)
        : "<non-string body>";
      process.stderr.write(`[local:debug] → POST ${url}\n[local:debug]   body: ${bodyPreview}\n`);
    }

    const response = await inner(input, init);

    if (debug) {
      process.stderr.write(`[local:debug] ← ${response.status} ${response.statusText} from ${url}\n`);
    }

    // Only inspect chat-completions/responses endpoints, only for successful
    // JSON responses, and never for streams (they're consumed elsewhere).
    const shouldInspect = response.ok
      && !response.headers.get("content-type")?.includes("event-stream")
      && (url.includes("/chat/completions") || url.endsWith("/responses"));
    if (!shouldInspect) {
      if (debug && !response.ok) {
        try {
          const body = await response.clone().text();
          process.stderr.write(`[local:debug]   body preview: ${body.slice(0, 400)}\n`);
        } catch { /* ignore */ }
      }
      return response;
    }

    let raw: string;
    try {
      raw = await response.clone().text();
    } catch {
      return response;
    }

    if (debug) {
      process.stderr.write(`[local:debug]   body preview: ${raw.slice(0, 600)}\n`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const snippet = raw.slice(0, 500);
      throw new Error(
        `OpenAI-compatible endpoint at ${baseURL} returned non-JSON body. `
        + `Raw body (truncated): ${snippet}`,
      );
    }

    // When the server sends an error object with HTTP 200 (unusual but happens
    // with some local servers), surface it as a real error so the fallback
    // logic sees the actual message rather than a cryptic "choices undefined".
    if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
      const errVal = (parsed as Record<string, unknown>).error;
      const errMsg = typeof errVal === "string"
        ? errVal
        : typeof errVal === "object" && errVal && "message" in (errVal as Record<string, unknown>)
          ? String((errVal as Record<string, unknown>).message)
          : JSON.stringify(errVal);
      throw new Error(`OpenAI-compatible server error: ${errMsg}`);
    }

    const diagnostic = diagnoseOpenAiCompatiblePayload(parsed, url);
    if (diagnostic) {
      const snippet = raw.slice(0, 500);
      throw new Error(
        `OpenAI-compatible endpoint at ${baseURL} returned an incompatible payload: `
        + `${diagnostic}. Raw body (truncated): ${snippet}`,
      );
    }

    return response;
  };
}

function diagnoseOpenAiCompatiblePayload(payload: unknown, url: string): string | null {
  if (!payload || typeof payload !== "object") {
    return "payload is not a JSON object";
  }
  const body = payload as Record<string, unknown>;
  // Note: error-shaped responses ({"error":"..."}) are caught before this
  // function is called (in withDiagnosticFetch) and thrown directly, so we
  // don't need to handle them here.
  if (url.endsWith("/responses")) {
    if (!("output" in body) && !("output_text" in body) && !("id" in body)) {
      return "responses payload missing `output`/`output_text`/`id`";
    }
    return null;
  }
  // chat-completions path
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "chat payload missing non-empty `choices` array";
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | null | undefined;
  const delta = first?.delta; // streaming chunks have `delta`, not `message`
  if (message === null) {
    return "chat payload has `choices[0].message: null`";
  }
  if (!message && !delta) {
    return "chat payload missing `choices[0].message`";
  }
  if (message && message.content === null && !message.tool_calls) {
    return "chat payload has `message.content: null` with no `tool_calls`";
  }
  const usage = body.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    const hasInput = "prompt_tokens" in usage || "input_tokens" in usage;
    const hasOutput = "completion_tokens" in usage || "output_tokens" in usage;
    if (!hasInput || !hasOutput) {
      return `usage present but missing token fields (got keys: ${Object.keys(usage).join(",")})`;
    }
  }
  return null;
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
  "local": (apiKey) => {
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
  return provider !== "ollama" && provider !== "local";
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
    if (defaultProvider === "local") {
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
  if (tierConfig.provider === "local") {
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

export function resolveProviderModelForTier(
  config: BenderConfig,
  tier: ModelTier,
): ProviderModelSelection {
  const tierConfig = config.llm.models[tier];
  if (typeof tierConfig === "string") {
    const provider = config.llm.provider;
    const configuredDefault = config.providers?.[provider]?.model?.trim() ?? "";
    const model = tierConfig.trim()
      || configuredDefault
      || (provider === "local" ? "local-model" : "");
    return { provider, model };
  }

  const provider = tierConfig.provider?.trim() || config.llm.provider;
  const configuredDefault = config.providers?.[provider]?.model?.trim() ?? "";
  const model = tierConfig.model?.trim()
    || configuredDefault
    || (provider === "local" ? "local-model" : "");
  return { provider, model };
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
  if (provider === "local") {
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
