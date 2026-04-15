import type { Express } from "express";
import { readEffectiveConfig, type BenderConfig } from "../../state/config.js";

type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama";

interface LlmRouteDeps {
  getCurrentProject: () => string | null;
  normalizeUserPath: (input?: string) => string;
  resolveProviderApiKey: (provider: LlmProvider, config: BenderConfig | null) => string | undefined;
  fetchLiveModels: (provider: LlmProvider, apiKey?: string) => Promise<string[]>;
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
      };

      const configFlags = {
        anthropic: !!config?.providers?.anthropic?.apiKey || (config?.llm.provider === "anthropic" && !!config?.llm.apiKey),
        openai: !!config?.providers?.openai?.apiKey || (config?.llm.provider === "openai" && !!config?.llm.apiKey),
        google: !!config?.providers?.google?.apiKey || (config?.llm.provider === "google" && !!config?.llm.apiKey),
        groq: !!config?.providers?.groq?.apiKey || (config?.llm.provider === "groq" && !!config?.llm.apiKey),
        ollama: config?.llm.provider === "ollama",
      };

      const providers = {
        anthropic: { configured: envFlags.anthropic || configFlags.anthropic },
        openai: { configured: envFlags.openai || configFlags.openai },
        google: { configured: envFlags.google || configFlags.google },
        groq: { configured: envFlags.groq || configFlags.groq },
        ollama: { configured: envFlags.ollama || configFlags.ollama },
      };

      const hasAnyKey =
        providers.anthropic.configured
        || providers.openai.configured
        || providers.google.configured
        || providers.groq.configured
        || providers.ollama.configured;

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
      if (!provider || !["anthropic", "openai", "google", "groq", "ollama"].includes(provider)) {
        res.status(400).json({ error: "provider query is required" });
        return;
      }

      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      const targetPath = rawPath.trim()
        ? deps.normalizeUserPath(rawPath)
        : deps.getCurrentProject();
      const config = await readEffectiveConfig(targetPath).catch(() => null);
      const apiKey = deps.resolveProviderApiKey(provider, config);
      const models = await deps.fetchLiveModels(provider, apiKey);
      res.json({ provider, models });
    } catch (err) {
      const message = (err as Error).message;
      res.status(500).json({ error: message });
    }
  });
}
