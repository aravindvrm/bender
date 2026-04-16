import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { LoadingDots } from "../components/LoadingDots";
import { SecretInput } from "../components/SecretInput";

type ConfigScope = "global" | "project";
type ModelTier = "fast" | "default" | "strong";

interface TierModelConfig {
  provider: string;
  model: string;
}

const MODEL_TIERS: ModelTier[] = ["fast", "default", "strong"];

interface FullConfig {
  llm: {
    provider: string;
    apiKey?: string;
    models: {
      fast: string | TierModelConfig;
      default: string | TierModelConfig;
      strong: string | TierModelConfig;
    };
  };
  providers: {
    [name: string]: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      supportsTools?: boolean;
      supportsJson?: boolean;
      supportsStreaming?: boolean;
      modelCapabilities?: Record<string, OpenAiCompatibleModelCapabilities>;
    };
  };
  mcp?: {
    enabled?: boolean;
    servers?: Array<{
      id?: string;
      name: string;
      url: string;
      enabled?: boolean;
      description?: string;
      authorizationToken?: string;
    }>;
  };
  skills?: {
    enabled?: boolean;
    enabledSkills?: string[];
    paths?: string[];
    maxChars?: number;
  };
  stack: { template: string; framework: string; database: string; orm: string; auth: string; styling: string; language: string };
  deploy: { target?: string };
  test: { command?: string };
  reanalyze?: { enabled?: boolean; threshold?: number };
  logging?: { enabled?: boolean; level?: "debug" | "info" | "warn" | "error"; consoleLevel?: "none" | "debug" | "info" | "warn" | "error" };
}

interface ConfigResponse extends FullConfig {
  scope?: ConfigScope;
  projectRoot?: string | null;
}

interface LlmStatus {
  hasAnyKey: boolean;
  activeProvider: string;
  providers: Record<string, { configured: boolean }>;
}

interface OpenAiCompatibleModelCapabilities {
  supportsTools: boolean;
  supportsJson: boolean;
  supportsStreaming: boolean;
  endpoint?: string;
  apiStyle?: "chat" | "responses" | "auto";
  errors?: string[];
}

interface GitHubAuthStatus {
  configured: boolean;
  connected: boolean;
  login?: string;
  message?: string;
  authMode?: string;
}

interface GitHubAuthConfig {
  clientId: string;
  clientSecretSet: boolean;
  redirectUri: string;
  usingEnvClientId: boolean;
  usingEnvClientSecret: boolean;
  storedClientId: string;
}

interface GitHubDeviceFlowStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}

interface GitHubDeviceFlowPoll {
  status: "pending" | "connected" | "expired" | "denied";
  intervalSec?: number;
  login?: string;
}

const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama", "openai-compatible"] as const;

// ── MCP curated server definitions ────────────────────────────────────────────

interface CuratedMcpServer {
  id: string;
  name: string;
  url: string;
  description: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  docsUrl: string;
}

const CURATED_MCP_SERVERS: CuratedMcpServer[] = [
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    description: "Repository management, file operations, pull requests, and issues.",
    tokenLabel: "GitHub Personal Access Token",
    tokenPlaceholder: "ghp_...",
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "figma",
    name: "Figma",
    url: "https://mcp.figma.com/mcp",
    description: "Access Figma designs, generate code from components, and read design tokens.",
    tokenLabel: "Figma API Key",
    tokenPlaceholder: "figd_...",
    docsUrl: "https://help.figma.com/hc/en-us/articles/32132100833559",
  },
  {
    id: "neon",
    name: "Neon (Postgres)",
    url: "https://mcp.neon.tech/mcp",
    description: "Query and manage Neon Postgres databases, inspect schemas, run migrations.",
    tokenLabel: "Neon API Key",
    tokenPlaceholder: "neon_...",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://mcp.vercel.com",
    description: "Deploy projects, manage environments, inspect deployment logs.",
    tokenLabel: "Vercel API Token",
    tokenPlaceholder: "vercel_token_...",
    docsUrl: "https://vercel.com/docs/mcp",
  },
];

// ── Skills registry types ─────────────────────────────────────────────────────

interface SkillMeta {
  name: string;
  description: string;
  size: number;
}

interface ConnectorStatus {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  authValid: boolean;
  discoveredCapabilities: string[];
  lastCheckedAt: string;
  error?: string;
}

const PROVIDER_MODEL_HINTS: Record<string, { fast: string; default: string; strong: string }> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", default: "claude-sonnet-4-6-20250514", strong: "claude-opus-4-6-20250514" },
  openai: { fast: "gpt-5.4-mini", default: "gpt-5.4", strong: "gpt-5.4" },
  google: { fast: "gemini-2.0-flash", default: "gemini-2.5-pro", strong: "gemini-2.5-pro" },
  groq: { fast: "llama-3.3-70b-versatile", default: "llama-3.3-70b-versatile", strong: "llama-3.3-70b-versatile" },
  ollama: { fast: "llama3.2", default: "llama3.1:70b", strong: "llama3.1:70b" },
  "openai-compatible": { fast: "local-model", default: "local-model", strong: "local-model" },
};

const PROVIDER_MODEL_OPTIONS: Record<string, string[]> = {
  anthropic: [
    "claude-opus-4-6-20250514",
    "claude-sonnet-4-6-20250514",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-2.0-flash",
  ],
  groq: [
    "llama-3.3-70b-versatile",
  ],
  ollama: [
    "llama3.1:70b",
    "llama3.2",
  ],
  "openai-compatible": [
    "local-model",
  ],
};

const OPENAI_MODEL_NAME_PATTERN = /^(gpt-|chatgpt|o[1-9](?:-|$))/i;

function looksLikeHostedOpenAiModel(model: string): boolean {
  const value = model.trim();
  if (!value) return false;
  return OPENAI_MODEL_NAME_PATTERN.test(value);
}

function isTierModelConfig(value: unknown): value is TierModelConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TierModelConfig>;
  return typeof candidate.provider === "string" && typeof candidate.model === "string";
}

function getDefaultModelForProviderTier(
  provider: string,
  tier: ModelTier,
  providers?: FullConfig["providers"],
): string {
  const providerDefault = providers?.[provider]?.model?.trim();
  if (providerDefault) return providerDefault;
  return PROVIDER_MODEL_HINTS[provider]?.[tier] ?? PROVIDER_MODEL_HINTS.anthropic[tier];
}

function normalizeTierModelValue(
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

function normalizeTierModels(
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

function TextInput({ value, onChange, placeholder, password, mono }: {
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

function ModelSelect({
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
          disabled
            ? "cursor-not-allowed"
            : ""
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

function defaultGitHubRedirectUri(): string {
  if (typeof window === "undefined" || !window.location?.origin) {
    return "http://localhost:3142/api/github/auth/callback";
  }
  return `${window.location.origin}/api/github/auth/callback`;
}

export function SettingsView() {
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [configScope, setConfigScope] = useState<ConfigScope>("global");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [liveModelOptions, setLiveModelOptions] = useState<Record<string, string[]>>({});
  const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string>("");
  const [githubStatus, setGithubStatus] = useState<GitHubAuthStatus | null>(null);
  const [githubConfig, setGithubConfig] = useState<GitHubAuthConfig | null>(null);
  const [githubClientIdInput, setGithubClientIdInput] = useState("");
  const [githubClientSecretInput, setGithubClientSecretInput] = useState("");
  const [githubRedirectUriInput, setGithubRedirectUriInput] = useState(defaultGitHubRedirectUri());
  const [githubDeviceFlow, setGithubDeviceFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const githubPollTimerRef = useRef<number | null>(null);
  const [skillsRegistry, setSkillsRegistry] = useState<SkillMeta[]>([]);
  const [skillsRegistryAge, setSkillsRegistryAge] = useState<number | null>(null);
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [skillsRefreshError, setSkillsRefreshError] = useState<string | null>(null);
  const [skillsSearch, setSkillsSearch] = useState("");
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [connectorExpanded, setConnectorExpanded] = useState<Record<string, boolean>>({});

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
          if (entry.provider === "openai-compatible" && looksLikeHostedOpenAiModel(entry.model)) {
            normalizedModels[tier] = {
              ...entry,
              model: getDefaultModelForProviderTier("openai-compatible", tier, providers),
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
      .catch((err) => { setError(err.message); setLoading(false); });

    // Load state for project root
    fetch("/api/state")
      .then((r) => r.json())
      .then((data) => { if (data.projectRoot) setProjectRoot(data.projectRoot); })
      .catch(() => {});

    // Load key-status signal
    fetch("/api/llm/status")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Failed to load LLM status");
        return data as LlmStatus;
      })
      .then(setLlmStatus)
      .catch(() => {});

    void refreshGitHub();
    void loadSkillsRegistry();
    void loadConnectorStatuses();

    return () => {
      if (githubPollTimerRef.current !== null) {
        window.clearTimeout(githubPollTimerRef.current);
        githubPollTimerRef.current = null;
      }
    };
  }, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await persistConfig(config, false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function resolveTierModelConfig(tier: ModelTier, source: FullConfig): TierModelConfig {
    return normalizeTierModelValue(source.llm.models[tier], tier, source.llm.provider, source.providers);
  }

  function setTierProvider(tier: ModelTier, provider: string) {
    if (!provider) return;
    setConfig((c) => {
      if (!c) return c;
      const options = getModelOptions(provider, c);
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
      void persistConfig(nextConfig, true);
      return nextConfig;
    });
  }

  function setTierModel(tier: ModelTier, value: string) {
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
      void persistConfig(nextConfig, true);
      return nextConfig;
    });
  }

  function getModelOptions(provider: string, source = config): string[] {
    if (!source) return PROVIDER_MODEL_OPTIONS[provider] ?? PROVIDER_MODEL_OPTIONS.anthropic;
    const live = liveModelOptions[provider];
    if (Array.isArray(live) && live.length > 0) {
      if (provider === "openai-compatible") {
        const filtered = live.filter((model) => !looksLikeHostedOpenAiModel(model));
        if (filtered.length > 0) return filtered;
      } else {
        return live;
      }
    }
    if (provider === "openai-compatible" && source) {
      const persisted = Object.keys(source.providers["openai-compatible"]?.modelCapabilities ?? {});
      const configuredDefault = (source.providers["openai-compatible"]?.model ?? "").trim();
      const merged = [...new Set([...(configuredDefault ? [configuredDefault] : []), ...persisted])]
        .filter((model) => !looksLikeHostedOpenAiModel(model));
      if (merged.length > 0) return merged;
    }
    const configuredDefault = (source.providers[provider]?.model ?? "").trim();
    const seeded = configuredDefault ? [configuredDefault] : [];
    return [...new Set([...seeded, ...(PROVIDER_MODEL_OPTIONS[provider] ?? PROVIDER_MODEL_OPTIONS.anthropic)])];
  }

  async function refreshModels(provider: string): Promise<void> {
    if (!config || !provider) return;
    if (!providerHasConfiguredKey(provider)) {
      setModelRefreshError(
        provider === "openai-compatible"
          ? "Set an openai-compatible base URL before refreshing models."
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
      const models = (Array.isArray(body.models) ? body.models : []).map((item) => String(item).trim()).filter(Boolean);
      if (models.length === 0) throw new Error("No models returned by provider");
      const sanitized = provider === "openai-compatible"
        ? models.filter((model) => !looksLikeHostedOpenAiModel(model))
        : models;
      const fallbackLocalModel = getDefaultModelForProviderTier("openai-compatible", "default", config.providers);
      setLiveModelOptions((prev) => ({
        ...prev,
        [provider]: provider === "openai-compatible"
          ? (sanitized.length > 0 ? sanitized : [fallbackLocalModel])
          : sanitized,
      }));
    } catch (err) {
      setModelRefreshError((err as Error).message);
    } finally {
      setRefreshingProvider((current) => (current === provider ? null : current));
    }
  }

  function providerHasConfiguredKey(provider: string): boolean {
    if (!config) return false;
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

  function setProviderKey(name: string, value: string) {
    setConfig((c) => c ? {
      ...c,
      providers: { ...c.providers, [name]: { ...c.providers[name], apiKey: value } },
    } : c);
  }

  function setProviderConfigValue(
    name: string,
    key: "baseUrl" | "model",
    value: string,
  ) {
    setConfig((c) => c ? {
      ...c,
      providers: {
        ...c.providers,
        [name]: {
          ...c.providers[name],
          [key]: value,
        },
      },
    } : c);
  }

  function clearGitHubAuthPolling() {
    if (githubPollTimerRef.current !== null) {
      window.clearTimeout(githubPollTimerRef.current);
      githubPollTimerRef.current = null;
    }
  }

  async function refreshGitHub() {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch("/api/github/auth/config"),
        fetch("/api/github/auth/status"),
      ]);
      const cfgBody = await cfgRes.json();
      const statusBody = await statusRes.json();

      if (!cfgRes.ok) throw new Error(cfgBody.error ?? "Failed to load GitHub auth config");
      if (!statusRes.ok) throw new Error(statusBody.error ?? "Failed to load GitHub auth status");

      const cfg = cfgBody as GitHubAuthConfig;
      setGithubConfig(cfg);
      setGithubClientIdInput(cfg.storedClientId || cfg.clientId || "");
      setGithubRedirectUriInput(cfg.redirectUri || defaultGitHubRedirectUri());
      setGithubStatus(statusBody as GitHubAuthStatus);
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setGithubLoading(false);
    }
  }

  function startGitHubDevicePolling(sessionId: string, intervalSec: number) {
    clearGitHubAuthPolling();
    const tick = async () => {
      try {
        const res = await fetch("/api/github/device/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to poll GitHub authorization");
        const poll = body as GitHubDeviceFlowPoll;

        if (poll.status === "connected") {
          setGithubNotice(poll.login ? `Connected as @${poll.login}` : "GitHub connected.");
          setGithubDeviceFlow(null);
          clearGitHubAuthPolling();
          await refreshGitHub();
          return;
        }
        if (poll.status === "pending") {
          const nextSec = Math.max(1, poll.intervalSec ?? intervalSec);
          githubPollTimerRef.current = window.setTimeout(() => void tick(), nextSec * 1000);
          return;
        }
        setGithubNotice(poll.status === "denied" ? "GitHub authorization was denied." : "GitHub device code expired. Start again.");
        setGithubDeviceFlow(null);
        clearGitHubAuthPolling();
      } catch (err) {
        setGithubError((err as Error).message);
        setGithubDeviceFlow(null);
        clearGitHubAuthPolling();
      }
    };
    githubPollTimerRef.current = window.setTimeout(() => void tick(), Math.max(1, intervalSec) * 1000);
  }

  async function handleSaveGitHubConfig() {
    setGithubSaving(true);
    setGithubError(null);
    setGithubNotice(null);
    try {
      const payload: { clientId: string; redirectUri: string; clientSecret?: string } = {
        clientId: githubClientIdInput.trim(),
        redirectUri: githubRedirectUriInput.trim(),
      };
      if (githubClientSecretInput.trim()) {
        payload.clientSecret = githubClientSecretInput.trim();
      }

      const res = await fetch("/api/github/auth/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to save GitHub auth config");

      setGithubClientSecretInput("");
      await refreshGitHub();
      setGithubNotice("GitHub settings saved.");
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setGithubSaving(false);
    }
  }

  async function handleConnectGitHub() {
    setGithubError(null);
    setGithubNotice("Waiting for GitHub authorization...");
    try {
      const res = await fetch("/api/github/device/start", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start GitHub device flow");
      const flow = body as GitHubDeviceFlowStart;
      setGithubDeviceFlow(flow);
      window.open(flow.verificationUriComplete || flow.verificationUri, "_blank", "noopener,noreferrer");
      startGitHubDevicePolling(flow.sessionId, flow.intervalSec);
    } catch (err) {
      setGithubError((err as Error).message);
      setGithubNotice(null);
    }
  }

  async function handleDisconnectGitHub() {
    setGithubError(null);
    setGithubNotice(null);
    clearGitHubAuthPolling();
    try {
      const res = await fetch("/api/github/auth/disconnect", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to disconnect GitHub");
      setGithubDeviceFlow(null);
      await refreshGitHub();
      setGithubNotice("Disconnected GitHub session.");
    } catch (err) {
      setGithubError((err as Error).message);
    }
  }

  async function loadSkillsRegistry() {
    try {
      const res = await fetch("/api/skills/registry");
      const data = await res.json();
      if (data.skills) {
        setSkillsRegistry(data.skills);
        setSkillsRegistryAge(data.fetchedAt ?? null);
      }
    } catch { /* silent */ }
  }

  async function refreshSkillsRegistry() {
    setSkillsRefreshing(true);
    setSkillsRefreshError(null);
    try {
      const res = await fetch("/api/skills/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      setSkillsRegistry(data.skills);
      setSkillsRegistryAge(data.fetchedAt ?? null);
    } catch (err) {
      setSkillsRefreshError((err as Error).message);
    } finally {
      setSkillsRefreshing(false);
    }
  }

  async function loadConnectorStatuses(force = false) {
    setConnectorsLoading(true);
    setConnectorsError(null);
    try {
      const q = force ? "?force=true" : "";
      const res = await fetch(`/api/connectors/status${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load connector status");
      const byId: Record<string, ConnectorStatus> = {};
      for (const status of (data.statuses ?? []) as ConnectorStatus[]) {
        byId[status.id] = status;
      }
      setConnectorStatuses(byId);
    } catch (err) {
      setConnectorsError((err as Error).message);
    } finally {
      setConnectorsLoading(false);
    }
  }

  function toggleSkill(name: string, enabled: boolean) {
    setConfig((c) => {
      if (!c) return c;
      const current = c.skills?.enabledSkills ?? [];
      const next = enabled ? [...current, name] : current.filter((n) => n !== name);
      return { ...c, skills: { ...c.skills, enabledSkills: next } };
    });
  }

  function getMcpServerEntry(id: string) {
    return (config?.mcp?.servers ?? []).find((s) => s.id === id);
  }

  function setMcpServerEnabled(id: string, def: CuratedMcpServer, enabled: boolean) {
    setConfig((c) => {
      if (!c) return c;
      const servers = [...(c.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => s.id === id);
      if (idx >= 0) {
        servers[idx] = { ...servers[idx], enabled };
      } else {
        servers.push({ id, name: def.name, url: def.url, description: def.description, enabled, authorizationToken: "" });
      }
      return { ...c, mcp: { ...c.mcp, servers } };
    });
  }

  function setMcpServerToken(id: string, def: CuratedMcpServer, token: string) {
    setConfig((c) => {
      if (!c) return c;
      const servers = [...(c.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => s.id === id);
      if (idx >= 0) {
        servers[idx] = { ...servers[idx], authorizationToken: token };
      } else {
        servers.push({ id, name: def.name, url: def.url, description: def.description, enabled: false, authorizationToken: token });
      }
      return { ...c, mcp: { ...c.mcp, servers } };
    });
  }

  function toggleConnectorExpanded(id: string) {
    setConnectorExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function addMcpServer() {
    setConfig((c) => c
      ? {
          ...c,
          mcp: {
            enabled: c.mcp?.enabled ?? true,
            servers: [
              ...(c.mcp?.servers ?? []),
              { name: "", url: "", enabled: true, description: "", authorizationToken: "", allowedTools: [] },
            ],
          },
        }
      : c);
  }

  function removeMcpServer(index: number) {
    setConfig((c) => c
      ? { ...c, mcp: { ...c.mcp, servers: (c.mcp?.servers ?? []).filter((_, i) => i !== index) } }
      : c);
  }

  function updateMcpServer(index: number, patch: Partial<NonNullable<NonNullable<FullConfig["mcp"]>["servers"]>[number]>) {
    setConfig((c) => {
      if (!c) return c;
      const servers = [...(c.mcp?.servers ?? [])];
      servers[index] = { ...servers[index], ...patch };
      return { ...c, mcp: { ...c.mcp, servers } };
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingDots size={28} />
      </div>
    );
  }

  if (!config) return <p className="text-sm text-zinc-500">Could not load config. {error}</p>;

  const configuredProviders = PROVIDERS.filter((provider) => providerHasConfiguredKey(provider));
  const getProviderOptionsForTier = (_tier: ModelTier): string[] => configuredProviders;
  const githubConnected = !!githubStatus?.connected;
  const githubConfigured = !!githubStatus?.configured;
  const githubClientIdLocked = !!githubConfig?.usingEnvClientId;
  const githubClientSecretLocked = !!githubConfig?.usingEnvClientSecret;

  return (
    <div className="max-w-2xl space-y-8">
      <section>
        <div className="flex items-center gap-3 px-3 py-2 bg-zinc-900 rounded-md">
          <span className="text-xs text-zinc-500">Scope</span>
          <span className="text-xs text-zinc-300 ml-auto">{configScope === "global" ? "Global settings" : "Project settings"}</span>
        </div>
        {projectRoot && (
          <div className="flex items-center gap-3 px-3 py-2 bg-zinc-900 rounded-md mt-2">
            <span className="text-xs text-zinc-500">Project</span>
            <span className="text-xs text-zinc-300 font-mono ml-auto">{projectRoot}</span>
          </div>
        )}
      </section>

      <div className="h-px bg-zinc-800" />

      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">GitHub</h3>
        <p className="text-xs text-zinc-600 mb-4">
          Machine-level GitHub auth config used by project picker and Git workflows.
        </p>

        <Field label="Connection">
          <div className="space-y-2">
            <p className={`text-xs ${githubConnected ? "text-emerald-400" : "text-zinc-500"}`}>
              {githubConnected ? `Connected${githubStatus?.login ? ` as @${githubStatus.login}` : ""}` : "Not connected"}
            </p>
            {!githubConfigured && (
              <p className="text-xs text-amber-400">
                {githubStatus?.message ?? "Set a GitHub App Client ID to enable device login."}
              </p>
            )}
            {githubDeviceFlow && (
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 space-y-1">
                <p className="text-[11px] text-zinc-500">Device code</p>
                <p className="text-sm text-zinc-200 font-mono">{githubDeviceFlow.userCode}</p>
              </div>
            )}
            <div className="flex gap-2">
              {!githubConnected ? (
                <button
                  onClick={() => void handleConnectGitHub()}
                  disabled={githubLoading || !githubConfigured}
                  className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Connect GitHub
                </button>
              ) : (
                <button
                  onClick={() => void handleDisconnectGitHub()}
                  disabled={githubLoading}
                  className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Disconnect
                </button>
              )}
              <button
                onClick={() => void refreshGitHub()}
                disabled={githubLoading}
                className="px-3 py-1.5 rounded-md text-xs border border-zinc-800 text-zinc-400 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Refresh
              </button>
            </div>
          </div>
        </Field>

        <Field label="Client ID">
          <TextInput
            value={githubClientIdInput}
            onChange={setGithubClientIdInput}
            placeholder="GitHub App Client ID"
            mono
          />
          {githubClientIdLocked && <p className="text-[11px] text-zinc-500 mt-1">Using environment value.</p>}
        </Field>

        <Field label="Client Secret">
          <TextInput
            value={githubClientSecretInput}
            onChange={setGithubClientSecretInput}
            placeholder={githubConfig?.clientSecretSet ? "Stored (leave blank to keep unchanged)" : "Optional for OAuth callback flow"}
            password
            mono
          />
          {githubClientSecretLocked && <p className="text-[11px] text-zinc-500 mt-1">Using environment value.</p>}
        </Field>

        <Field label="Redirect URI">
          <TextInput
            value={githubRedirectUriInput}
            onChange={setGithubRedirectUriInput}
            placeholder={defaultGitHubRedirectUri()}
            mono
          />
        </Field>

        {(githubError || githubNotice) && (
          <p className={`text-xs mt-3 ${githubError ? "text-red-400" : "text-zinc-500"}`}>
            {githubError ?? githubNotice}
          </p>
        )}

        <div className="mt-4">
          <button
            onClick={() => void handleSaveGitHubConfig()}
            disabled={githubSaving}
            className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {githubSaving ? "Saving..." : "Save GitHub settings"}
          </button>
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">MCP Connectors</h3>
        <p className="text-xs text-zinc-600 mb-3">
          Configure curated connectors and review runtime health/capabilities in one place.
        </p>
        <div className="space-y-2">
          {CURATED_MCP_SERVERS.map((connector) => {
            const status = connectorStatuses[connector.id];
            const entry = getMcpServerEntry(connector.id);
            const expanded = !!connectorExpanded[connector.id];
            return (
              <div key={connector.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-3 space-y-2">
                <button
                  type="button"
                  onClick={() => toggleConnectorExpanded(connector.id)}
                  className="w-full flex items-center gap-2 text-left"
                >
                  <span className="text-sm text-zinc-300">{connector.name}</span>
                  <span className="text-[10px] text-zinc-500 font-mono">{connector.url}</span>
                  <span className="ml-auto text-[10px] text-zinc-600">
                    {status?.lastCheckedAt ? `checked ${new Date(status.lastCheckedAt).toLocaleTimeString()}` : "not checked"}
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className={`px-1.5 py-0.5 rounded border ${status?.enabled ? "text-emerald-300 border-emerald-800/60" : "text-zinc-500 border-zinc-700"}`}>
                    {status?.enabled ? "enabled" : "disabled"}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded border ${status?.configured ? "text-zinc-300 border-zinc-700" : "text-zinc-500 border-zinc-700"}`}>
                    {status?.configured ? "configured" : "no token"}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded border ${status?.reachable ? "text-emerald-300 border-emerald-800/60" : "text-amber-300 border-amber-800/60"}`}>
                    {status?.reachable ? "reachable" : "unreachable"}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded border ${status?.authValid ? "text-emerald-300 border-emerald-800/60" : "text-amber-300 border-amber-800/60"}`}>
                    {status?.authValid ? "auth valid" : "auth unknown/invalid"}
                  </span>
                </div>
                {expanded && (
                  <div className="space-y-2 pt-1 border-t border-zinc-800">
                    <p className="text-xs text-zinc-600">{connector.description}</p>
                    <label className="flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={entry?.enabled ?? false}
                        onChange={(e) => setMcpServerEnabled(connector.id, connector, e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-zinc-100 focus:ring-zinc-500"
                      />
                      <span>Enable connector</span>
                    </label>
                    <TextInput
                      value={entry?.authorizationToken ?? ""}
                      onChange={(v) => setMcpServerToken(connector.id, connector, v)}
                      placeholder={connector.tokenPlaceholder}
                      password
                      mono
                    />
                    <p className="text-[11px] text-zinc-500">
                      {connector.tokenLabel}
                      {" · "}
                      <a
                        href={connector.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-2"
                      >
                        docs
                      </a>
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      {(status?.discoveredCapabilities ?? []).join(", ") || "No capabilities discovered"}
                    </p>
                    {status?.error && (
                      <p className="text-[11px] text-amber-400">{status.error}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => void loadConnectorStatuses(true)}
              disabled={connectorsLoading}
              className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {connectorsLoading ? "Refreshing..." : "Refresh connector checks"}
            </button>
            {connectorsError && <span className="text-xs text-red-400">{connectorsError}</span>}
          </div>
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Per-provider API keys */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">API Keys</h3>
        <p className="text-xs text-zinc-600 mb-4">
          Configure provider credentials/endpoints first. Provider dropdowns only list configured providers.
        </p>
        <div className="space-y-3">
          {PROVIDERS.filter((p) => p !== "ollama" && p !== "openai-compatible").map((p) => (
            <Field key={p} label={p}>
              <TextInput
                value={config.providers[p]?.apiKey ?? ""}
                onChange={(v) => setProviderKey(p, v)}
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
                onChange={(v) => setProviderKey("openai-compatible", v)}
                placeholder="Optional bearer token"
                password
                mono
              />
              <TextInput
                value={config.providers["openai-compatible"]?.baseUrl ?? ""}
                onChange={(v) => setProviderConfigValue("openai-compatible", "baseUrl", v)}
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
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">LLM Provider & Models</h3>
        <div className="space-y-4">
          {modelRefreshError && (
            <p className="text-xs text-red-400">{modelRefreshError}</p>
          )}
          {MODEL_TIERS.map((tier) => (
            <Field key={tier} label={tier} hint={tier === "fast" ? "clarify" : tier === "default" ? "plan/review" : "architect/code"}>
              <div className="space-y-2">
                {(() => {
                  const tierConfig = resolveTierModelConfig(tier, config);
                  const providerOptions = getProviderOptionsForTier(tier);
                  const providerInOptions = providerOptions.includes(tierConfig.provider);
                  const selectedProvider = providerInOptions ? tierConfig.provider : "";
                  const providerReady = selectedProvider ? providerHasConfiguredKey(selectedProvider) : false;
                  const modelOptions = selectedProvider ? getModelOptions(selectedProvider) : [];
                  return (
                    <div className="grid grid-cols-[160px_1fr_auto] gap-2 items-end">
                      <div className="space-y-1">
                        <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Provider</p>
                        <div className="relative">
                          <select
                            value={selectedProvider}
                            onChange={(e) => setTierProvider(tier, e.target.value)}
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
                          onChange={(v) => setTierModel(tier, v)}
                          disabled={!tierConfig.provider || !providerReady}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshModels(selectedProvider)}
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
                  const tierConfig = resolveTierModelConfig(tier, config);
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

      <div className="h-px bg-zinc-800" />

      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">Agents</h3>
        <p className="text-xs text-zinc-600">
          Configure role defaults, pinned skills, and capability policy in the <span className="text-zinc-400">Agents</span> tab.
        </p>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Test command */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">Test Command</h3>
        <Field label="Override">
          <TextInput
            value={config.test?.command ?? ""}
            onChange={(v) => setConfig((c) => c ? { ...c, test: { command: v || undefined } } : c)}
            placeholder="Auto-detected (e.g. npm test)"
            mono
          />
        </Field>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Auto re-analyze */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">Auto Re-analyze</h3>
        <p className="text-xs text-zinc-500 mb-4">Automatically re-run the architecture analyzer after a series of major task completions (schema, auth, API changes).</p>
        <div className="space-y-3">
          <Field label="Enabled">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="reanalyze-enabled"
                checked={config.reanalyze?.enabled ?? true}
                onChange={(e) => setConfig((c) => c ? { ...c, reanalyze: { ...c.reanalyze, enabled: e.target.checked } } : c)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-zinc-100 focus:ring-zinc-500"
              />
              <label htmlFor="reanalyze-enabled" className="text-sm text-zinc-400 cursor-pointer">
                Re-analyze after major tasks
              </label>
            </div>
          </Field>
          <Field label="Threshold">
            <input
              type="number"
              min={1}
              max={10}
              value={config.reanalyze?.threshold ?? 3}
              onChange={(e) => setConfig((c) => c ? { ...c, reanalyze: { ...c.reanalyze, threshold: parseInt(e.target.value, 10) || 3 } } : c)}
              className="w-24 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
            />
            <span className="text-xs text-zinc-500 ml-2">major tasks between analyses</span>
          </Field>
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Logging */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">Logging</h3>
        <p className="text-xs text-zinc-500 mb-4">
          Configure structured logs and console mirroring. Token usage metrics are always recorded for session counters.
        </p>
        <div className="space-y-3">
          <Field label="Enabled">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="logging-enabled"
                checked={config.logging?.enabled ?? true}
                onChange={(e) => setConfig((c) => c ? { ...c, logging: { ...c.logging, enabled: e.target.checked } } : c)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-zinc-100 focus:ring-zinc-500"
              />
              <label htmlFor="logging-enabled" className="text-sm text-zinc-400 cursor-pointer">
                Write structured logs to <span className="font-mono text-zinc-500">.bender/bender.log</span>
              </label>
            </div>
          </Field>
          <Field label="File level">
            <div className="relative max-w-[220px]">
              <select
                value={config.logging?.level ?? "info"}
                onChange={(e) => setConfig((c) => c ? { ...c, logging: { ...c.logging, level: e.target.value as "debug" | "info" | "warn" | "error" } } : c)}
                className="select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors"
              >
                <option value="debug" className="bg-zinc-900 text-zinc-200">debug</option>
                <option value="info" className="bg-zinc-900 text-zinc-200">info</option>
                <option value="warn" className="bg-zinc-900 text-zinc-200">warn</option>
                <option value="error" className="bg-zinc-900 text-zinc-200">error</option>
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
                <ChevronDown className="h-3.5 w-3.5" />
              </span>
            </div>
          </Field>
          <Field label="Console level">
            <div className="relative max-w-[220px]">
              <select
                value={config.logging?.consoleLevel ?? "warn"}
                onChange={(e) => setConfig((c) => c ? { ...c, logging: { ...c.logging, consoleLevel: e.target.value as "none" | "debug" | "info" | "warn" | "error" } } : c)}
                className="select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors"
              >
                <option value="none" className="bg-zinc-900 text-zinc-200">none</option>
                <option value="error" className="bg-zinc-900 text-zinc-200">error</option>
                <option value="warn" className="bg-zinc-900 text-zinc-200">warn</option>
                <option value="info" className="bg-zinc-900 text-zinc-200">info</option>
                <option value="debug" className="bg-zinc-900 text-zinc-200">debug</option>
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
                <ChevronDown className="h-3.5 w-3.5" />
              </span>
            </div>
          </Field>
        </div>
      </section>

      {/* Error */}
      {error && <p className="text-sm text-red-400/80">{error}</p>}

      {/* Save */}
      <div className="flex items-center gap-3 pb-8">
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-zinc-100 text-zinc-900 text-sm font-medium rounded-md hover:bg-white transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        {saved && <span className="text-sm text-emerald-400">Saved</span>}
      </div>
    </div>
  );
}
