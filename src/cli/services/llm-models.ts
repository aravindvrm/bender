import type { BenderConfig } from "../../state/config.js";

export type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama";

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
  return "ollama";
}

export async function fetchLiveModels(provider: LlmProvider, apiKey?: string): Promise<string[]> {
  if (provider === "openai") {
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    const res = await fetch("https://api.openai.com/v1/models", {
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
    const res = await fetch("https://api.anthropic.com/v1/models", {
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google model list failed (${res.status})`);
    const body = await res.json() as { models?: Array<{ name?: string }> };
    const ids = (body.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.startsWith("gemini"));
    return uniqueSorted(ids).reverse();
  }

  if (provider === "groq") {
    if (!apiKey) throw new Error("Missing GROQ_API_KEY");
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Groq model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    return uniqueSorted((body.data ?? []).map((m) => m.id ?? "")).reverse();
  }

  const res = await fetch("http://localhost:11434/api/tags");
  if (!res.ok) throw new Error(`Ollama model list failed (${res.status})`);
  const body = await res.json() as { models?: Array<{ name?: string }> };
  return uniqueSorted((body.models ?? []).map((m) => m.name ?? "")).reverse();
}

