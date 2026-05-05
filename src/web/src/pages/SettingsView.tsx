import { useState, useEffect, useRef } from "react";
import { LoadingDots } from "../components/LoadingDots";
import {
  normalizeTierModels,
  normalizeTierModelValue,
  getDefaultModelForProviderTier,
  looksLikeHostedOpenAiModel,
  getModelOptions,
} from "./settings/shared";
import type {
  FullConfig,
  ConfigResponse,
  LlmStatus,
  ModelTier,
  ThemeSummary,
  ThemeListResponse,
} from "./settings/types";
import { MODEL_TIERS, PROVIDERS } from "./settings/types";
import { GitHubSection } from "./settings/GitHubSection";
import { MCPSection } from "./settings/MCPSection";
import { LLMSection } from "./settings/LLMSection";
import { PreferencesSection } from "./settings/PreferencesSection";
import { StorageSection } from "./settings/StorageSection";
import { ThemeSection } from "./settings/ThemeSection";

type ConfigScope = "global" | "project";

interface SettingsViewProps {
  runOperation?: (
    url: string,
    body: Record<string, unknown>,
    options?: { onSuccess?: () => void; onFinish?: (success: boolean) => void },
  ) => void;
}

export function SettingsView({ runOperation }: SettingsViewProps = {}) {
  const DEFAULT_THEME_ID = "bender-default-dark";
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [configScope, setConfigScope] = useState<ConfigScope>("global");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [liveModelOptions, setLiveModelOptions] = useState<Record<string, string[]>>({});
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(null);
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [themeLoading, setThemeLoading] = useState(false);
  const [themeImporting, setThemeImporting] = useState(false);
  const [themeNotice, setThemeNotice] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string>("");
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  async function refreshThemes(): Promise<void> {
    setThemeLoading(true);
    try {
      const res = await fetch("/api/themes");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load themes");
      const result = body as ThemeListResponse;
      setThemes(Array.isArray(result.themes) ? result.themes : []);
      setActiveThemeId(result.activeThemeId || DEFAULT_THEME_ID);
      setThemeError(null);
    } catch (err) {
      setThemeError((err as Error).message);
    } finally {
      setThemeLoading(false);
    }
  }

  useEffect(() => {
    fetch("/api/config")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Failed to load config");
        return data as ConfigResponse;
      })
      .then((data) => {
        const providers: FullConfig["providers"] = {};
        for (const p of PROVIDERS) {
          providers[p] = {
            apiKey: data.providers?.[p]?.apiKey ?? "",
            baseUrl: data.providers?.[p]?.baseUrl ?? "",
            model: data.providers?.[p]?.model ?? "",
            supportsTools: data.providers?.[p]?.supportsTools,
            supportsJson: data.providers?.[p]?.supportsJson,
            supportsStreaming: data.providers?.[p]?.supportsStreaming,
            modelCapabilities: data.providers?.[p]?.modelCapabilities ?? {},
          };
        }
        setConfigScope(data.scope ?? "global");
        if (data.projectRoot) setProjectRoot(data.projectRoot);
        const fallbackProvider = data.llm?.provider?.trim() || "anthropic";
        const normalizedModels = normalizeTierModels(data.llm.models, fallbackProvider, providers);
        for (const tier of MODEL_TIERS) {
          const entry = normalizedModels[tier];
          if (entry.provider === "local" && looksLikeHostedOpenAiModel(entry.model)) {
            normalizedModels[tier] = {
              ...entry,
              model: getDefaultModelForProviderTier("local", tier, providers),
            };
          }
        }
        setConfig({
          llm: {
            ...data.llm,
            provider: normalizedModels.default.provider || fallbackProvider,
            models: normalizedModels,
          },
          providers,
          mcp: {
            enabled: data.mcp?.enabled ?? false,
            servers: data.mcp?.servers ?? [],
          },
          skills: {
            enabled: data.skills?.enabled ?? false,
            enabledSkills: data.skills?.enabledSkills ?? [],
            paths: data.skills?.paths ?? [],
            maxChars: data.skills?.maxChars ?? 12000,
          },
          ui: {
            themeId: data.ui?.themeId ?? DEFAULT_THEME_ID,
          },
          stack: data.stack,
          deploy: data.deploy,
          test: data.test,
          reanalyze: {
            enabled: data.reanalyze?.enabled ?? true,
            threshold: data.reanalyze?.threshold ?? 3,
          },
          logging: {
            enabled: data.logging?.enabled ?? true,
            level: data.logging?.level ?? "info",
            consoleLevel: data.logging?.consoleLevel ?? "warn",
          },
        });
        setLoading(false);
      })
      .catch((err) => { setError((err as Error).message); setLoading(false); });

    void refreshThemes();

    fetch("/api/state")
      .then((r) => r.json())
      .then((data) => { if (data.projectRoot) setProjectRoot(data.projectRoot); })
      .catch(() => {});

    fetch("/api/llm/status")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Failed to load LLM status");
        return data as LlmStatus;
      })
      .then(setLlmStatus)
      .catch(() => {});
  }, []);

  async function persistConfig(nextConfig: FullConfig, silent = false): Promise<boolean> {
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Save failed");
      }
      if (!silent) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }

  function enqueuePersistConfig(nextConfig: FullConfig, silent = false): Promise<boolean> {
    const run = async () => await persistConfig(nextConfig, silent);
    const queued = persistQueueRef.current.then(run, run);
    persistQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await enqueuePersistConfig(config, false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
      window.dispatchEvent(new Event("bender:theme-refresh"));
    }
  }

  function handleSetTheme(themeId: string): void {
    if (!themeId.trim()) return;
    setThemeError(null);
    setThemeNotice(null);
    setConfig((c) => {
      if (!c) return c;
      const nextConfig: FullConfig = {
        ...c,
        ui: { ...c.ui, themeId },
      };
      void enqueuePersistConfig(nextConfig, true).then((ok) => {
        if (!ok) return;
        setActiveThemeId(themeId);
        setThemeNotice("Theme updated.");
        window.dispatchEvent(new Event("bender:theme-refresh"));
      });
      return nextConfig;
    });
  }

  async function handleDeleteTheme(themeId: string, deleteScope: "global" | "project"): Promise<void> {
    setThemeError(null);
    setThemeNotice(null);
    try {
      const res = await fetch(`/api/themes/${encodeURIComponent(themeId)}?scope=${deleteScope}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Delete failed");
      // If deleted theme was active, fall back to default
      if ((config?.ui?.themeId ?? activeThemeId) === themeId) {
        handleSetTheme(DEFAULT_THEME_ID);
      }
      await refreshThemes();
      setThemeNotice("Theme deleted.");
    } catch (err) {
      setThemeError((err as Error).message);
    }
  }

  async function handleImportVsCodeTheme(jsonText: string): Promise<void> {
    const scope = configScope === "project" ? "project" : "global";
    setThemeImporting(true);
    setThemeError(null);
    setThemeNotice(null);
    try {
      const res = await fetch("/api/themes/import/vscode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          json: jsonText,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Theme import failed");
      const importedThemeId = typeof body.importedThemeId === "string" ? body.importedThemeId : DEFAULT_THEME_ID;
      setConfig((c) => c ? { ...c, ui: { ...c.ui, themeId: importedThemeId } } : c);
      setActiveThemeId(importedThemeId);
      await refreshThemes();
      window.dispatchEvent(new Event("bender:theme-refresh"));
      const warningCount = Array.isArray(body.warnings) ? body.warnings.length : 0;
      setThemeNotice(warningCount > 0 ? `Imported with ${warningCount} warning(s).` : "Theme imported.");
    } catch (err) {
      setThemeError((err as Error).message);
    } finally {
      setThemeImporting(false);
    }
  }

  // ── LLM tier helpers ────────────────────────────────────────────────────────

  function resolveTierModelConfig(tier: ModelTier, source: FullConfig) {
    return normalizeTierModelValue(source.llm.models[tier], tier, source.llm.provider, source.providers);
  }

  function handleSetTierProvider(tier: ModelTier, provider: string) {
    if (!provider) return;
    setConfig((c) => {
      if (!c) return c;
      const options = getModelOptions(provider, c, liveModelOptions);
      const current = resolveTierModelConfig(tier, c);
      const configuredDefault = (c.providers?.[provider]?.model ?? "").trim();
      let model = current.provider === provider ? current.model.trim() : "";
      if (!model || !options.includes(model)) {
        model = configuredDefault || options[0] || getDefaultModelForProviderTier(provider, tier, c.providers);
      }
      const nextModels = { ...c.llm.models, [tier]: { provider, model } };
      const nextConfig: FullConfig = {
        ...c,
        llm: {
          ...c.llm,
          provider: normalizeTierModelValue(nextModels.default, "default", c.llm.provider, c.providers).provider,
          models: nextModels,
        },
      };
      void enqueuePersistConfig(nextConfig, true);
      return nextConfig;
    });
  }

  function handleSetTierModel(tier: ModelTier, value: string) {
    setConfig((c) => {
      if (!c) return c;
      const tierConfig = resolveTierModelConfig(tier, c);
      const nextModels = { ...c.llm.models, [tier]: { ...tierConfig, model: value } };
      const nextConfig: FullConfig = {
        ...c,
        llm: {
          ...c.llm,
          provider: normalizeTierModelValue(nextModels.default, "default", c.llm.provider, c.providers).provider,
          models: nextModels,
        },
      };
      void enqueuePersistConfig(nextConfig, true);
      return nextConfig;
    });
  }

  async function handleRefreshModels(provider: string): Promise<void> {
    if (!config || !provider) return;
    const hasKey = (() => {
      if (provider === "ollama") return true;
      if (provider === "local") return (config.providers?.[provider]?.baseUrl ?? "").trim().length > 0;
      return (config.providers?.[provider]?.apiKey ?? "").trim().length > 0 || !!llmStatus?.providers?.[provider]?.configured;
    })();
    if (!hasKey) {
      setModelRefreshError(
        provider === "local"
          ? "Set a local base URL before refreshing models."
          : `Configure a valid ${provider} API key before refreshing models.`,
      );
      return;
    }
    setRefreshingProvider(provider);
    setModelRefreshError(null);
    try {
      const res = await fetch(`/api/llm/models?provider=${encodeURIComponent(provider)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to refresh models");
      const models = (Array.isArray(body.models) ? body.models : []).map((item: unknown) => String(item).trim()).filter(Boolean);
      if (models.length === 0) throw new Error("No models returned by provider");
      const sanitized = provider === "local"
        ? models.filter((m: string) => !looksLikeHostedOpenAiModel(m))
        : models;
      const fallbackLocalModel = getDefaultModelForProviderTier("local", "default", config.providers);
      setLiveModelOptions((prev) => ({
        ...prev,
        [provider]: provider === "local"
          ? (sanitized.length > 0 ? sanitized : [fallbackLocalModel])
          : sanitized,
      }));
    } catch (err) {
      setModelRefreshError((err as Error).message);
    } finally {
      setRefreshingProvider((current) => (current === provider ? null : current));
    }
  }

  function handleSetProviderKey(name: string, value: string) {
    setConfig((c) => c ? {
      ...c,
      providers: { ...c.providers, [name]: { ...c.providers[name], apiKey: value } },
    } : c);
  }

  function handleSetProviderConfigValue(name: string, key: "baseUrl" | "model", value: string) {
    setConfig((c) => c ? {
      ...c,
      providers: { ...c.providers, [name]: { ...c.providers[name], [key]: value } },
    } : c);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingDots size={28} />
      </div>
    );
  }

  if (!config) return <p className="text-sm text-zinc-500">Could not load config. {error}</p>;

  return (
    <div className="max-w-2xl space-y-8">
      {/* Scope banner */}
      <section className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${
            configScope === "project"
              ? "bg-zinc-800 border-zinc-700 text-zinc-300"
              : "bg-zinc-900 border-zinc-800 text-zinc-500"
          }`}>
            {configScope === "project" ? "Project settings" : "Global settings"}
          </span>
        </div>
        {projectRoot && (
          <span className="text-[11px] text-zinc-600 font-mono truncate ml-auto" title={projectRoot}>
            {projectRoot}
          </span>
        )}
      </section>

      <div className="h-px bg-zinc-800/60" />

      <GitHubSection />

      <div className="h-px bg-zinc-800" />

      <MCPSection config={config} setConfig={setConfig} />

      <div className="h-px bg-zinc-800" />

      <LLMSection
        config={config}
        setConfig={setConfig}
        llmStatus={llmStatus}
        liveModelOptions={liveModelOptions}
        refreshingProvider={refreshingProvider}
        modelRefreshError={modelRefreshError}
        onRefreshModels={handleRefreshModels}
        onSetProviderKey={handleSetProviderKey}
        onSetProviderConfigValue={handleSetProviderConfigValue}
        onSetTierProvider={handleSetTierProvider}
        onSetTierModel={handleSetTierModel}
      />

      <div className="h-px bg-zinc-800" />

      <ThemeSection
        themes={themes}
        activeThemeId={config.ui?.themeId ?? activeThemeId}
        loading={themeLoading}
        importing={themeImporting}
        scope={configScope}
        error={themeError}
        notice={themeNotice}
        onSelectTheme={handleSetTheme}
        onRefresh={refreshThemes}
        onImportVsCode={handleImportVsCodeTheme}
        onDeleteTheme={handleDeleteTheme}
      />

      <PreferencesSection config={config} setConfig={setConfig} />

      <div className="h-px bg-zinc-800" />

      <StorageSection runOperation={runOperation} />

      {/* Error */}
      {error && <p className="text-sm text-bender-danger/80">{error}</p>}

      {/* Save */}
      <div className="flex items-center gap-3 pb-8">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="px-4 py-2 bg-zinc-100 text-zinc-900 text-sm font-medium rounded-md hover:bg-white transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        {saved && <span className="text-sm text-bender-success">Saved</span>}
      </div>
    </div>
  );
}
