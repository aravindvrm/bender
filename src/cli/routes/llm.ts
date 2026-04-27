import type { Express } from "express";
import { readEffectiveConfig, type BenderConfig } from "../../state/config.js";

type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama" | "local";
const LLM_PROVIDERS: LlmProvider[] = ["anthropic", "openai", "google", "groq", "ollama", "local"];

interface LlmRouteDeps {
  getCurrentProject: () => string | null;
  normalizeUserPath: (input?: string) => string;
  resolveProviderApiKey: (provider: LlmProvider, config: BenderConfig | null) => string | undefined;
  resolveProviderBaseUrl: (provider: LlmProvider, config: BenderConfig | null) => string | undefined;
  fetchLiveModels: (provider: LlmProvider, apiKey?: string, baseUrl?: string) => Promise<string[]>;
  detectOpenAiCompatibleCapabilities: (
    baseUrl: string,
    models: string[],
    apiKey?: string,
  ) => Promise<Record<string, {
    supportsTools: boolean;
    supportsJson: boolean;
    supportsStreaming: boolean;
    endpoint?: string;
    errors?: string[];
  }>>;
}

export function registerLlmRoutes(app: Express, deps: LlmRouteDeps): void {
  app.get("/api/llm/status", async (req, res) => {
    try {
      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      const targetPath = rawPath.trim()
        ? deps.normalizeUserPath(rawPath)
        : deps.getCurrentProject();

      const config = await readEffectiveConfig(targetPath).catch(() => null);
      const envFlags = {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        google: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY || !!process.env.GOOGLE_API_KEY,
        groq: !!process.env.GROQ_API_KEY,
        ollama: false,
        "local": false,
      };

      const configFlags = {
        anthropic: !!config?.providers?.anthropic?.apiKey || (config?.llm.provider === "anthropic" && !!config?.llm.apiKey),
        openai: !!config?.providers?.openai?.apiKey || (config?.llm.provider === "openai" && !!config?.llm.apiKey),
        google: !!config?.providers?.google?.apiKey || (config?.llm.provider === "google" && !!config?.llm.apiKey),
        groq: !!config?.providers?.groq?.apiKey || (config?.llm.provider === "groq" && !!config?.llm.apiKey),
        ollama: config?.llm.provider === "ollama",
        "local": !!config?.providers?.["local"]?.baseUrl,
      };

      const providers = {
        anthropic: { configured: envFlags.anthropic || configFlags.anthropic },
        openai: { configured: envFlags.openai || configFlags.openai },
        google: { configured: envFlags.google || configFlags.google },
        groq: { configured: envFlags.groq || configFlags.groq },
        ollama: { configured: envFlags.ollama || configFlags.ollama },
        "local": { configured: envFlags["local"] || configFlags["local"] },
      };

      const hasAnyKey =
        providers.anthropic.configured
        || providers.openai.configured
        || providers.google.configured
        || providers.groq.configured
        || providers.ollama.configured
        || providers["local"].configured;

      const provider = (config?.llm.provider ?? "anthropic") as LlmProvider;
      const activeProviderConfigured = providers[provider]?.configured ?? false;
      const needsSetup = !hasAnyKey;

      res.json({
        provider,
        providers,
        hasAnyKey,
        activeProviderConfigured,
        needsSetup,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/llm/models", async (req, res) => {
    try {
      const provider = String(req.query.provider ?? "").trim() as LlmProvider;
      if (!provider || !LLM_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: "provider query is required" });
        return;
      }

      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      const targetPath = rawPath.trim()
        ? deps.normalizeUserPath(rawPath)
        : deps.getCurrentProject();
      const config = await readEffectiveConfig(targetPath).catch(() => null);
      const apiKey = deps.resolveProviderApiKey(provider, config);
      const baseUrl = deps.resolveProviderBaseUrl(provider, config);
      const models = await deps.fetchLiveModels(provider, apiKey, baseUrl);
      res.json({ provider, models });
    } catch (err) {
      const message = (err as Error).message;
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/llm/capabilities/detect", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        provider?: LlmProvider;
        baseUrl?: string;
        apiKey?: string;
        models?: string[];
      };
      const provider = body.provider;
      if (provider !== "local") {
        res.status(400).json({ error: "capability detection currently supports provider=local only" });
        return;
      }
      const baseUrl = String(body.baseUrl ?? "").trim();
      const models = Array.isArray(body.models) ? body.models.map((m) => String(m).trim()).filter(Boolean) : [];
      if (!baseUrl) {
        res.status(400).json({ error: "baseUrl is required" });
        return;
      }
      if (models.length === 0) {
        res.status(400).json({ error: "models must include at least one model id" });
        return;
      }
      const capabilities = await deps.detectOpenAiCompatibleCapabilities(baseUrl, models, body.apiKey);
      res.json({ provider, capabilities });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
