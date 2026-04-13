import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

type ConfigScope = "global" | "project";

interface FullConfig {
  llm: {
    provider: string;
    apiKey?: string;
    models: { fast: string; default: string; strong: string };
  };
  providers: { [name: string]: { apiKey?: string } };
  mcp?: {
    enabled?: boolean;
    servers?: Array<{
      name: string;
      url: string;
      enabled?: boolean;
      description?: string;
      authorizationToken?: string;
      allowedTools?: string[];
      headers?: Record<string, string>;
    }>;
  };
  skills?: {
    enabled?: boolean;
    paths?: string[];
    maxChars?: number;
  };
  stack: { template: string; framework: string; database: string; orm: string; auth: string; styling: string; language: string };
  deploy: { target?: string };
  test: { command?: string };
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

const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama"];

const PROVIDER_MODEL_HINTS: Record<string, { fast: string; default: string; strong: string }> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", default: "claude-sonnet-4-6-20250514", strong: "claude-opus-4-6-20250514" },
  openai: { fast: "gpt-5.4-mini", default: "gpt-5.4", strong: "gpt-5.4" },
  google: { fast: "gemini-2.0-flash", default: "gemini-2.5-pro", strong: "gemini-2.5-pro" },
  groq: { fast: "llama-3.3-70b-versatile", default: "llama-3.3-70b-versatile", strong: "llama-3.3-70b-versatile" },
  ollama: { fast: "llama3.2", default: "llama3.1:70b", strong: "llama3.1:70b" },
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
};

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
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={password && !show ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 ${mono ? "font-mono" : ""} ${password ? "pr-14" : ""}`}
      />
      {password && (
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 px-1"
        >
          {show ? "hide" : "show"}
        </button>
      )}
    </div>
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
        className={`w-full appearance-none rounded-md pl-3 pr-8 py-2 text-[13px] transition-colors font-mono ${
          disabled
            ? "bg-zinc-950/30 border border-zinc-900 text-zinc-600 cursor-not-allowed"
            : "bg-zinc-950/50 border border-zinc-800 text-zinc-300 hover:border-zinc-700 focus:outline-none focus:border-zinc-500"
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

export function SettingsView() {
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [configScope, setConfigScope] = useState<ConfigScope>("global");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [liveModelOptions, setLiveModelOptions] = useState<Record<string, string[]>>({});
  const [refreshingModels, setRefreshingModels] = useState(false);
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
  const [githubRedirectUriInput, setGithubRedirectUriInput] = useState("http://localhost:3142/api/github/auth/callback");
  const [githubDeviceFlow, setGithubDeviceFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const githubPollTimerRef = useRef<number | null>(null);

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
          providers[p] = { apiKey: data.providers?.[p]?.apiKey ?? "" };
        }
        setConfigScope(data.scope ?? "global");
        if (data.projectRoot) setProjectRoot(data.projectRoot);
        setConfig({
          llm: data.llm,
          providers,
          mcp: {
            enabled: data.mcp?.enabled ?? false,
            servers: data.mcp?.servers ?? [],
          },
          skills: {
            enabled: data.skills?.enabled ?? false,
            paths: data.skills?.paths ?? [],
            maxChars: data.skills?.maxChars ?? 12000,
          },
          stack: data.stack,
          deploy: data.deploy,
          test: data.test,
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
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Save failed");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function setProvider(provider: string) {
    if (!config) return;
    const hints = PROVIDER_MODEL_HINTS[provider] ?? config.llm.models;
    setConfig((c) => c ? { ...c, llm: { ...c.llm, provider, models: { ...hints } } } : c);
    setModelRefreshError(null);
    void refreshModels(provider, true);
  }

  function setModel(tier: "fast" | "default" | "strong", value: string) {
    setConfig((c) => c ? { ...c, llm: { ...c.llm, models: { ...c.llm.models, [tier]: value } } } : c);
  }

  function getModelOptions(provider: string): string[] {
    const live = liveModelOptions[provider];
    if (live && live.length > 0) return live;
    return PROVIDER_MODEL_OPTIONS[provider] ?? PROVIDER_MODEL_OPTIONS.anthropic;
  }

  function providerHasConfiguredKey(provider: string): boolean {
    if (!config) return false;
    if (provider === "ollama") return true;

    const explicit = (config.providers?.[provider]?.apiKey ?? "").trim();
    if (explicit.length > 0) return true;

    const legacy = config.llm.provider === provider
      ? (config.llm.apiKey ?? "").trim().length > 0
      : false;
    if (legacy) return true;

    return !!llmStatus?.providers?.[provider]?.configured;
  }

  async function refreshModels(provider = config?.llm.provider, silent = false) {
    if (!provider) return;
    if (!providerHasConfiguredKey(provider)) {
      if (!silent) setModelRefreshError(`Configure a valid ${provider} API key first.`);
      return;
    }

    setRefreshingModels(true);
    if (!silent) setModelRefreshError(null);

    try {
      const res = await fetch(`/api/llm/models?provider=${encodeURIComponent(provider)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to refresh models");
      const models: string[] = Array.isArray(data.models) ? data.models : [];
      if (models.length === 0) throw new Error("No models returned by provider");
      setLiveModelOptions((prev) => ({ ...prev, [provider]: models }));
    } catch (err) {
      if (!silent) setModelRefreshError((err as Error).message);
    } finally {
      setRefreshingModels(false);
    }
  }

  function setProviderKey(name: string, value: string) {
    setConfig((c) => c ? { ...c, providers: { ...c.providers, [name]: { apiKey: value } } } : c);
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
      setGithubRedirectUriInput(cfg.redirectUri || "http://localhost:3142/api/github/auth/callback");
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
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!config) return <p className="text-sm text-zinc-500">Could not load config. {error}</p>;

  const activeProviderReady = providerHasConfiguredKey(config.llm.provider);
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
            placeholder="http://localhost:3142/api/github/auth/callback"
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

      {/* Per-provider API keys */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">API Keys</h3>
        <p className="text-xs text-zinc-600 mb-4">
          Enter provider keys here first. Model controls stay disabled until the active provider is configured.
        </p>
        <div className="space-y-3">
          {PROVIDERS.filter((p) => p !== "ollama").map((p) => (
            <Field key={p} label={p}>
              <TextInput
                value={config.providers[p]?.apiKey ?? ""}
                onChange={(v) => {
                  setProviderKey(p, v);
                  if (p === config.llm.provider) setModelRefreshError(null);
                }}
                placeholder={`${p.toUpperCase()}_API_KEY or blank`}
                password
                mono
              />
            </Field>
          ))}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Provider selection + model tiers */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">LLM Provider & Models</h3>
        <div className="space-y-4">
          <Field label="Active provider">
            <div className="flex gap-2 flex-wrap">
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                    config.llm.provider === p
                      ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                      : "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => void refreshModels(config.llm.provider)}
                disabled={refreshingModels || !activeProviderReady}
                className="ml-auto px-2.5 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {refreshingModels ? "Refreshing..." : "Refresh models"}
              </button>
            </div>
          </Field>

          {!activeProviderReady && (
            <p className="text-xs text-amber-400">
              Add a valid {config.llm.provider} API key (or matching env var) to enable model selection.
            </p>
          )}
          {modelRefreshError && (
            <p className="text-xs text-red-400">{modelRefreshError}</p>
          )}

          {(["fast", "default", "strong"] as const).map((tier) => (
            <Field key={tier} label={tier} hint={tier === "fast" ? "clarify" : tier === "default" ? "plan/review" : "architect/code"}>
              <ModelSelect
                value={typeof config.llm.models[tier] === "string" ? config.llm.models[tier] : ""}
                options={getModelOptions(config.llm.provider)}
                onChange={(v) => setModel(tier, v)}
                disabled={!activeProviderReady}
              />
            </Field>
          ))}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* MCP servers */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">MCP</h3>
        <p className="text-xs text-zinc-600 mb-4">
          Configure remote MCP servers for compatible providers. For now, this runtime supports MCP with Anthropic and OpenAI providers.
        </p>

        <Field label="Enable MCP">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={config.mcp?.enabled ?? false}
              onChange={(e) => setConfig((c) => c ? { ...c, mcp: { ...c.mcp, enabled: e.target.checked } } : c)}
              className="accent-zinc-300"
            />
            <span>Use MCP during role execution</span>
          </label>
        </Field>

        <div className="space-y-3 mt-4">
          {(config.mcp?.servers ?? []).map((server, idx) => (
            <div key={idx} className="border border-zinc-800 rounded-lg p-3 bg-zinc-925 space-y-3">
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={server.enabled !== false}
                    onChange={(e) => updateMcpServer(idx, { enabled: e.target.checked })}
                    className="accent-zinc-300"
                  />
                  enabled
                </label>
                <button
                  onClick={() => removeMcpServer(idx)}
                  className="text-xs text-zinc-500 hover:text-red-300 transition-colors"
                >
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <TextInput
                  value={server.name ?? ""}
                  onChange={(v) => updateMcpServer(idx, { name: v })}
                  placeholder="Server name (e.g. exa)"
                  mono
                />
                <TextInput
                  value={server.url ?? ""}
                  onChange={(v) => updateMcpServer(idx, { url: v })}
                  placeholder="https://server.example/mcp"
                  mono
                />
              </div>
              <TextInput
                value={server.description ?? ""}
                onChange={(v) => updateMcpServer(idx, { description: v })}
                placeholder="Optional description"
              />
              <TextInput
                value={server.authorizationToken ?? ""}
                onChange={(v) => updateMcpServer(idx, { authorizationToken: v })}
                placeholder="Bearer token (optional)"
                password
                mono
              />
              <TextInput
                value={(server.allowedTools ?? []).join(", ")}
                onChange={(v) =>
                  updateMcpServer(idx, {
                    allowedTools: v.split(",").map((x) => x.trim()).filter(Boolean),
                  })}
                placeholder="Allowed tools (comma separated, optional)"
                mono
              />
            </div>
          ))}
        </div>

        <button
          onClick={addMcpServer}
          className="mt-3 px-3 py-1.5 text-xs border border-zinc-700 rounded-md text-zinc-300 hover:border-zinc-500"
        >
          Add MCP Server
        </button>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Skills context */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">Skills Context</h3>
        <p className="text-xs text-zinc-600 mb-4">
          Optional markdown files/directories that get injected into role context as implementation guidance.
        </p>
        <Field label="Enable skills">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={config.skills?.enabled ?? false}
              onChange={(e) => setConfig((c) => c ? { ...c, skills: { ...c.skills, enabled: e.target.checked } } : c)}
              className="accent-zinc-300"
            />
            <span>Attach skills context to role prompts</span>
          </label>
        </Field>
        <Field label="Paths" hint="one per line">
          <textarea
            value={(config.skills?.paths ?? []).join("\n")}
            onChange={(e) =>
              setConfig((c) =>
                c
                  ? {
                      ...c,
                      skills: {
                        ...c.skills,
                        paths: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean),
                      },
                    }
                  : c)}
            rows={4}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
            placeholder=".bender/skills\n/absolute/path/to/skill.md"
          />
        </Field>
        <Field label="Max chars">
          <TextInput
            value={String(config.skills?.maxChars ?? 12000)}
            onChange={(v) =>
              setConfig((c) =>
                c
                  ? {
                      ...c,
                      skills: {
                        ...c.skills,
                        maxChars: Number.isFinite(Number(v)) ? Math.max(1000, Number(v)) : 12000,
                      },
                    }
                  : c)}
            mono
          />
        </Field>
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
