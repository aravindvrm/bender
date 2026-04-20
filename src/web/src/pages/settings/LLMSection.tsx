import { ChevronDown } from "lucide-react";
import { Field, TextInput, ModelSelect, SectionHeader, getModelOptions, looksLikeHostedOpenAiModel, getDefaultModelForProviderTier, normalizeTierModelValue } from "./shared";
import type { FullConfig, LlmStatus, ModelTier } from "./types";
import { PROVIDERS, MODEL_TIERS } from "./types";

interface LLMSectionProps {
  config: FullConfig;
  setConfig: React.Dispatch<React.SetStateAction<FullConfig | null>>;
  llmStatus: LlmStatus | null;
  liveModelOptions: Record<string, string[]>;
  refreshingProvider: string | null;
  modelRefreshError: string | null;
  onRefreshModels: (provider: string) => Promise<void>;
  onSetProviderKey: (name: string, value: string) => void;
  onSetProviderConfigValue: (name: string, key: "baseUrl" | "model", value: string) => void;
  onSetTierProvider: (tier: ModelTier, provider: string) => void;
  onSetTierModel: (tier: ModelTier, model: string) => void;
}

export function LLMSection({
  config,
  llmStatus,
  liveModelOptions,
  refreshingProvider,
  modelRefreshError,
  onRefreshModels,
  onSetProviderKey,
  onSetProviderConfigValue,
  onSetTierProvider,
  onSetTierModel,
}: LLMSectionProps) {
  function providerHasConfiguredKey(provider: string): boolean {
    if (provider === "ollama") return true;
    if (provider === "openai-compatible") {
      const baseUrl = (config.providers?.[provider]?.baseUrl ?? "").trim();
      return baseUrl.length > 0;
    }
    const explicit = (config.providers?.[provider]?.apiKey ?? "").trim();
    if (explicit.length > 0) return true;
    const legacy = config.llm.provider === provider
      ? (config.llm.apiKey ?? "").trim().length > 0
      : false;
    if (legacy) return true;
    return !!llmStatus?.providers?.[provider]?.configured;
  }

  function resolveTierModelConfig(tier: ModelTier) {
    return normalizeTierModelValue(config.llm.models[tier], tier, config.llm.provider, config.providers);
  }

  const configuredProviders = PROVIDERS.filter((provider) => providerHasConfiguredKey(provider));

  return (
    <>
      {/* Per-provider API keys */}
      <section>
        <SectionHeader
          title="API Keys"
          description="Configure provider credentials/endpoints first. Provider dropdowns only list configured providers."
        />
        <div className="space-y-3">
          {PROVIDERS.filter((p) => p !== "ollama" && p !== "openai-compatible").map((p) => (
            <Field key={p} label={p}>
              <TextInput
                value={config.providers[p]?.apiKey ?? ""}
                onChange={(v) => onSetProviderKey(p, v)}
                placeholder={`${p.toUpperCase()}_API_KEY or blank`}
                password
                mono
              />
            </Field>
          ))}
          <Field label="openai-compatible">
            <div className="space-y-2">
              <TextInput
                value={config.providers["openai-compatible"]?.apiKey ?? ""}
                onChange={(v) => onSetProviderKey("openai-compatible", v)}
                placeholder="Optional bearer token"
                password
                mono
              />
              <TextInput
                value={config.providers["openai-compatible"]?.baseUrl ?? ""}
                onChange={(v) => onSetProviderConfigValue("openai-compatible", "baseUrl", v)}
                placeholder="http://localhost:1234/v1"
                mono
              />
              <p className="text-[11px] text-zinc-500">
                Use an OpenAI-compatible endpoint. Model capabilities are handled internally.
              </p>
            </div>
          </Field>
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Provider selection + model tiers */}
      <section>
        <SectionHeader title="LLM Provider & Models" />
        <div className="space-y-4">
          {modelRefreshError && (
            <p className="text-xs text-red-400">{modelRefreshError}</p>
          )}
          {MODEL_TIERS.map((tier) => (
            <Field key={tier} label={tier} hint={tier === "fast" ? "clarify" : tier === "default" ? "plan/review" : "architect/code"}>
              <div className="space-y-2">
                {(() => {
                  const tierConfig = resolveTierModelConfig(tier);
                  const providerOptions = configuredProviders as string[];
                  const providerInOptions = providerOptions.includes(tierConfig.provider);
                  const selectedProvider = providerInOptions ? tierConfig.provider : "";
                  const providerReady = selectedProvider ? providerHasConfiguredKey(selectedProvider) : false;
                  const modelOptions = selectedProvider ? getModelOptions(selectedProvider, config, liveModelOptions) : [];
                  return (
                    <div className="grid grid-cols-[160px_1fr_auto] gap-2 items-end">
                      <div className="space-y-1">
                        <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Provider</p>
                        <div className="relative">
                          <select
                            value={selectedProvider}
                            onChange={(e) => onSetTierProvider(tier, e.target.value)}
                            className="select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors"
                          >
                            {!providerInOptions && (
                              <option value="">Configure provider</option>
                            )}
                            {providerOptions.map((provider) => (
                              <option key={provider} value={provider} className="bg-zinc-900 text-zinc-200">
                                {provider}
                                {provider === "openai-compatible" ? " (experimental)" : ""}
                              </option>
                            ))}
                          </select>
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
                            <ChevronDown className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Model</p>
                        <ModelSelect
                          value={tierConfig.model}
                          options={modelOptions}
                          onChange={(v) => onSetTierModel(tier, v)}
                          disabled={!tierConfig.provider || !providerReady}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void onRefreshModels(selectedProvider)}
                        disabled={!selectedProvider || !providerReady || refreshingProvider === selectedProvider}
                        className="px-2.5 py-2 rounded-md text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                      >
                        {refreshingProvider === selectedProvider ? "Refreshing..." : "Refresh models"}
                      </button>
                    </div>
                  );
                })()}
                {configuredProviders.length === 0 && (
                  <p className="text-[11px] text-zinc-600">
                    Add at least one API key (or a local base URL) to enable provider selection.
                  </p>
                )}
                {(() => {
                  const tierConfig = resolveTierModelConfig(tier);
                  if (!tierConfig.provider || providerHasConfiguredKey(tierConfig.provider)) return null;
                  return (
                    <p className="text-[11px] text-amber-400">
                      {tierConfig.provider === "openai-compatible"
                        ? "Set an openai-compatible base URL to enable this tier."
                        : `Add a valid ${tierConfig.provider} API key (or env var) to enable this tier.`}
                    </p>
                  );
                })()}
              </div>
            </Field>
          ))}
        </div>
      </section>
    </>
  );
}

// Re-export helpers used by SettingsView to compute tier changes
export { getDefaultModelForProviderTier, looksLikeHostedOpenAiModel };
