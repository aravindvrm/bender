import type { BenderConfig } from "../../state/config.js";

export type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama" | "local";

const MODEL_LIST_TIMEOUT_MS = 15_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 20_000;

function withTimeoutFetch(url: string, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
  if (init?.signal) return fetch(url, init);
  return fetch(url, { ...init, signal: timeoutSignal });
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function openAiCompatibleBaseCandidates(baseUrl: string): string[] {
  const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  if (!normalized) return [];
  return normalized.endsWith("/v1")
    ? [normalized]
    : [normalized, `${normalized}/v1`];
}

interface OpenAiCompatibleChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string } }>;
    };
  }>;
  error?: unknown;
}

export interface ModelCapabilityResult {
  supportsTools: boolean;
  supportsJson: boolean;
  supportsStreaming: boolean;
  endpoint?: string;
  apiStyle?: "chat" | "responses" | "auto";
  errors?: string[];
}

type OpenAiCompatibleApiStyle = "chat" | "responses";

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasErrorEnvelope(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return Object.prototype.hasOwnProperty.call(value, "error");
}

function isChatSuccessPayload(value: unknown): value is OpenAiCompatibleChatResponse {
  if (!isObjectRecord(value)) return false;
  if (hasErrorEnvelope(value)) return false;
  const choices = (value as OpenAiCompatibleChatResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  if (!first || typeof first !== "object") return false;
  const message = first.message;
  // A valid chat completion has either message.content (string) or
  // message.tool_calls — `null` message means the server produced nothing we
  // can consume (which is what LM Studio occasionally emits on bad prompts).
  if (!message || typeof message !== "object") return false;
  const hasContent = typeof message.content === "string" && message.content.length >= 0;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (!hasContent && !hasToolCalls) return false;
  // Usage is optional, but if present it must contain recognizable token keys
  // so the Vercel AI SDK can map them to inputTokens/outputTokens.
  const usage = (value as Record<string, unknown>).usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const u = usage as Record<string, unknown>;
    const hasInput = "prompt_tokens" in u || "input_tokens" in u;
    const hasOutput = "completion_tokens" in u || "output_tokens" in u;
    if (!hasInput || !hasOutput) return false;
  }
  return true;
}

function isResponsesSuccessPayload(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  if (hasErrorEnvelope(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "output")
    || Object.prototype.hasOwnProperty.call(value, "id")
    || Object.prototype.hasOwnProperty.call(value, "output_text")
  );
}

async function postJsonWithTimeout(
  url: string,
  body: Record<string, unknown>,
  apiKey?: string,
  timeoutMs = CAPABILITY_PROBE_TIMEOUT_MS,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return await fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal,
  });
}

async function resolveCompatibleEndpoint(
  baseUrl: string,
  model: string,
  apiKey?: string,
): Promise<{ endpoint: string; apiStyle: OpenAiCompatibleApiStyle }> {
  const bases = openAiCompatibleBaseCandidates(baseUrl);
  let lastError = "Unable to resolve OpenAI-compatible endpoint";
  for (const base of bases) {
    const chatEndpoint = `${base}/chat/completions`;
    try {
      const res = await postJsonWithTimeout(chatEndpoint, {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false,
      }, apiKey);
      if (!res.ok) {
        lastError = `Chat endpoint probe failed (${res.status}) at ${chatEndpoint}`;
      } else {
        const body = await res.json() as unknown;
        if (isChatSuccessPayload(body)) {
          return { endpoint: chatEndpoint, apiStyle: "chat" };
        }
        const shape = hasErrorEnvelope(body) ? "error envelope" : "unexpected shape";
        lastError = `Chat endpoint probe returned ${shape} at ${chatEndpoint}`;
      }
    } catch (err) {
      lastError = `${(err as Error).message} at ${chatEndpoint}`;
    }

    const responsesEndpoint = `${base}/responses`;
    try {
      const res = await postJsonWithTimeout(responsesEndpoint, {
        model,
        input: "ping",
        max_output_tokens: 8,
        stream: false,
      }, apiKey);
      if (!res.ok) {
        lastError = `Responses endpoint probe failed (${res.status}) at ${responsesEndpoint}`;
      } else {
        const body = await res.json() as unknown;
        if (isResponsesSuccessPayload(body)) {
          return { endpoint: responsesEndpoint, apiStyle: "responses" };
        }
        const shape = hasErrorEnvelope(body) ? "error envelope" : "unexpected shape";
        lastError = `Responses endpoint probe returned ${shape} at ${responsesEndpoint}`;
      }
    } catch (err) {
      lastError = `${(err as Error).message} at ${responsesEndpoint}`;
    }
  }
  throw new Error(lastError);
}

async function probeStreaming(
  endpoint: string,
  model: string,
  apiStyle: OpenAiCompatibleApiStyle,
  apiKey?: string,
): Promise<boolean> {
  const payload = apiStyle === "chat"
    ? {
        model,
        messages: [{ role: "user", content: "Return a short one-word answer." }],
        max_tokens: 8,
        stream: true,
      }
    : {
        model,
        input: "Return a short one-word answer.",
        max_output_tokens: 8,
        stream: true,
      };
  const res = await postJsonWithTimeout(endpoint, payload, apiKey, CAPABILITY_PROBE_TIMEOUT_MS);
  if (!res.ok) return false;
  if (!res.body) return false;
  const reader = res.body.getReader();
  try {
    await reader.read();
    return true;
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function probeJsonMode(
  endpoint: string,
  model: string,
  apiStyle: OpenAiCompatibleApiStyle,
  apiKey?: string,
): Promise<boolean> {
  if (apiStyle !== "chat") return false;
  const res = await postJsonWithTimeout(endpoint, {
    model,
    messages: [{ role: "user", content: "Return {\"ok\":true}." }],
    max_tokens: 32,
    stream: false,
    response_format: { type: "json_object" },
  }, apiKey);
  if (!res.ok) return false;
  const body = await res.json() as OpenAiCompatibleChatResponse;
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

async function probeTools(
  endpoint: string,
  model: string,
  apiStyle: OpenAiCompatibleApiStyle,
  apiKey?: string,
): Promise<boolean> {
  if (apiStyle !== "chat") return false;
  const res = await postJsonWithTimeout(endpoint, {
    model,
    messages: [{ role: "user", content: "Call the echo function with value=test." }],
    max_tokens: 48,
    stream: false,
    tools: [{
      type: "function",
      function: {
        name: "echo",
        description: "Echoes the provided value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    }],
    tool_choice: {
      type: "function",
      function: { name: "echo" },
    },
  }, apiKey);
  if (!res.ok) return false;
  const body = await res.json() as OpenAiCompatibleChatResponse;
  const calls = body.choices?.[0]?.message?.tool_calls ?? [];
  return calls.some((call) => call.function?.name === "echo");
}

export async function detectOpenAiCompatibleCapabilities(
  baseUrl: string,
  models: string[],
  apiKey?: string,
): Promise<Record<string, ModelCapabilityResult>> {
  if (!baseUrl.trim()) throw new Error("baseUrl is required for capability detection");
  const uniqueModels = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
  if (uniqueModels.length === 0) throw new Error("At least one model is required for capability detection");

  const results: Record<string, ModelCapabilityResult> = {};

  for (const model of uniqueModels) {
    const errors: string[] = [];
    let endpoint = "";
    let apiStyle: OpenAiCompatibleApiStyle = "chat";
    try {
      const resolved = await resolveCompatibleEndpoint(baseUrl, model, apiKey);
      endpoint = resolved.endpoint;
      apiStyle = resolved.apiStyle;
    } catch (err) {
      results[model] = {
        supportsTools: false,
        supportsJson: false,
        supportsStreaming: false,
        apiStyle: "auto",
        errors: [(err as Error).message],
      };
      continue;
    }

    let supportsStreaming = false;
    let supportsJson = false;
    let supportsTools = false;

    try {
      supportsStreaming = await probeStreaming(endpoint, model, apiStyle, apiKey);
    } catch (err) {
      errors.push(`streaming: ${(err as Error).message}`);
    }

    try {
      supportsJson = await probeJsonMode(endpoint, model, apiStyle, apiKey);
    } catch (err) {
      errors.push(`json: ${(err as Error).message}`);
    }

    try {
      supportsTools = await probeTools(endpoint, model, apiStyle, apiKey);
    } catch (err) {
      errors.push(`tools: ${(err as Error).message}`);
    }

    results[model] = {
      supportsTools,
      supportsJson,
      supportsStreaming,
      endpoint,
      apiStyle,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  return results;
}

export function resolveProviderApiKey(
  provider: LlmProvider,
  config: BenderConfig | null,
): string | undefined {
  if (provider === "anthropic") {
    return config?.providers?.anthropic?.apiKey
      ?? (config?.llm.provider === "anthropic" ? config.llm.apiKey : undefined)
      ?? process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "openai") {
    return config?.providers?.openai?.apiKey
      ?? (config?.llm.provider === "openai" ? config.llm.apiKey : undefined)
      ?? process.env.OPENAI_API_KEY;
  }
  if (provider === "google") {
    return config?.providers?.google?.apiKey
      ?? (config?.llm.provider === "google" ? config.llm.apiKey : undefined)
      ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
      ?? process.env.GOOGLE_API_KEY;
  }
  if (provider === "groq") {
    return config?.providers?.groq?.apiKey
      ?? (config?.llm.provider === "groq" ? config.llm.apiKey : undefined)
      ?? process.env.GROQ_API_KEY;
  }
  if (provider === "local") {
    return config?.providers?.["local"]?.apiKey
      ?? (config?.llm.provider === "local" ? config.llm.apiKey : undefined);
  }
  return "ollama";
}

export function resolveProviderBaseUrl(provider: LlmProvider, config: BenderConfig | null): string | undefined {
  if (provider !== "local") return undefined;
  const explicit = config?.providers?.["local"]?.baseUrl?.trim();
  if (explicit) return normalizeOpenAiCompatibleBaseUrl(explicit);
  return undefined;
}

export async function fetchLiveModels(provider: LlmProvider, apiKey?: string, baseUrl?: string): Promise<string[]> {
  if (provider === "openai") {
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    const res = await withTimeoutFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) =>
        /^(gpt-|o[1-9]|chatgpt)/.test(id)
        && !/(audio|realtime|transcribe|tts|image|moderation|embedding|whisper|davinci|babbage)/.test(id),
      );
    return uniqueSorted(ids).reverse();
  }

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
    const res = await withTimeoutFetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Anthropic model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    return uniqueSorted((body.data ?? []).map((m) => m.id ?? "")).reverse();
  }

  if (provider === "google") {
    if (!apiKey) throw new Error("Missing GOOGLE_GENERATIVE_AI_API_KEY");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await withTimeoutFetch(url);
    if (!res.ok) throw new Error(`Google model list failed (${res.status})`);
    const body = await res.json() as { models?: Array<{ name?: string }> };
    const ids = (body.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.startsWith("gemini"));
    return uniqueSorted(ids).reverse();
  }

  if (provider === "groq") {
    if (!apiKey) throw new Error("Missing GROQ_API_KEY");
    const res = await withTimeoutFetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Groq model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    return uniqueSorted((body.data ?? []).map((m) => m.id ?? "")).reverse();
  }

  if (provider === "local") {
    if (!baseUrl) throw new Error("Missing baseUrl for local provider");
    const candidates = openAiCompatibleBaseCandidates(baseUrl);
    const headers: Record<string, string> = {};
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
    let lastError = "OpenAI-compatible model list failed";
    for (const base of candidates) {
      const endpoint = `${base}/models`;
      try {
        const res = await withTimeoutFetch(endpoint, { headers });
        if (!res.ok) {
          lastError = `OpenAI-compatible model list failed (${res.status}) at ${endpoint}`;
          continue;
        }
        const body = await res.json() as { data?: Array<{ id?: string }> };
        const models = uniqueSorted((body.data ?? []).map((m) => m.id ?? "")).reverse();
        if (models.length > 0) return models;
        lastError = `OpenAI-compatible endpoint returned no models at ${endpoint}`;
      } catch (err) {
        lastError = `${(err as Error).message} (${endpoint})`;
      }
    }
    throw new Error(lastError);
  }

  const res = await withTimeoutFetch("http://localhost:11434/api/tags");
  if (!res.ok) throw new Error(`Ollama model list failed (${res.status})`);
  const body = await res.json() as { models?: Array<{ name?: string }> };
  return uniqueSorted((body.models ?? []).map((m) => m.name ?? "")).reverse();
}
