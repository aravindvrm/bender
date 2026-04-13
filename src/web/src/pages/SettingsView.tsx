import { useState, useEffect } from "react";

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

const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama"];

const PROVIDER_MODEL_HINTS: Record<string, { fast: string; default: string; strong: string }> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", default: "claude-sonnet-4-6-20250514", strong: "claude-opus-4-6-20250514" },
  openai: { fast: "gpt-4o-mini", default: "gpt-4o", strong: "gpt-4o" },
  google: { fast: "gemini-2.0-flash", default: "gemini-2.5-pro", strong: "gemini-2.5-pro" },
  groq: { fast: "llama-3.3-70b-versatile", default: "llama-3.3-70b-versatile", strong: "llama-3.3-70b-versatile" },
  ollama: { fast: "llama3.2", default: "llama3.1:70b", strong: "llama3.1:70b" },
};

const MASK = "••••••••";

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

export function SettingsView() {
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string>("");

  useEffect(() => {
    // Load config
    fetch("/api/config")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Failed to load config");
        return data as FullConfig;
      })
      .then((data) => {
        // Ensure all providers have an entry
        const providers: FullConfig["providers"] = {};
        for (const p of PROVIDERS) {
          providers[p] = { apiKey: data.providers?.[p]?.apiKey ?? "" };
        }
        setConfig({
          ...data,
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
        });
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });

    // Load state for project root
    fetch("/api/state")
      .then((r) => r.json())
      .then((data) => { if (data.projectRoot) setProjectRoot(data.projectRoot); })
      .catch(() => {});
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
  }

  function setModel(tier: "fast" | "default" | "strong", value: string) {
    setConfig((c) => c ? { ...c, llm: { ...c.llm, models: { ...c.llm.models, [tier]: value } } } : c);
  }

  function setProviderKey(name: string, value: string) {
    setConfig((c) => c ? { ...c, providers: { ...c.providers, [name]: { apiKey: value } } } : c);
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

  return (
    <div className="max-w-2xl space-y-8">

      {/* Project info */}
      {projectRoot && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Project</h3>
          <div className="flex items-center gap-3 px-3 py-2 bg-zinc-900 rounded-md">
            <span className="text-xs text-zinc-500">Directory</span>
            <span className="text-xs text-zinc-300 font-mono ml-auto">{projectRoot}</span>
          </div>
        </section>
      )}

      <div className="h-px bg-zinc-800" />

      {/* Provider selection + model tiers */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">LLM Provider</h3>
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
            </div>
          </Field>

          {(["fast", "default", "strong"] as const).map((tier) => (
            <Field key={tier} label={tier} hint={tier === "fast" ? "clarify" : tier === "default" ? "plan/review" : "architect/code"}>
              <TextInput
                value={typeof config.llm.models[tier] === "string" ? config.llm.models[tier] : ""}
                onChange={(v) => setModel(tier, v)}
                mono
              />
            </Field>
          ))}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Per-provider API keys */}
      <section>
        <h3 className="text-sm font-semibold text-zinc-300 mb-1">API Keys</h3>
        <p className="text-xs text-zinc-600 mb-4">
          Stored in <code className="text-zinc-500">.bender/config.yaml</code>. Leave blank to use the corresponding environment variable (e.g. <code className="text-zinc-500">ANTHROPIC_API_KEY</code>).
        </p>
        <div className="space-y-3">
          {PROVIDERS.filter((p) => p !== "ollama").map((p) => (
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

      {/* Stack (read-only) */}
      {config.stack && (
        <>
          <div className="h-px bg-zinc-800" />
          <section>
            <h3 className="text-sm font-semibold text-zinc-300 mb-1">Stack</h3>
            <p className="text-xs text-zinc-600 mb-3">Set during <code className="text-zinc-500">bender init</code>. Edit <code className="text-zinc-500">.bender/config.yaml</code> directly to change.</p>
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
        </>
      )}

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
