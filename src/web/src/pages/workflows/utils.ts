import type { WorkflowDefinition, WorkflowEditorState, WorkflowRun, WorkflowRunStatus, WorkflowStep, WorkflowStepRunStatus, WorkflowStepType } from "./types";

export const BUILTIN_IDS = new Set([
  "issue-extract-candidates",
  "task-to-implement",
  "review-current-changes",
]);

export function createDefaultWorkflowId(): string {
  return `workflow-${Date.now()}`;
}

export function createDefaultEditorState(id = createDefaultWorkflowId()): WorkflowEditorState {
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

export function toEditorState(def: WorkflowDefinition): WorkflowEditorState {
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

export function parseAcceptanceCriteria(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

export function parseJsonRecord(value: string, fieldName: string): Record<string, unknown> | undefined {
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

export function parseSteps(value: string): WorkflowStep[] {
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
    normalized.push({ id, name, type, config });
  }
  if (normalized.length === 0) {
    throw new Error("steps must include at least one step");
  }
  return normalized;
}

export function statusBadgeClass(status: WorkflowRunStatus | WorkflowStepRunStatus): string {
  if (status === "completed") return "bg-zinc-100/10 text-zinc-200 border-zinc-200/20";
  if (status === "running") return "bg-zinc-500/10 text-zinc-300 border-zinc-500/30";
  if (status === "failed") return "bg-red-500/10 text-red-300 border-red-500/30";
  if (status === "skipped") return "bg-zinc-700/40 text-zinc-400 border-zinc-600/60";
  return "bg-zinc-700/30 text-zinc-400 border-zinc-600/40";
}

export function formatTimestamp(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}

export function formatDuration(startedAt: number, finishedAt?: number): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = finishedAt - startedAt;
  if (ms < 1000) return `${Math.max(0, ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

export function isActiveRun(run: WorkflowRun): boolean {
  return run.status === "running" || run.status === "queued";
}
