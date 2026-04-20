import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock3,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";
import { JsonEditor } from "../components/JsonEditor";

type WorkflowStepType = "prompt" | "action" | "condition" | "extract" | "response";
type WorkflowRunStatus = "queued" | "running" | "completed" | "failed";
type WorkflowStepRunStatus = "running" | "completed" | "failed" | "skipped";

interface WorkflowSummary {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  acceptanceCriteria: string[];
}

interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  name: string;
  config: Record<string, unknown>;
}

interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  acceptanceCriteria?: string[];
  version: number;
  enabled: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRunStep {
  stepId: string;
  type: WorkflowStepType;
  status: WorkflowStepRunStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  steps: WorkflowRunStep[];
}

interface WorkflowsListResponse {
  workflows?: WorkflowSummary[];
  error?: string;
}

interface WorkflowDetailResponse {
  workflow?: WorkflowDefinition;
  error?: string;
}

interface WorkflowRunsResponse {
  runs?: WorkflowRun[];
  error?: string;
}

interface WorkflowRunResponse {
  run?: WorkflowRun;
  error?: string;
}

interface WorkflowExecuteResponse {
  runId?: string;
  status?: WorkflowRunStatus;
  output?: Record<string, unknown> | null;
  error?: string;
}

interface WorkflowEditorState {
  id: string;
  name: string;
  description: string;
  acceptanceCriteriaText: string;
  enabled: boolean;
  stepsText: string;
  inputSchemaText: string;
  outputSchemaText: string;
}

const BUILTIN_IDS = new Set([
  "issue-extract-candidates",
  "task-to-implement",
  "review-current-changes",
]);

function createDefaultWorkflowId(): string {
  return `workflow-${Date.now()}`;
}

function createDefaultEditorState(id = createDefaultWorkflowId()): WorkflowEditorState {
  const defaultSteps: WorkflowStep[] = [
    {
      id: "plan",
      type: "action",
      name: "Create plan proposal",
      config: {
        action: "plan",
        bodyTemplate: {
          feature: "{{input.feature}}",
          mode: "proposal",
          includeArchitectureImpact: true,
          officeHoursMode: "off",
        },
      },
    },
    {
      id: "response",
      type: "response",
      name: "Return plan output",
      config: {
        fields: ["steps.plan.tasks", "steps.plan.architectureImpact", "steps.plan.officeHoursVerdict"],
      },
    },
  ];

  return {
    id,
    name: "New Workflow",
    description: "",
    acceptanceCriteriaText: "- Produces a persisted workflow run record\n- Returns actionable output",
    enabled: true,
    stepsText: JSON.stringify(defaultSteps, null, 2),
    inputSchemaText: JSON.stringify({
      type: "object",
      required: ["feature"],
      properties: { feature: { type: "string" } },
    }, null, 2),
    outputSchemaText: JSON.stringify({
      type: "object",
      properties: { tasks: { type: "array" }, architectureImpact: { type: "string" } },
    }, null, 2),
  };
}

function toEditorState(def: WorkflowDefinition): WorkflowEditorState {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? "",
    acceptanceCriteriaText: (def.acceptanceCriteria ?? []).map((entry) => `- ${entry}`).join("\n"),
    enabled: def.enabled,
    stepsText: JSON.stringify(def.steps ?? [], null, 2),
    inputSchemaText: def.inputSchema ? JSON.stringify(def.inputSchema, null, 2) : "",
    outputSchemaText: def.outputSchema ? JSON.stringify(def.outputSchema, null, 2) : "",
  };
}

function parseAcceptanceCriteria(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function parseJsonRecord(value: string, fieldName: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseSteps(value: string): WorkflowStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("steps must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("steps must be a JSON array");
  }

  const normalized: WorkflowStep[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`steps[${i}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const type = typeof obj.type === "string" ? obj.type.trim() as WorkflowStepType : "";
    if (!id) throw new Error(`steps[${i}].id is required`);
    if (!name) throw new Error(`steps[${i}].name is required`);
    if (type !== "prompt" && type !== "action" && type !== "condition" && type !== "extract" && type !== "response") {
      throw new Error(`steps[${i}].type is invalid`);
    }
    const config = obj.config && typeof obj.config === "object" && !Array.isArray(obj.config)
      ? obj.config as Record<string, unknown>
      : {};
    normalized.push({
      id,
      name,
      type,
      config,
    });
  }
  if (normalized.length === 0) {
    throw new Error("steps must include at least one step");
  }
  return normalized;
}

function statusBadgeClass(status: WorkflowRunStatus | WorkflowStepRunStatus): string {
  if (status === "completed") return "bg-zinc-100/10 text-zinc-200 border-zinc-200/20";
  if (status === "running") return "bg-zinc-500/10 text-zinc-300 border-zinc-500/30";
  if (status === "failed") return "bg-red-500/10 text-red-300 border-red-500/30";
  if (status === "skipped") return "bg-zinc-700/40 text-zinc-400 border-zinc-600/60";
  return "bg-zinc-700/30 text-zinc-400 border-zinc-600/40";
}

function formatTimestamp(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}

function formatDuration(startedAt: number, finishedAt?: number): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = finishedAt - startedAt;
  if (ms < 1000) return `${Math.max(0, ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

export function WorkflowsView() {
  const [search, setSearch] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [editor, setEditor] = useState<WorkflowEditorState>(() => createDefaultEditorState());
  const [dirty, setDirty] = useState(false);
  const [runInputText, setRunInputText] = useState("{}");

  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);

  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshingRuns, setRefreshingRuns] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const workflowIdSet = useMemo(() => new Set(workflows.map((workflow) => workflow.id)), [workflows]);
  const persistedSelected = selectedWorkflowId ? workflowIdSet.has(selectedWorkflowId) : false;
  const isBuiltin = BUILTIN_IDS.has(editor.id);

  const filteredWorkflows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return workflows;
    return workflows.filter((workflow) =>
      workflow.name.toLowerCase().includes(query)
      || workflow.id.toLowerCase().includes(query),
    );
  }, [workflows, search]);

  const loadWorkflows = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/workflows");
      const body = await res.json().catch(() => ({})) as WorkflowsListResponse;
      if (!res.ok) throw new Error(body.error ?? `Failed to load workflows (${res.status})`);
      const next = (body.workflows ?? []).sort((a, b) => a.name.localeCompare(b.name));
      setWorkflows(next);
      setSelectedWorkflowId((current) => {
        if (current && next.some((workflow) => workflow.id === current)) return current;
        return next[0]?.id ?? null;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadWorkflowDetails = useCallback(async (workflowId: string) => {
    setLoadingDetails(true);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`);
      const body = await res.json().catch(() => ({})) as WorkflowDetailResponse;
      if (!res.ok || !body.workflow) {
        throw new Error(body.error ?? `Failed to load workflow '${workflowId}'`);
      }
      setEditor(toEditorState(body.workflow));
      setDirty(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  const loadRuns = useCallback(async (workflowId: string) => {
    setLoadingRuns(true);
    try {
      const res = await fetch(`/api/workflow-runs?workflowId=${encodeURIComponent(workflowId)}`);
      const body = await res.json().catch(() => ({})) as WorkflowRunsResponse;
      if (!res.ok) throw new Error(body.error ?? "Failed to load workflow runs");
      setRuns(body.runs ?? []);
      setSelectedRunId((current) => {
        if (current && (body.runs ?? []).some((run) => run.id === current)) return current;
        return (body.runs ?? [])[0]?.id ?? null;
      });
    } catch (err) {
      setError((err as Error).message);
      setRuns([]);
      setSelectedRunId(null);
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const loadRunDetails = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}`);
      const body = await res.json().catch(() => ({})) as WorkflowRunResponse;
      if (!res.ok || !body.run) {
        throw new Error(body.error ?? `Failed to load run '${runId}'`);
      }
      setSelectedRun(body.run);
    } catch (err) {
      setError((err as Error).message);
      setSelectedRun(null);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    if (!selectedWorkflowId) {
      setRuns([]);
      setSelectedRunId(null);
      setSelectedRun(null);
      return;
    }
    if (!workflowIdSet.has(selectedWorkflowId)) {
      return;
    }
    void loadWorkflowDetails(selectedWorkflowId);
    void loadRuns(selectedWorkflowId);
  }, [selectedWorkflowId, workflowIdSet, loadWorkflowDetails, loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }
    void loadRunDetails(selectedRunId);
  }, [selectedRunId, loadRunDetails]);

  async function handleSelectWorkflow(nextId: string): Promise<void> {
    if (nextId === selectedWorkflowId) return;
    if (dirty) {
      const confirmed = window.confirm("Discard unsaved workflow edits?");
      if (!confirmed) return;
    }
    setMessage(null);
    setError(null);
    setSelectedWorkflowId(nextId);
  }

  function handleCreateNewWorkflow(): void {
    if (dirty) {
      const confirmed = window.confirm("Discard unsaved workflow edits?");
      if (!confirmed) return;
    }
    const next = createDefaultEditorState();
    setSelectedWorkflowId(next.id);
    setEditor(next);
    setDirty(true);
    setRuns([]);
    setSelectedRunId(null);
    setSelectedRun(null);
    setMessage("Created a new workflow draft. Save to persist.");
    setError(null);
  }

  function updateEditor<K extends keyof WorkflowEditorState>(field: K, value: WorkflowEditorState[K]): void {
    setEditor((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  }

  async function handleSaveWorkflow(): Promise<void> {
    const workflowId = editor.id.trim();
    if (!workflowId) {
      setError("Workflow id is required.");
      return;
    }
    if (!editor.name.trim()) {
      setError("Workflow name is required.");
      return;
    }

    let steps: WorkflowStep[];
    let inputSchema: Record<string, unknown> | undefined;
    let outputSchema: Record<string, unknown> | undefined;
    try {
      steps = parseSteps(editor.stepsText);
      inputSchema = parseJsonRecord(editor.inputSchemaText, "inputSchema");
      outputSchema = parseJsonRecord(editor.outputSchemaText, "outputSchema");
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        name: editor.name.trim(),
        description: editor.description.trim(),
        acceptanceCriteria: parseAcceptanceCriteria(editor.acceptanceCriteriaText),
        enabled: editor.enabled,
        steps,
      };
      if (inputSchema) payload.inputSchema = inputSchema;
      if (outputSchema) payload.outputSchema = outputSchema;

      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({})) as WorkflowDetailResponse;
      if (!res.ok || !body.workflow) {
        throw new Error(body.error ?? `Failed to save workflow '${workflowId}'`);
      }

      setEditor(toEditorState(body.workflow));
      setDirty(false);
      setSelectedWorkflowId(body.workflow.id);
      await loadWorkflows();
      await loadRuns(body.workflow.id);
      setMessage(`Workflow '${body.workflow.name}' saved.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteWorkflow(): Promise<void> {
    const workflowId = editor.id.trim();
    if (!workflowId) return;
    if (!workflowIdSet.has(workflowId)) {
      const confirmed = window.confirm("Discard this unsaved workflow draft?");
      if (!confirmed) return;
      const reset = createDefaultEditorState();
      setSelectedWorkflowId(reset.id);
      setEditor(reset);
      setDirty(true);
      setRuns([]);
      setSelectedRunId(null);
      setSelectedRun(null);
      setMessage("Unsaved workflow draft discarded.");
      return;
    }
    if (isBuiltin) {
      setError("Built-in workflows cannot be deleted from the UI.");
      return;
    }
    const confirmed = window.confirm(`Delete workflow '${workflowId}'?`);
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed to delete workflow '${workflowId}'`);

      await loadWorkflows();
      setMessage(`Workflow '${workflowId}' deleted.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleRunWorkflow(): Promise<void> {
    const workflowId = editor.id.trim();
    if (!workflowIdSet.has(workflowId)) {
      setError("Save the workflow before running it.");
      return;
    }

    let inputPayload: Record<string, unknown>;
    try {
      inputPayload = parseJsonRecord(runInputText, "run input") ?? {};
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: inputPayload }),
      });
      const body = await res.json().catch(() => ({})) as WorkflowExecuteResponse;
      if (!res.ok || !body.runId) {
        throw new Error(body.error ?? `Failed to run workflow '${workflowId}'`);
      }

      setMessage(`Workflow run started: ${body.runId}`);
      await loadRuns(workflowId);
      setSelectedRunId(body.runId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function handleRefreshRuns(): Promise<void> {
    const workflowId = editor.id.trim();
    if (!workflowIdSet.has(workflowId)) return;
    setRefreshingRuns(true);
    setError(null);
    try {
      await loadRuns(workflowId);
      if (selectedRunId) {
        await loadRunDetails(selectedRunId);
      }
    } catch {
      // handled by loaders
    } finally {
      setRefreshingRuns(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300 flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-[12px] text-zinc-300 flex items-center gap-2">
          <Check className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span>{message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(460px,1fr)_360px] gap-4 min-h-[72vh]">
        <aside className="rounded-xl border border-zinc-800 bg-zinc-925/70 backdrop-blur-sm min-h-0 flex flex-col">
          <div className="px-3 py-3 border-b border-zinc-800/80">
            <div className="text-[11px] uppercase tracking-[0.12em] text-zinc-500 mb-2">Workflows</div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search workflows..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-zinc-300/70"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loadingList ? (
              <div className="px-2 py-3 text-[12px] text-zinc-500">Loading workflows...</div>
            ) : filteredWorkflows.length === 0 ? (
              <div className="px-2 py-3 text-[12px] text-zinc-500">No workflows found.</div>
            ) : (
              <div className="space-y-1.5">
                {filteredWorkflows.map((workflow) => {
                  const active = workflow.id === selectedWorkflowId;
                  return (
                    <button
                      key={workflow.id}
                      onClick={() => { void handleSelectWorkflow(workflow.id); }}
                      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${
                        active
                          ? "border-zinc-500/60 bg-zinc-800/70"
                          : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[12px] text-zinc-200 truncate">{workflow.name}</div>
                        <span className={`text-[10px] rounded px-1.5 py-0.5 border ${workflow.enabled ? "border-zinc-700 text-zinc-300" : "border-zinc-800 text-zinc-500"}`}>
                          v{workflow.version}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-zinc-500 font-mono truncate">{workflow.id}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="rounded-xl border border-zinc-800 bg-zinc-925/70 backdrop-blur-sm min-h-0 flex flex-col">
          <div className="px-4 py-3 border-b border-zinc-800/80">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-medium text-zinc-200">Workflow Editor</h3>
                <p className="text-[11px] text-zinc-500">
                  Sequential pipeline definition with explicit acceptance criteria.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCreateNewWorkflow}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-300 hover:border-zinc-600"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New
                </button>
                <button
                  onClick={() => { void handleSaveWorkflow(); }}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-300 hover:border-zinc-600 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save
                </button>
                <button
                  onClick={() => { void handleRunWorkflow(); }}
                  disabled={running || !persistedSelected}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-100/90 px-3 py-1.5 text-[12px] text-zinc-900 hover:bg-zinc-100 disabled:opacity-60"
                >
                  {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Run
                </button>
                <button
                  onClick={() => { void handleDeleteWorkflow(); }}
                  disabled={deleting}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-400 hover:border-red-500/40 hover:text-red-300 disabled:opacity-60"
                >
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Delete
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {loadingDetails && persistedSelected ? (
              <div className="text-[12px] text-zinc-500">Loading workflow details...</div>
            ) : (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-zinc-500 uppercase tracking-[0.08em]">ID</span>
                    <input
                      value={editor.id}
                      onChange={(e) => updateEditor("id", e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] font-mono text-zinc-200 outline-none focus:border-zinc-300/70"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[11px] text-zinc-500 uppercase tracking-[0.08em]">Name</span>
                    <input
                      value={editor.name}
                      onChange={(e) => updateEditor("name", e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-zinc-300/70"
                    />
                  </label>
                </div>

                <label className="space-y-1.5 block">
                  <span className="text-[11px] text-zinc-500 uppercase tracking-[0.08em]">Description</span>
                  <textarea
                    rows={2}
                    value={editor.description}
                    onChange={(e) => updateEditor("description", e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-zinc-300/70"
                  />
                </label>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <label className="space-y-1.5 block">
                    <span className="text-[11px] text-zinc-500 uppercase tracking-[0.08em]">Acceptance Criteria</span>
                    <textarea
                      rows={4}
                      value={editor.acceptanceCriteriaText}
                      onChange={(e) => updateEditor("acceptanceCriteriaText", e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-200 outline-none focus:border-zinc-300/70"
                      placeholder="- Produces a persisted workflow run record"
                    />
                  </label>

                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
                    <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">Metadata</div>
                    <label className="flex items-center gap-2 text-[12px] text-zinc-300">
                      <input
                        type="checkbox"
                        checked={editor.enabled}
                        onChange={(e) => updateEditor("enabled", e.target.checked)}
                      />
                      Enabled
                    </label>
                    <div className="text-[11px] text-zinc-500">
                      {isBuiltin ? "Built-in workflow (delete disabled)." : "Custom workflow."}
                    </div>
                    <div className={`text-[11px] ${dirty ? "text-zinc-400" : "text-zinc-600"}`}>
                      {dirty ? "Unsaved changes" : "Saved"}
                    </div>
                  </div>
                </div>

                <JsonEditor
                  label="Steps (JSON)"
                  rows={14}
                  value={editor.stepsText}
                  onChange={(v) => updateEditor("stepsText", v)}
                  placeholder="[]"
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <JsonEditor
                    label="Input Schema (JSON)"
                    rows={6}
                    value={editor.inputSchemaText}
                    onChange={(v) => updateEditor("inputSchemaText", v)}
                  />
                  <JsonEditor
                    label="Output Schema (JSON)"
                    rows={6}
                    value={editor.outputSchemaText}
                    onChange={(v) => updateEditor("outputSchemaText", v)}
                  />
                </div>
              </>
            )}
          </div>
        </section>

        <aside className="rounded-xl border border-zinc-800 bg-zinc-925/70 backdrop-blur-sm min-h-0 flex flex-col">
          <div className="px-3 py-3 border-b border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-medium text-zinc-200">Run History</div>
              <button
                onClick={() => { void handleRefreshRuns(); }}
                disabled={refreshingRuns || !persistedSelected}
                className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-600 disabled:opacity-60"
              >
                <RefreshCw className={`h-3 w-3 ${refreshingRuns ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            <div>
              <JsonEditor
                label="Run Input (JSON)"
                rows={5}
                value={runInputText}
                onChange={setRunInputText}
              />
            </div>
          </div>

          <div className="flex-1 min-h-0 grid grid-rows-[220px_minmax(0,1fr)]">
            <div className="overflow-y-auto p-2 border-b border-zinc-800/80">
              {loadingRuns ? (
                <div className="text-[12px] text-zinc-500 px-2 py-2">Loading runs...</div>
              ) : runs.length === 0 ? (
                <div className="text-[12px] text-zinc-500 px-2 py-2">No runs yet.</div>
              ) : (
                <div className="space-y-1.5">
                  {runs.map((run) => (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${
                        run.id === selectedRunId
                          ? "border-zinc-500/60 bg-zinc-800/70"
                          : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border ${statusBadgeClass(run.status)}`}>
                          {run.status}
                        </span>
                        <span className="text-[10px] text-zinc-500">{formatDuration(run.startedAt, run.finishedAt)}</span>
                      </div>
                      <div className="mt-1 text-[10px] text-zinc-500 font-mono truncate">{run.id}</div>
                      <div className="text-[10px] text-zinc-600">{formatTimestamp(run.startedAt)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="overflow-y-auto p-3 space-y-3">
              {!selectedRun ? (
                <div className="text-[12px] text-zinc-500">Select a run to inspect step traces.</div>
              ) : (
                <>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[12px] text-zinc-200 font-medium">Run Details</div>
                      <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border ${statusBadgeClass(selectedRun.status)}`}>
                        {selectedRun.status}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-zinc-500 font-mono break-all">{selectedRun.id}</div>
                    <div className="mt-2 text-[11px] text-zinc-500 flex items-center gap-2">
                      <Clock3 className="h-3 w-3" />
                      {formatTimestamp(selectedRun.startedAt)}
                    </div>
                    {selectedRun.error && (
                      <div className="mt-2 text-[11px] text-red-300">{selectedRun.error}</div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">Output</div>
                    <pre className="max-h-44 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-[10.5px] text-zinc-300 whitespace-pre-wrap break-words">
                      {jsonPreview(selectedRun.output ?? {})}
                    </pre>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-[0.08em] text-zinc-500">Step Trace</div>
                    {selectedRun.steps.length === 0 ? (
                      <div className="text-[12px] text-zinc-500">No step trace captured.</div>
                    ) : (
                      <div className="space-y-2">
                        {selectedRun.steps.map((step) => (
                          <div key={`${step.stepId}-${step.startedAt}`} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-[12px] text-zinc-200">
                                <span className="font-medium">{step.stepId}</span>
                                <span className="text-zinc-500"> · {step.type}</span>
                              </div>
                              <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border ${statusBadgeClass(step.status)}`}>
                                {step.status}
                              </span>
                            </div>
                            <div className="mt-1 text-[10px] text-zinc-500">{formatDuration(step.startedAt, step.finishedAt)}</div>
                            {step.error && (
                              <div className="mt-2 flex items-start gap-1.5 text-[11px] text-red-300">
                                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                <span>{step.error}</span>
                              </div>
                            )}
                            {step.output && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[11px] text-zinc-400">Step output</summary>
                                <pre className="mt-1 max-h-36 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 text-[10px] text-zinc-300 whitespace-pre-wrap break-words">
                                  {jsonPreview(step.output)}
                                </pre>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

