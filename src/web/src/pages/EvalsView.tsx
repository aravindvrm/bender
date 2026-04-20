import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LoadingDots } from "../components/LoadingDots";
import type { ProjectState } from "../hooks/useApi";
import { roleLabel, type BaseRole } from "../lib/roleLabels";

type ModelTier = "fast" | "default" | "strong";
type EvalRunStatus = "queued" | "running" | "succeeded" | "failed";
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

interface EvalSuite {
  id: string;
  name: string;
  taskIds: string[];
}

interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface EvalTaskRun {
  id: string;
  taskId: string;
  configId: string;
  provider: string;
  model: string;
  status: EvalRunStatus;
  success: boolean;
  output: string;
  durationMs: number;
  usage?: EvalUsage;
  estimatedCostUsd?: number | null;
  error?: string;
  trace: Record<string, unknown>;
  assertionSummary?: EvalAssertionSummary;
  assertions?: EvalAssertionResult[];
  promptfoo?: Record<string, unknown>;
}

interface EvalAssertionSummary {
  total: number;
  passed: number;
  failed: number;
  score: number | null;
  reason?: string;
}

interface EvalAssertionResult {
  id: string;
  type: string;
  metric?: string;
  pass: boolean;
  score?: number | null;
  reason?: string;
  raw?: Record<string, unknown> | null;
}

interface EvalCompareRunSummary {
  id: string;
  taskId: string;
  status: EvalRunStatus;
  createdAt: number;
}

interface EvalSuiteConfigAggregate {
  configId: string;
  tasksAttempted: number;
  tasksSucceeded: number;
  successRate: number;
  totalLatencyMs: number;
  medianLatencyMs: number;
  totalEstimatedCostUsd: number | null;
  totalTokenUsage: number | null;
}

interface EvalSuiteRun {
  id: string;
  suiteId: string;
  status: EvalRunStatus;
  createdAt: number;
  ranking: EvalSuiteConfigAggregate[];
}

interface ParsedPlanTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

interface EvalsViewProps {
  state: ProjectState;
  onNewTask: () => void;
  runOperation?: (
    url: string,
    body: Record<string, unknown>,
    options?: { onSuccess?: () => void; onFinish?: (success: boolean) => void },
  ) => void;
}

function parsePlanTasks(state: ProjectState): ParsedPlanTask[] {
  if (state.currentTaskPlan?.tasks?.length) {
    return state.currentTaskPlan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
    }));
  }

  const markdown = state.currentTasks;
  if (!markdown) return [];

  const tasks: ParsedPlanTask[] = [];
  const pattern = /###\s*Task\s*([^:\n]+):\s*(.+?)\n([\s\S]*?)(?=\n###\s*Task|\n##\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const body = match[3];
    const rawId = match[1].trim();
    const normalizedId = /^task-\d+$/i.test(rawId)
      ? rawId.toLowerCase()
      : /^\d+$/.test(rawId)
        ? `task-${rawId}`
        : "";
    if (!normalizedId) continue;
    const descMatch = body.match(/\*\*Description\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const criteriaSection = body.match(/\*\*Acceptance criteria\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const acceptanceCriteria = (criteriaSection?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
    tasks.push({
      id: normalizedId,
      title: match[2].trim(),
      description: descMatch?.[1]?.trim() ?? "",
      acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : ["Task implemented and verified."],
    });
  }
  return tasks;
}

function evalTaskIdForPlanTask(taskId: string): string {
  return `plan-task-${taskId}`;
}

function planTaskIdFromEvalTaskId(evalTaskId: string): string | null {
  const prefix = "plan-task-";
  if (!evalTaskId.startsWith(prefix)) return null;
  return evalTaskId.slice(prefix.length) || null;
}

function evalTaskPromptFromPlanTask(task: ParsedPlanTask): string {
  const criteria = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria.map((entry) => `- ${entry}`).join("\n")
    : "- Task implemented and verified.";
  return [
    `Implement Task ${task.id}: ${task.title}`,
    "",
    "Description:",
    task.description || "No description provided.",
    "",
    "Acceptance criteria:",
    criteria,
  ].join("\n");
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTokens(usage?: EvalUsage): string {
  if (!usage) return "—";
  const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  return total > 0 ? total.toLocaleString() : "—";
}

function fmtCost(value?: number | null): string {
  if (typeof value !== "number") return "—";
  return `$${value.toFixed(4)}`;
}

const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama", "openai-compatible"] as const;

const PROVIDER_MODEL_HINTS: Record<string, { fast: string; default: string; strong: string }> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", default: "claude-sonnet-4-6-20250514", strong: "claude-opus-4-6-20250514" },
  openai: { fast: "gpt-4o-mini", default: "gpt-4o", strong: "gpt-4.1" },
  google: { fast: "gemini-2.0-flash", default: "gemini-2.5-pro", strong: "gemini-2.5-pro" },
  groq: { fast: "llama-3.3-70b-versatile", default: "llama-3.3-70b-versatile", strong: "llama-3.3-70b-versatile" },
  ollama: { fast: "llama3.2", default: "llama3.1:70b", strong: "llama3.1:70b" },
  "openai-compatible": { fast: "local-model", default: "local-model", strong: "local-model" },
};

const MAX_CONFIG_SKILLS = 6;
const MAX_CONFIG_CONNECTORS = 6;
const SUCCESS_MODES: EvalSuccessMode[] = ["response-only", "diff-generated", "build-verified", "test-verified"];

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
  const resolvedOptions = hasCurrent || !value.trim() ? options : [value, ...options];

  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors font-mono ${disabled ? "cursor-not-allowed" : ""}`}
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

export function EvalsView({ state, onNewTask, runOperation }: EvalsViewProps) {
  const [activeTab, setActiveTab] = useState<"evals" | "configs">("evals");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [configs, setConfigs] = useState<EvalConfig[]>([]);
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [compareRuns, setCompareRuns] = useState<EvalCompareRunSummary[]>([]);
  const [suiteRuns, setSuiteRuns] = useState<EvalSuiteRun[]>([]);

  const [configName, setConfigName] = useState("");
  const [configRole, setConfigRole] = useState<BaseRole>("implementer");
  const [configSuccessMode, setConfigSuccessMode] = useState<EvalSuccessMode>("diff-generated");
  const [configTier, setConfigTier] = useState<ModelTier>("default");
  const [configProvider, setConfigProvider] = useState("");
  const [configModel, setConfigModel] = useState("");
  const [selectedConfigSkills, setSelectedConfigSkills] = useState<string[]>([]);
  const [selectedConfigConnectorIds, setSelectedConfigConnectorIds] = useState<string[]>([]);
  const [skillSearch, setSkillSearch] = useState("");
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [connectors, setConnectors] = useState<McpConnector[]>([]);
  const [liveModelOptions, setLiveModelOptions] = useState<Record<string, string[]>>({});
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);

  const [selectedPlanTaskIds, setSelectedPlanTaskIds] = useState<Set<string>>(new Set());
  const [selectedConfigIds, setSelectedConfigIds] = useState<Set<string>>(new Set());
  const [newSuiteName, setNewSuiteName] = useState("");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");

  const [activeCompareRunId, setActiveCompareRunId] = useState<string | null>(null);
  const [activeCompareRun, setActiveCompareRun] = useState<{ summary: EvalCompareRunSummary; runs: EvalTaskRun[] } | null>(null);
  const [selectedCompareDetailId, setSelectedCompareDetailId] = useState<string | null>(null);

  const [activeSuiteRunId, setActiveSuiteRunId] = useState<string | null>(null);
  const [activeSuiteRun, setActiveSuiteRun] = useState<{ suiteRun: EvalSuiteRun; taskRuns: EvalTaskRun[] } | null>(null);

  const planTasks = useMemo(() => parsePlanTasks(state), [state]);
  const planTaskById = useMemo(() => new Map(planTasks.map((t) => [t.id, t])), [planTasks]);
  const configById = useMemo(() => new Map(configs.map((c) => [c.id, c])), [configs]);
  const configNameById = useMemo(() => new Map(configs.map((c) => [c.id, c.name])), [configs]);
  const selectedCompareDetail = useMemo(
    () => activeCompareRun?.runs.find((r) => r.id === selectedCompareDetailId) ?? null,
    [activeCompareRun, selectedCompareDetailId],
  );

  const taskLabel = useCallback((evalTaskId: string): string => {
    const id = planTaskIdFromEvalTaskId(evalTaskId);
    if (id === null) return evalTaskId;
    const task = planTaskById.get(id);
    return task ? `Task ${id}: ${task.title}` : `Task ${id}`;
  }, [planTaskById]);

  const selectedConfigCount = selectedConfigIds.size;
  const selectedTaskCount = selectedPlanTaskIds.size;
  const canRunSingleTask = selectedConfigCount >= 2 && selectedTaskCount === 1;
  const canSaveSuite = selectedTaskCount > 0 && newSuiteName.trim().length > 0;
  const canRunSuite = selectedConfigCount >= 2 && !!selectedSuiteId;
  const filteredSkills = useMemo(
    () => skills.filter((s) => !skillSearch || s.name.includes(skillSearch.toLowerCase()) || s.description.toLowerCase().includes(skillSearch.toLowerCase())),
    [skills, skillSearch],
  );
  const selectedSkillsSet = useMemo(() => new Set(selectedConfigSkills), [selectedConfigSkills]);
  const selectedConnectorSet = useMemo(() => new Set(selectedConfigConnectorIds), [selectedConfigConnectorIds]);

  const getModelOptions = useCallback((provider: string): string[] => {
    const live = liveModelOptions[provider];
    if (Array.isArray(live) && live.length > 0) return live;
    const hints = PROVIDER_MODEL_HINTS[provider];
    if (!hints) return [];
    return [...new Set([hints.fast, hints.default, hints.strong])];
  }, [liveModelOptions]);

  const providerHasConfiguredKey = useCallback((provider: string): boolean => {
    if (provider === "ollama") return true;
    if (provider === "openai-compatible") return !!llmStatus?.providers?.[provider]?.configured;
    return !!llmStatus?.providers?.[provider]?.configured;
  }, [llmStatus]);
  const configuredProviders = useMemo(
    () => PROVIDERS.filter((provider) => providerHasConfiguredKey(provider)),
    [providerHasConfiguredKey],
  );
  const configProviderOptions = useMemo(() => {
    if (!configProvider) return configuredProviders;
    if (configuredProviders.includes(configProvider as typeof configuredProviders[number])) return configuredProviders;
    return [...configuredProviders, configProvider];
  }, [configuredProviders, configProvider]);

  const loadSkillsCatalog = useCallback(async (forceCuratedRefresh = false): Promise<SkillMeta[]> => {
    try {
      const catalogRes = await fetch("/api/skills/catalog");
      const catalogBody = await catalogRes.json() as { skills?: SkillMeta[]; error?: string };
      if (catalogRes.ok) {
        return Array.isArray(catalogBody.skills) ? catalogBody.skills : [];
      }
    } catch {
      // Fallback to legacy endpoint below.
    }

    const registryRes = await fetch("/api/skills/registry");
    const registryBody = await registryRes.json() as { skills?: SkillMeta[]; needsRefresh?: boolean; error?: string };
    if (!registryRes.ok) {
      throw new Error(registryBody.error ?? "Failed to load skills");
    }

    let registrySkills = Array.isArray(registryBody.skills) ? registryBody.skills : [];
    if (forceCuratedRefresh || registrySkills.length === 0 || registryBody.needsRefresh) {
      try {
        const refreshed = await fetch("/api/skills/refresh", { method: "POST" });
        if (refreshed.ok) {
          const body = await refreshed.json() as { skills?: SkillMeta[] };
          registrySkills = Array.isArray(body.skills) ? body.skills : registrySkills;
        }
      } catch {
        // Keep initial data if refresh fails.
      }
    }
    return registrySkills;
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configsRes, suitesRes, compareRunsRes, suiteRunsRes, skillsCatalog, connectorsRes, llmStatusRes] = await Promise.all([
        fetch("/api/evals/configs"),
        fetch("/api/evals/suites"),
        fetch("/api/evals/runs/compare?limit=30"),
        fetch("/api/evals/runs/suites?limit=30"),
        loadSkillsCatalog(),
        fetch("/api/mcp/connectors"),
        fetch("/api/llm/status"),
      ]);
      if (!configsRes.ok || !suitesRes.ok || !compareRunsRes.ok || !suiteRunsRes.ok) {
        throw new Error("Failed to load eval state");
      }
      const configsJson = await configsRes.json() as { configs: EvalConfig[] };
      const suitesJson = await suitesRes.json() as { suites: EvalSuite[] };
      const compareRunsJson = await compareRunsRes.json() as { runs: EvalCompareRunSummary[] };
      const suiteRunsJson = await suiteRunsRes.json() as { runs: EvalSuiteRun[] };
      setConfigs(configsJson.configs);
      setSuites(suitesJson.suites);
      setCompareRuns(compareRunsJson.runs);
      setSuiteRuns(suiteRunsJson.runs);
      setSkills(skillsCatalog);

      if (connectorsRes.ok) {
        const connectorsJson = await connectorsRes.json() as { connectors?: McpConnector[] };
        setConnectors(Array.isArray(connectorsJson.connectors) ? connectorsJson.connectors : []);
      }
      if (llmStatusRes.ok) {
        const llmJson = await llmStatusRes.json() as LlmStatus;
        setLlmStatus(llmJson);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadSkillsCatalog]);

  const loadCompareDetail = useCallback(async (runId: string) => {
    const res = await fetch(`/api/evals/runs/compare/${encodeURIComponent(runId)}`);
    if (!res.ok) throw new Error("Failed to load compare detail");
    const json = await res.json() as { summary: EvalCompareRunSummary; runs: EvalTaskRun[] };
    setActiveCompareRun(json);
    setSelectedCompareDetailId(json.runs[0]?.id ?? null);
  }, []);

  const loadSuiteDetail = useCallback(async (runId: string) => {
    const res = await fetch(`/api/evals/runs/suites/${encodeURIComponent(runId)}`);
    if (!res.ok) throw new Error("Failed to load suite detail");
    const json = await res.json() as { suiteRun: EvalSuiteRun; taskRuns: EvalTaskRun[] };
    setActiveSuiteRun(json);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedPlanTaskIds.size === 0 && planTasks.length > 0) {
      setSelectedPlanTaskIds(new Set([planTasks[0].id]));
    }
  }, [planTasks, selectedPlanTaskIds.size]);

  useEffect(() => {
    if (!configProvider) return;
    const hints = PROVIDER_MODEL_HINTS[configProvider];
    if (!hints) return;
    if (!configModel) {
      setConfigModel(hints[configTier]);
    }
  }, [configProvider, configTier, configModel]);

  const refreshModels = useCallback(async (provider = configProvider, silent = false) => {
    if (!provider) {
      if (!silent) setModelRefreshError("Select a provider first.");
      return;
    }
    if (!providerHasConfiguredKey(provider)) {
      if (!silent) setModelRefreshError(`Configure a valid ${provider} API key in Settings first.`);
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
      if (!configModel || !models.includes(configModel)) {
        setConfigModel(models[0] ?? "");
      }
    } catch (err) {
      if (!silent) setModelRefreshError((err as Error).message);
    } finally {
      setRefreshingModels(false);
    }
  }, [configProvider, configModel, providerHasConfiguredKey]);

  async function refreshSkills() {
    setSkillsRefreshing(true);
    try {
      await fetch("/api/skills/refresh", { method: "POST" });
      const catalog = await loadSkillsCatalog(true);
      setSkills(catalog);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSkillsRefreshing(false);
    }
  }

  async function upsertEvalTaskFromPlan(task: ParsedPlanTask): Promise<string> {
    const evalTaskId = evalTaskIdForPlanTask(task.id);
    const res = await fetch("/api/evals/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: evalTaskId,
        name: `Task ${task.id}: ${task.title}`,
        prompt: evalTaskPromptFromPlanTask(task),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Failed to sync eval task." }));
      throw new Error(body.error ?? "Failed to sync eval task.");
    }
    return evalTaskId;
  }

  async function createConfig() {
    setMessage(null);
    if (!configName.trim()) return;
    if (configProvider && !providerHasConfiguredKey(configProvider)) {
      setMessage(`Cannot save config: ${configProvider} is not configured. Add API key in Settings first.`);
      return;
    }
    if (selectedConfigSkills.length > MAX_CONFIG_SKILLS) {
      setMessage(`Select up to ${MAX_CONFIG_SKILLS} skills.`);
      return;
    }
    if (selectedConfigConnectorIds.length > MAX_CONFIG_CONNECTORS) {
      setMessage(`Select up to ${MAX_CONFIG_CONNECTORS} connectors.`);
      return;
    }
    const payload = {
      name: configName.trim(),
      role: configRole,
      successMode: configSuccessMode,
      modelTier: configTier,
      provider: configProvider.trim() || undefined,
      model: configModel.trim() || undefined,
      pinnedSkills: selectedConfigSkills,
      mcpServerIds: selectedConfigConnectorIds,
      enabled: true,
    };
    const res = await fetch("/api/evals/configs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Failed to create config");
    setConfigName("");
    setConfigSuccessMode("diff-generated");
    setConfigProvider("");
    setConfigModel("");
    setSelectedConfigSkills([]);
    setSelectedConfigConnectorIds([]);
    setSkillSearch("");
    setMessage("Config saved. Add at least one more config to compare.");
    await loadData();
  }

  async function duplicateConfig(configId: string) {
    setMessage(null);
    const source = configById.get(configId);
    if (!source) return;
    const payload = {
      name: `${source.name} copy`,
      role: source.role,
      successMode: source.successMode ?? (source.role === "implementer" ? "diff-generated" : "response-only"),
      modelTier: source.modelTier ?? "default",
      provider: source.provider,
      model: source.model,
      pinnedSkills: source.pinnedSkills ?? [],
      mcpServerIds: source.mcpServerIds ?? [],
      enabled: source.enabled,
    };
    const res = await fetch("/api/evals/configs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Failed to duplicate config");
    setMessage("Config duplicated.");
    await loadData();
  }

  async function deleteConfig(configId: string) {
    setMessage(null);
    const res = await fetch(`/api/evals/configs/${encodeURIComponent(configId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete config");
    setSelectedConfigIds((prev) => {
      const next = new Set(prev);
      next.delete(configId);
      return next;
    });
    await loadData();
  }

  async function saveSelectedAsSuite() {
    setMessage(null);
    if (!newSuiteName.trim()) {
      setMessage("Enter a suite name first.");
      return;
    }
    if (selectedPlanTaskIds.size === 0) {
      setMessage("Select at least one task to save as a suite.");
      return;
    }

    const evalTaskIds: string[] = [];
    for (const planTaskId of selectedPlanTaskIds) {
      const task = planTaskById.get(planTaskId);
      if (!task) continue;
      evalTaskIds.push(await upsertEvalTaskFromPlan(task));
    }
    const res = await fetch("/api/evals/suites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newSuiteName.trim(),
        taskIds: evalTaskIds,
      }),
    });
    if (!res.ok) throw new Error("Failed to create suite");
    setSelectedSuiteId("");
    setNewSuiteName("");
    setMessage("Suite saved.");
    await loadData();
  }

  async function loadSuiteTasksToSelection() {
    setMessage(null);
    if (!selectedSuiteId) return;
    const suite = suites.find((s) => s.id === selectedSuiteId);
    if (!suite) return;
    const next = new Set<string>();
    for (const evalTaskId of suite.taskIds) {
      const id = planTaskIdFromEvalTaskId(evalTaskId);
      if (id !== null && planTaskById.has(id)) next.add(id);
    }
    setSelectedPlanTaskIds(next);
    setMessage(`Loaded ${next.size} task(s) from suite.`);
  }

  async function runSelected() {
    setMessage(null);
    if (selectedConfigIds.size < 2) {
      setMessage("Select at least 2 configs to run a comparison.");
      return;
    }
    if (selectedPlanTaskIds.size !== 1) {
      setMessage("Direct run supports one selected task. For multiple tasks, save/load a suite and run suite.");
      return;
    }
    const planTaskId = [...selectedPlanTaskIds][0];
    const task = planTaskById.get(planTaskId);
    if (!task) return;
    const evalTaskId = await upsertEvalTaskFromPlan(task);
    const body = { taskId: evalTaskId, configIds: [...selectedConfigIds] };
    if (runOperation) {
      runOperation("/api/run/evals/compare", body, { onSuccess: () => void loadData() });
      return;
    }
    await fetch("/api/run/evals/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await loadData();
  }

  function runSelectedSuite() {
    setMessage(null);
    if (!selectedSuiteId) {
      setMessage("Select a saved suite to run.");
      return;
    }
    if (selectedConfigIds.size < 2) {
      setMessage("Select at least 2 configs to run a comparison.");
      return;
    }
    const body = { configIds: [...selectedConfigIds] };
    if (runOperation) {
      runOperation(`/api/run/evals/suites/${encodeURIComponent(selectedSuiteId)}`, body, {
        onSuccess: () => void loadData(),
      });
      return;
    }
    void fetch(`/api/run/evals/suites/${encodeURIComponent(selectedSuiteId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(() => loadData());
  }

  if (loading) return <div className="text-sm text-zinc-500">Loading evals…</div>;
  if (error) return <div className="text-sm text-red-400">{error}</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="inline-flex border border-zinc-800 overflow-hidden">
        <button
          onClick={() => setActiveTab("evals")}
          className={`px-4 py-2 text-xs ${activeTab === "evals" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"}`}
        >
          Evals
        </button>
        <button
          onClick={() => setActiveTab("configs")}
          className={`px-4 py-2 text-xs border-l border-zinc-800 ${activeTab === "configs" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"}`}
        >
          Configs ({configs.length})
        </button>
      </div>

      {message && <div className="text-xs text-zinc-500">{message}</div>}

      {activeTab === "evals" ? (
        <div className="space-y-4">
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-2">
            <h2 className="text-sm font-medium text-zinc-200">Compare Workflow</h2>
            <p className="text-xs text-zinc-400">
              Run the same task against multiple configs and compare quality, speed, token usage, and cost.
            </p>
            <p className="text-xs text-zinc-500">
              A config is one execution setup (role + model tier + optional provider/model/skills/tools). Comparisons require at least 2 configs.
            </p>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-200">Run Evals</h2>
              <button onClick={onNewTask} className="px-3 py-1.5 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700">
                New Task
              </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-zinc-500">Task plan selection</p>
                  <span className="text-[11px] text-zinc-500">{selectedTaskCount} selected</span>
                </div>
                <div className="max-h-72 overflow-auto border border-zinc-800 rounded-md bg-zinc-950 p-2 space-y-1.5">
                  {planTasks.length === 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs text-zinc-600">No tasks in current plan.</p>
                      <button onClick={onNewTask} className="px-2 py-1 text-[11px] border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800">
                        Create task
                      </button>
                    </div>
                  ) : planTasks.map((task) => (
                    <label key={task.id} className="flex items-start gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={selectedPlanTaskIds.has(task.id)}
                        onChange={() => {
                          setSelectedPlanTaskIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
                            return next;
                          });
                        }}
                      />
                      <span className="leading-5">Task {task.id}: {task.title}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-zinc-500">Configs to compare</p>
                  <span className={`text-[11px] ${selectedConfigCount < 2 ? "text-amber-400" : "text-zinc-500"}`}>
                    {selectedConfigCount} selected {selectedConfigCount < 2 ? "(need 2+)" : ""}
                  </span>
                </div>
                <div className="max-h-72 overflow-auto border border-zinc-800 rounded-md bg-zinc-950 p-2 space-y-1.5">
                  {configs.length === 0 ? (
                    <p className="text-xs text-zinc-600">No configs yet. Create them in Configs tab.</p>
                  ) : configs.map((config) => (
                    <label key={config.id} className="flex items-start gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={selectedConfigIds.has(config.id)}
                        onChange={() => {
                          setSelectedConfigIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(config.id)) next.delete(config.id); else next.add(config.id);
                            return next;
                          });
                        }}
                      />
                      <span className="leading-5">{config.name} · {roleLabel(config.role)} · {config.modelTier ?? "default"}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void runSelected()}
                  disabled={!canRunSingleTask}
                  className="px-3 py-1.5 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Compare Single Task
                </button>
                <span className="text-[11px] text-zinc-500">
                  Requires exactly 1 selected task and 2+ selected configs.
                </span>
              </div>

              <div className="pt-3 border-t border-zinc-800 space-y-2">
                <p className="text-xs text-zinc-500">Suites are saved sets of tasks for repeatable multi-task comparisons.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={newSuiteName}
                    onChange={(e) => setNewSuiteName(e.target.value)}
                    placeholder="Suite name"
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => void saveSelectedAsSuite()}
                    disabled={!canSaveSuite}
                    className="px-3 py-1.5 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Save Selected as Suite
                  </button>
                  <select
                    value={selectedSuiteId}
                    onChange={(e) => setSelectedSuiteId(e.target.value)}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200"
                  >
                    <option value="">Select suite</option>
                    {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
                  </select>
                  <button
                    onClick={() => void loadSuiteTasksToSelection()}
                    disabled={!selectedSuiteId}
                    className="px-3 py-1.5 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Load Suite Tasks
                  </button>
                  <button
                    onClick={runSelectedSuite}
                    disabled={!canRunSuite}
                    className="px-3 py-1.5 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Run Suite
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-4">
            <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
              <div className="space-y-4">
                <div className="border border-zinc-800 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">Recent Task Runs</div>
                  <div className="max-h-56 overflow-auto">
                    {compareRuns.map((run) => (
                      <button
                        key={run.id}
                        onClick={() => { setActiveCompareRunId(run.id); void loadCompareDetail(run.id); }}
                        className={`w-full text-left px-3 py-2 text-xs border-b border-zinc-800/60 ${activeCompareRunId === run.id ? "bg-zinc-900/70 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900/60"}`}
                      >
                        <div>{taskLabel(run.taskId)}</div>
                        <div className="text-[11px] text-zinc-600">{new Date(run.createdAt).toLocaleString()}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="border border-zinc-800 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">Recent Suite Runs</div>
                  <div className="max-h-56 overflow-auto">
                    {suiteRuns.map((run) => (
                      <button
                        key={run.id}
                        onClick={() => { setActiveSuiteRunId(run.id); void loadSuiteDetail(run.id); }}
                        className={`w-full text-left px-3 py-2 text-xs border-b border-zinc-800/60 ${activeSuiteRunId === run.id ? "bg-zinc-900/70 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900/60"}`}
                      >
                        <div>{run.suiteId}</div>
                        <div className="text-[11px] text-zinc-600">{new Date(run.createdAt).toLocaleString()}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                {activeCompareRun ? (
                  <div className="space-y-3">
                    <p className="text-xs text-zinc-500">Task run comparison</p>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {activeCompareRun.runs.map((run) => (
                        <button
                          key={run.id}
                          onClick={() => setSelectedCompareDetailId(run.id)}
                          className={`text-left rounded-lg border p-3 ${selectedCompareDetailId === run.id ? "border-zinc-600 bg-zinc-900/70" : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/60"}`}
                        >
                          <p className="text-xs text-zinc-300">{configNameById.get(run.configId) ?? run.configId}</p>
                          <p className="text-[11px] text-zinc-500 mt-1">{run.provider} / {run.model}</p>
                          <div className="grid grid-cols-2 gap-1 mt-2 text-[11px] text-zinc-400">
                            <span>Status: {run.status}</span>
                            <span>Success: {run.success ? "yes" : "no"}</span>
                            <span>Duration: {fmtMs(run.durationMs)}</span>
                            <span>Tokens: {fmtTokens(run.usage)}</span>
                            <span>Cost: {fmtCost(run.estimatedCostUsd)}</span>
                            <span>
                              Assertions: {run.assertionSummary ? `${run.assertionSummary.passed}/${run.assertionSummary.total}` : "—"}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                    {selectedCompareDetail && (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-3">
                        <div className="grid gap-2 md:grid-cols-2 text-[11px] text-zinc-400">
                          <span>
                            Assertion score: {typeof selectedCompareDetail.assertionSummary?.score === "number" ? selectedCompareDetail.assertionSummary.score.toFixed(3) : "—"}
                          </span>
                          <span>
                            Assertion pass: {selectedCompareDetail.assertionSummary ? `${selectedCompareDetail.assertionSummary.passed}/${selectedCompareDetail.assertionSummary.total}` : "—"}
                          </span>
                        </div>
                        {selectedCompareDetail.assertions && selectedCompareDetail.assertions.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-[11px] uppercase tracking-wide text-zinc-500">Assertions</p>
                            <div className="space-y-1">
                              {selectedCompareDetail.assertions.map((assertion) => (
                                <div key={assertion.id} className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[11px] text-zinc-300">
                                  <div className="flex items-center justify-between gap-3">
                                    <span>{assertion.metric ?? assertion.type}</span>
                                    <span className={assertion.pass ? "text-emerald-400" : "text-rose-400"}>
                                      {assertion.pass ? "pass" : "fail"}
                                    </span>
                                  </div>
                                  {assertion.reason ? <div className="mt-1 text-zinc-400">{assertion.reason}</div> : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words max-h-64 overflow-auto border border-zinc-800 rounded-md p-3 bg-zinc-950">
                          {selectedCompareDetail.output || selectedCompareDetail.error || "No output."}
                        </pre>
                        <details>
                          <summary className="text-xs text-zinc-500 cursor-pointer">Promptfoo Details</summary>
                          <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words mt-2 border border-zinc-800 rounded-md p-3 bg-zinc-950 max-h-56 overflow-auto">
                            {JSON.stringify(selectedCompareDetail.promptfoo ?? {}, null, 2)}
                          </pre>
                        </details>
                        <details>
                          <summary className="text-xs text-zinc-500 cursor-pointer">Trace</summary>
                          <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words mt-2 border border-zinc-800 rounded-md p-3 bg-zinc-950 max-h-56 overflow-auto">
                            {JSON.stringify(selectedCompareDetail.trace, null, 2)}
                          </pre>
                        </details>
                      </div>
                    )}
                  </div>
                ) : null}

                {activeSuiteRun ? (
                  <div className="space-y-3">
                    <p className="text-xs text-zinc-500">Suite summary</p>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {activeSuiteRun.suiteRun.ranking.map((row) => (
                        <div key={row.configId} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                          <p className="text-xs text-zinc-200">{configNameById.get(row.configId) ?? row.configId}</p>
                          <div className="grid grid-cols-2 gap-1 mt-2 text-[11px] text-zinc-400">
                            <span>Success: {(row.successRate * 100).toFixed(0)}%</span>
                            <span>Done: {row.tasksSucceeded}/{row.tasksAttempted}</span>
                            <span>Median: {fmtMs(row.medianLatencyMs)}</span>
                            <span>Cost: {fmtCost(row.totalEstimatedCostUsd)}</span>
                            <span>Tokens: {row.totalTokenUsage?.toLocaleString() ?? "—"}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {!activeCompareRun && !activeSuiteRun ? (
                  <p className="text-sm text-zinc-500">Run an eval and select a recent run to inspect results.</p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-4">
          <h2 className="text-sm font-medium text-zinc-200">Configs</h2>
          <p className="text-xs text-zinc-500">
            Create one config per row here. Then go to Evals and select 2+ configs to compare the same task across them.
          </p>
          <div className="grid gap-4 lg:grid-cols-[470px_1fr]">
            <div className="space-y-3">
              <input
                value={configName}
                onChange={(e) => setConfigName(e.target.value)}
                placeholder="Config name"
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
              />

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Role</p>
                  <select
                    value={configRole}
                    onChange={(e) => setConfigRole(e.target.value as BaseRole)}
                    className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                  >
                    <option value="analyzer">{roleLabel("analyzer")}</option>
                    <option value="architect">{roleLabel("architect")}</option>
                    <option value="planner">{roleLabel("planner")}</option>
                    <option value="implementer">{roleLabel("implementer")}</option>
                    <option value="reviewer">{roleLabel("reviewer")}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Success mode</p>
                  <select
                    value={configSuccessMode}
                    onChange={(e) => setConfigSuccessMode(e.target.value as EvalSuccessMode)}
                    className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                  >
                    {SUCCESS_MODES.map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Model tier</p>
                  <select
                    value={configTier}
                    onChange={(e) => setConfigTier(e.target.value as ModelTier)}
                    className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                  >
                    <option value="fast">fast</option>
                    <option value="default">default</option>
                    <option value="strong">strong</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                <div className="space-y-1">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Provider</p>
                  <select
                    value={configProvider}
                    onChange={(e) => {
                      const nextProvider = e.target.value;
                      setConfigProvider(nextProvider);
                      if (!nextProvider) {
                        setConfigModel("");
                        setModelRefreshError(null);
                        return;
                      }
                      const hint = PROVIDER_MODEL_HINTS[nextProvider]?.[configTier];
                      if (hint) setConfigModel(hint);
                      if (providerHasConfiguredKey(nextProvider)) {
                        void refreshModels(nextProvider, true);
                      } else {
                        setModelRefreshError(`Configure a valid ${nextProvider} API key in Settings first.`);
                      }
                    }}
                    className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                  >
                    <option value="">project default</option>
                    {configProviderOptions.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                        {provider === "openai-compatible" ? " (experimental)" : ""}
                        {!providerHasConfiguredKey(provider) ? " (not configured)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => void refreshModels(configProvider)}
                  disabled={!configProvider || refreshingModels}
                  className="px-3 py-2 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {refreshingModels ? "Refreshing..." : "Refresh models"}
                </button>
              </div>

              <div className="space-y-1">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Model</p>
                <ModelSelect
                  value={configModel}
                  options={configProvider ? getModelOptions(configProvider) : []}
                  onChange={setConfigModel}
                  disabled={!configProvider || !providerHasConfiguredKey(configProvider)}
                />
                {modelRefreshError && <p className="text-[11px] text-red-400">{modelRefreshError}</p>}
                {!configProvider && <p className="text-[11px] text-zinc-600">Select provider to enable model selection.</p>}
                {configuredProviders.length === 0 && (
                  <p className="text-[11px] text-zinc-600">
                    Configure provider keys/endpoints in Settings to run cross-provider evals.
                  </p>
                )}
                {configProvider && !providerHasConfiguredKey(configProvider) && (
                  <p className="text-[11px] text-zinc-600">
                    Provider key missing. Set {configProvider} API key in Settings to use this provider.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
                    Skills ({selectedConfigSkills.length}/{MAX_CONFIG_SKILLS})
                  </p>
                  <button
                    onClick={() => void refreshSkills()}
                    disabled={skillsRefreshing}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                  >
                    {skillsRefreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
                <input
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  placeholder="Filter skills..."
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200"
                />
                <div className="max-h-44 overflow-auto rounded-md border border-zinc-800 bg-zinc-950">
                  {skills.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-zinc-600">
                      {skillsRefreshing ? <LoadingDots size={14} label="Loading skills…" textClassName="text-[11px] text-zinc-500" /> : "No skills loaded yet."}
                    </div>
                  ) : filteredSkills.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-zinc-600">No skills match this filter.</p>
                  ) : filteredSkills.map((skill) => {
                    const enabled = selectedSkillsSet.has(skill.name);
                    const atLimit = !enabled && selectedConfigSkills.length >= MAX_CONFIG_SKILLS;
                    return (
                      <label key={skill.name} className={`flex items-start gap-2 px-3 py-2 border-b border-zinc-800/60 text-xs ${atLimit ? "opacity-50" : "text-zinc-300"}`}>
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={atLimit}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelectedConfigSkills((prev) => {
                              if (checked) return [...prev, skill.name];
                              return prev.filter((s) => s !== skill.name);
                            });
                          }}
                        />
                        <span className="leading-4">
                          <span className="text-zinc-200">{skill.name}</span>
                          <span className="ml-1 text-[10px] uppercase tracking-wide text-zinc-500">
                            [{skill.source ?? "curated"}]
                          </span>
                          <span className="block text-zinc-500">{skill.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
                  MCP Connectors ({selectedConfigConnectorIds.length}/{MAX_CONFIG_CONNECTORS})
                </p>
                <div className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
                  {connectors.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-zinc-600">No connectors available.</p>
                  ) : connectors.map((connector) => {
                    const enabled = selectedConnectorSet.has(connector.id);
                    const atLimit = !enabled && selectedConfigConnectorIds.length >= MAX_CONFIG_CONNECTORS;
                    return (
                      <label key={connector.id} className={`flex items-start gap-2 px-3 py-2 border-b border-zinc-800/60 text-xs ${atLimit ? "opacity-50" : "text-zinc-300"}`}>
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={atLimit}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelectedConfigConnectorIds((prev) => {
                              if (checked) return [...prev, connector.id];
                              return prev.filter((id) => id !== connector.id);
                            });
                          }}
                        />
                        <span className="leading-4">
                          <span className="text-zinc-200">{connector.name}</span>
                          <span className="block text-zinc-500">
                            {connector.configured ? "configured" : "missing token"} · {connector.enabled ? "enabled" : "disabled"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <button
                onClick={() => void createConfig()}
                className="px-3 py-1.5 text-xs border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
              >
                Save Config
              </button>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {configs.map((config) => (
                <div key={config.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-zinc-200">{config.name}</p>
                    <div className="flex items-center gap-2">
                      <button onClick={() => void duplicateConfig(config.id)} className="text-[11px] text-zinc-500 hover:text-zinc-300">Duplicate</button>
                      <button onClick={() => void deleteConfig(config.id)} className="text-[11px] text-zinc-500 hover:text-red-400">Delete</button>
                    </div>
                  </div>
                  <p className="text-[11px] text-zinc-500">{roleLabel(config.role)} · {config.modelTier ?? "default"}</p>
                  <p className="text-[11px] text-zinc-600">Success mode: {config.successMode ?? "response-only"}</p>
                  <p className="text-[11px] text-zinc-600">{config.provider || "default provider"} / {config.model || "tier model"}</p>
                  {!!config.pinnedSkills?.length && (
                    <p className="text-[11px] text-zinc-600">Skills: {config.pinnedSkills.join(", ")}</p>
                  )}
                  {!!config.mcpServerIds?.length && (
                    <p className="text-[11px] text-zinc-600">Connectors: {config.mcpServerIds.join(", ")}</p>
                  )}
                </div>
              ))}
              {configs.length === 0 ? <p className="text-xs text-zinc-600">No configs yet.</p> : null}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
