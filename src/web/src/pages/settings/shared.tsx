// Shared primitive components used across settings sections.

import { ChevronDown } from "lucide-react";
import { SecretInput } from "../../components/SecretInput";
import type { ModelTier, FullConfig, TierModelConfig } from "./types";
import { PROVIDER_MODEL_OPTIONS, PROVIDER_MODEL_HINTS } from "./types";

// ── Utility functions ─────────────────────────────────────────────────────────

const OPENAI_MODEL_NAME_PATTERN = /^(gpt-|chatgpt|o[1-9](?:-|$))/i;

export function looksLikeHostedOpenAiModel(model: string): boolean {
  const value = model.trim();
  if (!value) return false;
  return OPENAI_MODEL_NAME_PATTERN.test(value);
}

export function isTierModelConfig(value: unknown): value is TierModelConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TierModelConfig>;
  return typeof candidate.provider === "string" && typeof candidate.model === "string";
}

export function getDefaultModelForProviderTier(
  provider: string,
  tier: ModelTier,
  providers?: FullConfig["providers"],
): string {
  const providerDefault = providers?.[provider]?.model?.trim();
  if (providerDefault) return providerDefault;
  return PROVIDER_MODEL_HINTS[provider]?.[tier] ?? PROVIDER_MODEL_HINTS.anthropic[tier];
}

export function normalizeTierModelValue(
  value: string | TierModelConfig | undefined,
  tier: ModelTier,
  fallbackProvider: string,
  providers?: FullConfig["providers"],
): TierModelConfig {
  if (isTierModelConfig(value)) {
    const provider = value.provider.trim() || fallbackProvider;
    const model = value.model.trim() || getDefaultModelForProviderTier(provider, tier, providers);
    return { provider, model };
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return { provider: fallbackProvider, model: value.trim() };
  }
  return {
    provider: fallbackProvider,
    model: getDefaultModelForProviderTier(fallbackProvider, tier, providers),
  };
}

export function normalizeTierModels(
  models: FullConfig["llm"]["models"],
  fallbackProvider: string,
  providers?: FullConfig["providers"],
): Record<ModelTier, TierModelConfig> {
  return {
    fast: normalizeTierModelValue(models.fast, "fast", fallbackProvider, providers),
    default: normalizeTierModelValue(models.default, "default", fallbackProvider, providers),
    strong: normalizeTierModelValue(models.strong, "strong", fallbackProvider, providers),
  };
}

export function defaultGitHubRedirectUri(): string {
  if (typeof window === "undefined" || !window.location?.origin) {
    return "http://localhost:3142/api/github/auth/callback";
  }
  return `${window.location.origin}/api/github/auth/callback`;
}

// ── UI primitives ─────────────────────────────────────────────────────────────

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-start gap-4">
      <div className="pt-2">
        <span className="text-sm text-zinc-400">{label}</span>
        {hint && <span className="ml-2 text-zinc-600 text-xs">{hint}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, password, mono }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
  mono?: boolean;
}) {
  const baseClass = `w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 ${mono ? "font-mono" : ""}`;

  if (password) {
    return (
      <SecretInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        inputClassName={`${baseClass} pr-10`}
      />
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={baseClass}
    />
  );
}

export function ModelSelect({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const hasCurrent = value.trim().length > 0 && options.includes(value);
  const resolvedOptions = hasCurrent || !value.trim()
    ? options
    : [value, ...options];

  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors font-mono ${
          disabled ? "cursor-not-allowed" : ""
        }`}
      >
        {resolvedOptions.map((option) => (
          <option key={option} value={option} className="bg-zinc-900 text-zinc-200">
            {option}
            {option === value && !options.includes(value) ? " (custom)" : ""}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
        <ChevronDown className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}

export function SectionDivider() {
  return <div className="h-px bg-zinc-800" />;
}

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.1em] mb-1">{title}</h3>
      {description && <p className="text-xs text-zinc-600 mb-4">{description}</p>}
    </div>
  );
}

export function getModelOptions(
  provider: string,
  config: FullConfig,
  liveModelOptions: Record<string, string[]>,
): string[] {
  const live = liveModelOptions[provider];
  if (Array.isArray(live) && live.length > 0) {
    if (provider === "local") {
      const filtered = live.filter((model) => !looksLikeHostedOpenAiModel(model));
      if (filtered.length > 0) return filtered;
    } else {
      return live;
    }
  }
  if (provider === "local") {
    const persisted = Object.keys(config.providers["local"]?.modelCapabilities ?? {});
    const configuredDefault = (config.providers["local"]?.model ?? "").trim();
    const merged = [...new Set([...(configuredDefault ? [configuredDefault] : []), ...persisted])]
      .filter((model) => !looksLikeHostedOpenAiModel(model));
    if (merged.length > 0) return merged;
  }
  const configuredDefault = (config.providers[provider]?.model ?? "").trim();
  const seeded = configuredDefault ? [configuredDefault] : [];
  return [...new Set([...seeded, ...(PROVIDER_MODEL_OPTIONS[provider] ?? PROVIDER_MODEL_OPTIONS.anthropic)])];
}
