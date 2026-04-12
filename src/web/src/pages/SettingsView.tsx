import { useState, useEffect } from "react";

interface LlmConfig {
  provider: string;
  apiKey?: string;
  models: { fast: string; default: string; strong: string };
}

interface FullConfig {
  llm: LlmConfig;
  stack: { template: string; framework: string; database: string; orm: string; auth: string; styling: string; language: string };
  deploy: { target?: string };
  test: { command?: string };
}

const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama"];

const PROVIDER_HINTS: Record<string, { fast: string; default: string; strong: string }> = {
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    default: "claude-sonnet-4-6-20250514",
    strong: "claude-opus-4-6-20250514",
  },
  openai: {
    fast: "gpt-4o-mini",
    default: "gpt-4o",
    strong: "gpt-4o",
  },
  google: {
    fast: "gemini-2.0-flash",
    default: "gemini-2.5-pro",
    strong: "gemini-2.5-pro",
  },
  groq: {
    fast: "llama-3.3-70b-versatile",
    default: "llama-3.3-70b-versatile",
    strong: "llama-3.3-70b-versatile",
  },
  ollama: {
    fast: "llama3.2",
    default: "llama3.1:70b",
    strong: "llama3.1:70b",
  },
};

export function SettingsView() {
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
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

  function applyProviderHints(provider: string) {
    if (!config) return;
    const hints = PROVIDER_HINTS[provider];
    if (!hints) return;
    setConfig((c) =>
      c ? { ...c, llm: { ...c.llm, provider, models: { ...hints } } } : c
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!config) {
    return <p className="text-sm text-zinc-500">Could not load config.</p>;
  }

  return (
    <div className="max-w-2xl space-y-8">
      {/* LLM Section */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">LLM Provider</h3>
        <div className="space-y-4">
          {/* Provider */}
          <div className="grid grid-cols-[160px_1fr] items-center gap-4">
            <label className="text-sm text-zinc-400">Provider</label>
            <div className="flex gap-2 flex-wrap">
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  onClick={() => applyProviderHints(p)}
                  className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                    config.llm.provider === p
                      ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                      : "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* API Key */}
          <div className="grid grid-cols-[160px_1fr] items-center gap-4">
            <label className="text-sm text-zinc-400">API Key</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={config.llm.apiKey ?? ""}
                onChange={(e) =>
                  setConfig((c) => c ? { ...c, llm: { ...c.llm, apiKey: e.target.value } } : c)
                }
                placeholder="sk-..."
                className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 pr-16"
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 px-1"
              >
                {showKey ? "hide" : "show"}
              </button>
            </div>
          </div>

          {/* Models */}
          {(["fast", "default", "strong"] as const).map((tier) => (
            <div key={tier} className="grid grid-cols-[160px_1fr] items-center gap-4">
              <label className="text-sm text-zinc-400">
                <span>{tier}</span>
                <span className="ml-2 text-zinc-600 text-xs">
                  {tier === "fast" ? "clarify" : tier === "default" ? "plan/review" : "architect/code"}
                </span>
              </label>
              <input
                type="text"
                value={typeof config.llm.models[tier] === "string" ? config.llm.models[tier] : ""}
                onChange={(e) =>
                  setConfig((c) =>
                    c ? { ...c, llm: { ...c.llm, models: { ...c.llm.models, [tier]: e.target.value } } } : c
                  )
                }
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-zinc-500"
              />
            </div>
          ))}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Stack Section (read-only) */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">Stack</h3>
        <p className="text-xs text-zinc-600 mb-4">Stack settings are set during <code className="text-zinc-500">bender init</code> and are not editable here to avoid breaking the project.</p>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(config.stack)
            .filter(([k]) => k !== "template")
            .map(([key, val]) => (
              <div key={key} className="flex items-center justify-between px-3 py-2 bg-zinc-900 rounded-md">
                <span className="text-xs text-zinc-500">{key}</span>
                <span className="text-xs text-zinc-300">{val}</span>
              </div>
            ))}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Test command */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">Test Command</h3>
        <div className="grid grid-cols-[160px_1fr] items-center gap-4">
          <label className="text-sm text-zinc-400">Override command</label>
          <input
            type="text"
            value={config.test.command ?? ""}
            onChange={(e) =>
              setConfig((c) => c ? { ...c, test: { command: e.target.value || undefined } } : c)
            }
            placeholder="Auto-detected (e.g. npm test)"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>
      </section>

      {/* Error */}
      {error && (
        <p className="text-sm text-red-400/80">{error}</p>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
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
