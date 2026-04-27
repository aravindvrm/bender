import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Pin, PinOff, X } from "lucide-react";
import { roleLabel, type BaseRole } from "../../lib/roleLabels";

// ---------------------------------------------------------------------------
// Types (local copies — avoids circular imports from EvalsView)
// ---------------------------------------------------------------------------

type ModelTier = "fast" | "default" | "strong";
type EvalSuccessMode = "response-only" | "diff-generated" | "build-verified" | "test-verified";

interface EvalConfig {
  id: string;
  name: string;
  role: BaseRole;
  enabled: boolean;
  successMode?: EvalSuccessMode;
  modelTier?: ModelTier;
  provider?: string;
  model?: string;
  pinnedSkills?: string[];
  mcpServerIds?: string[];
}

interface SkillMeta {
  name: string;
  description: string;
  size: number;
  source?: "curated" | "user" | "project";
}

interface McpConnector {
  id: string;
  name: string;
  url: string;
  description: string;
  enabled: boolean;
  configured: boolean;
}

interface LlmStatus {
  hasAnyKey: boolean;
  activeProvider: string;
  providers: Record<string, { configured: boolean }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS: ModelTier[] = ["fast", "default", "strong"];
const SUCCESS_MODES: EvalSuccessMode[] = [
  "response-only",
  "diff-generated",
  "build-verified",
  "test-verified",
];
const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama", "local"] as const;
const PROVIDER_MODEL_HINTS: Record<string, Record<ModelTier, string>> = {
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    default: "claude-sonnet-4-6-20250514",
    strong: "claude-opus-4-6-20250514",
  },
  openai: { fast: "gpt-4o-mini", default: "gpt-4o", strong: "gpt-4.1" },
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
  ollama: { fast: "llama3.2", default: "llama3.1:70b", strong: "llama3.1:70b" },
  "local": { fast: "local-model", default: "local-model", strong: "local-model" },
};
const MAX_CONFIG_SKILLS = 6;
const SUCCESS_MODE_LABELS: Record<EvalSuccessMode, string> = {
  "response-only": "Response only",
  "diff-generated": "Diff generated",
  "build-verified": "Build verified",
  "test-verified": "Tests pass",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CreateEvalConfigModalProps {
  existingConfig?: EvalConfig | null;
  skills: SkillMeta[];
  connectors: McpConnector[];
  llmStatus: LlmStatus | null;
  onClose: () => void;
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateEvalConfigModal({
  existingConfig,
  skills,
  connectors,
  llmStatus,
  onClose,
  onSaved,
}: CreateEvalConfigModalProps) {
  const isEditing = !!existingConfig;

  const [name, setName] = useState(existingConfig?.name ?? "");
  const [role, setRole] = useState<BaseRole>(existingConfig?.role ?? "implementer");
  const [successMode, setSuccessMode] = useState<EvalSuccessMode>(
    existingConfig?.successMode ?? "diff-generated",
  );
  const [modelTier, setModelTier] = useState<ModelTier>(existingConfig?.modelTier ?? "default");
  const [provider, setProvider] = useState(existingConfig?.provider ?? "");
  const [model, setModel] = useState(existingConfig?.model ?? "");
  const [pinnedSkills, setPinnedSkills] = useState<string[]>(existingConfig?.pinnedSkills ?? []);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(existingConfig?.mcpServerIds ?? []);

  const [skillSearch, setSkillSearch] = useState("");
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configuredProviders = PROVIDERS.filter(
    (p) => p === "ollama" || !!llmStatus?.providers?.[p]?.configured,
  );

  const providerConfigured = (p: string) =>
    p === "ollama" || p === "" || !!llmStatus?.providers?.[p]?.configured;

  const getModelHint = useCallback(
    (p: string, tier: ModelTier): string =>
      PROVIDER_MODEL_HINTS[p]?.[tier] ?? "",
    [],
  );

  // When provider changes, reset model to tier hint
  useEffect(() => {
    if (!provider) {
      setModel("");
      setModelOptions([]);
      return;
    }
    const hint = getModelHint(provider, modelTier);
    if (hint) setModel((m) => m || hint);
  }, [provider, modelTier, getModelHint]);

  const refreshModels = useCallback(
    async (p = provider) => {
      if (!p || !providerConfigured(p)) {
        setModelError(`Configure a valid ${p} API key in Settings first.`);
        return;
      }
      setRefreshingModels(true);
      setModelError(null);
      try {
        const res = await fetch(`/api/llm/models?provider=${encodeURIComponent(p)}`);
        const data = (await res.json()) as { models?: string[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Failed to fetch models");
        const models = data.models ?? [];
        if (models.length === 0) throw new Error("No models returned");
        setModelOptions(models);
        if (!model || !models.includes(model)) setModel(models[0] ?? "");
      } catch (err) {
        setModelError((err as Error).message);
      } finally {
        setRefreshingModels(false);
      }
    },
    [provider, model, providerConfigured],
  );

  const effectiveModelOptions = modelOptions.length > 0 ? modelOptions : (
    provider ? [getModelHint(provider, modelTier), ...Object.values(PROVIDER_MODEL_HINTS[provider] ?? {})].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i) : []
  );

  const filteredSkills = skills.filter(
    (s) =>
      !skillSearch ||
      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
      s.description.toLowerCase().includes(skillSearch.toLowerCase()),
  );

  async function handleSave() {
    if (!name.trim()) {
      setError("Config name is required.");
      return;
    }
    if (provider && !providerConfigured(provider)) {
      setError(`${provider} is not configured. Add an API key in Settings first.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        role,
        successMode,
        modelTier,
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
        pinnedSkills,
        mcpServerIds,
        enabled: true,
      };
      const url = isEditing
        ? `/api/evals/configs/${encodeURIComponent(existingConfig.id)}`
        : "/api/evals/configs";
      const res = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to save config");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const atSkillLimit = pinnedSkills.length >= MAX_CONFIG_SKILLS;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">
            {isEditing ? `Edit config: ${existingConfig.name}` : "New Eval Config"}
          </h3>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Sonnet · implementer · no skills"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
            />
          </div>

          {/* Role + success mode + tier */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">Role</label>
              <div className="relative">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as BaseRole)}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                >
                  {BASE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">Success</label>
              <div className="relative">
                <select
                  value={successMode}
                  onChange={(e) => setSuccessMode(e.target.value as EvalSuccessMode)}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                >
                  {SUCCESS_MODES.map((m) => (
                    <option key={m} value={m}>
                      {SUCCESS_MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">Model tier</label>
              <div className="relative">
                <select
                  value={modelTier}
                  onChange={(e) => setModelTier(e.target.value as ModelTier)}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                >
                  {MODEL_TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
            </div>
          </div>

          {/* Provider + model */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">
              Provider &amp; Model{" "}
              <span className="normal-case text-zinc-600">(leave blank for project default)</span>
            </label>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <div className="relative">
                <select
                  value={provider}
                  onChange={(e) => {
                    const p = e.target.value;
                    setProvider(p);
                    setModelOptions([]);
                    setModelError(null);
                    if (p && providerConfigured(p)) void refreshModels(p);
                    else if (p) setModelError(`Configure a ${p} API key in Settings first.`);
                  }}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                >
                  <option value="">project default</option>
                  {configuredProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                  {provider && !configuredProviders.includes(provider as typeof configuredProviders[number]) && (
                    <option value={provider}>{provider} (not configured)</option>
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
              <div className="relative">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!provider}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm font-mono disabled:opacity-40"
                >
                  {!model && <option value="">—</option>}
                  {effectiveModelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {model && !effectiveModelOptions.includes(model) && (
                    <option value={model}>{model}</option>
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
              <button
                type="button"
                onClick={() => void refreshModels()}
                disabled={!provider || refreshingModels}
                className="px-2.5 py-2 rounded-lg border border-zinc-700 text-[11px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 transition-colors"
              >
                {refreshingModels ? "…" : "Refresh"}
              </button>
            </div>
            {modelError && <p className="text-[11px] text-red-400">{modelError}</p>}
          </div>

          {/* Skills */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">
                Skills ({pinnedSkills.length}/{MAX_CONFIG_SKILLS})
              </label>
              <button
                type="button"
                onClick={() => setShowSkillPicker((p) => !p)}
                className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showSkillPicker ? "Close" : "+ Add"}
              </button>
            </div>
            {pinnedSkills.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pinnedSkills.map((s) => (
                  <span
                    key={s}
                    className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono"
                  >
                    {s}
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setPinnedSkills((prev) => prev.filter((x) => x !== s))}
                      className="text-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {showSkillPicker && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
                <div className="px-2 py-1.5 border-b border-zinc-800">
                  <input
                    autoFocus
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="Filter skills…"
                    className="w-full bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 outline-none"
                  />
                </div>
                <div className="max-h-36 overflow-y-auto">
                  {filteredSkills.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-zinc-600">No skills match.</p>
                  ) : (
                    filteredSkills.map((skill) => {
                      const pinned = pinnedSkills.includes(skill.name);
                      const disabled = !pinned && atSkillLimit;
                      return (
                        <button
                          key={skill.name}
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            setPinnedSkills((prev) =>
                              pinned ? prev.filter((s) => s !== skill.name) : [...prev, skill.name],
                            )
                          }
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left border-b border-zinc-800/60 last:border-b-0 transition-colors
                            ${pinned ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"}
                            ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                        >
                          {pinned ? (
                            <PinOff className="h-3 w-3 flex-shrink-0 text-zinc-400" />
                          ) : (
                            <Pin className="h-3 w-3 flex-shrink-0 text-zinc-600" />
                          )}
                          <span className="font-mono text-zinc-200">{skill.name}</span>
                          {skill.description && (
                            <span className="text-zinc-600 truncate">{skill.description}</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Connectors */}
          {connectors.length > 0 && (
            <div className="space-y-2">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">
                MCP Connectors
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {connectors.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5 text-xs text-zinc-300 cursor-pointer hover:border-zinc-700 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={mcpServerIds.includes(c.id)}
                      onChange={(e) =>
                        setMcpServerIds((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                    {!c.configured && (
                      <span className="text-[10px] text-amber-400">missing token</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={submitting || !name.trim()}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            {submitting ? "Saving…" : isEditing ? "Update Config" : "Save Config"}
          </button>
        </div>
      </div>
    </div>
  );
}
