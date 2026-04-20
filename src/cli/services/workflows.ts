import { StateManager } from "../../state/manager.js";
import { ensureBuiltinWorkflows } from "../../workflows/builtin.js";
import { runWorkflow } from "../../workflows/runner.js";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepType,
} from "../../workflows/types.js";

interface GitHubSession {
  accessToken: string;
}

interface WorkflowRunnerDeps {
  readGitHubSession?: () => Promise<GitHubSession | null>;
  githubApi?: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

const STEP_TYPES: WorkflowStepType[] = ["prompt", "action", "condition", "extract", "response"];

export class WorkflowServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAcceptanceCriteria(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((item) => normalizeString(item))
    .filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : undefined;
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function normalizeStep(raw: unknown, index: number): WorkflowStep {
  if (!raw || typeof raw !== "object") {
    throw new WorkflowServiceError(400, `steps[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const id = normalizeString(obj.id);
  const name = normalizeString(obj.name);
  const type = normalizeString(obj.type) as WorkflowStepType;
  if (!id) throw new WorkflowServiceError(400, `steps[${index}].id is required`);
  if (!name) throw new WorkflowServiceError(400, `steps[${index}].name is required`);
  if (!STEP_TYPES.includes(type)) {
    throw new WorkflowServiceError(400, `steps[${index}].type must be one of ${STEP_TYPES.join(", ")}`);
  }
  return {
    id,
    name,
    type,
    config: normalizeObject(obj.config),
  };
}

function normalizeInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function buildWorkflowDefinition(
  workflowId: string,
  payload: Record<string, unknown>,
  existing: WorkflowDefinition | null,
): WorkflowDefinition {
  const requestedId = normalizeString(payload.id);
  if (requestedId && requestedId !== workflowId) {
    throw new WorkflowServiceError(400, `workflow id in body must match path (${workflowId})`);
  }

  const name = normalizeString(payload.name) || existing?.name || "";
  if (!name) {
    throw new WorkflowServiceError(400, "name is required");
  }

  const rawSteps = payload.steps;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((item, index) => normalizeStep(item, index))
    : existing?.steps ?? [];
  if (steps.length === 0) {
    throw new WorkflowServiceError(400, "steps must contain at least one workflow step");
  }

  const now = Date.now();
  const currentVersion = existing?.version ?? 0;
  const explicitVersion = typeof payload.version === "number" && Number.isFinite(payload.version)
    ? Math.max(1, Math.floor(payload.version))
    : undefined;

  return {
    id: workflowId,
    name,
    ...(normalizeString(payload.description) || existing?.description
      ? { description: normalizeString(payload.description) || existing?.description }
      : {}),
    ...(normalizeAcceptanceCriteria(payload.acceptanceCriteria) ?? existing?.acceptanceCriteria
      ? { acceptanceCriteria: normalizeAcceptanceCriteria(payload.acceptanceCriteria) ?? existing?.acceptanceCriteria }
      : {}),
    version: explicitVersion ?? (existing ? currentVersion + 1 : 1),
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : (existing?.enabled ?? true),
    ...(payload.inputSchema && typeof payload.inputSchema === "object" && !Array.isArray(payload.inputSchema)
      ? { inputSchema: normalizeObject(payload.inputSchema) }
      : existing?.inputSchema
        ? { inputSchema: existing.inputSchema }
        : {}),
    ...(payload.outputSchema && typeof payload.outputSchema === "object" && !Array.isArray(payload.outputSchema)
      ? { outputSchema: normalizeObject(payload.outputSchema) }
      : existing?.outputSchema
        ? { outputSchema: existing.outputSchema }
        : {}),
    steps,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function getStateWithBuiltins(projectRoot: string): Promise<StateManager> {
  const state = new StateManager(projectRoot);
  await state.init();
  await ensureBuiltinWorkflows(state);
  return state;
}

export async function listWorkflows(projectRoot: string): Promise<WorkflowDefinition[]> {
  const state = await getStateWithBuiltins(projectRoot);
  return await state.readWorkflows();
}

export async function getWorkflow(projectRoot: string, workflowId: string): Promise<WorkflowDefinition> {
  const state = await getStateWithBuiltins(projectRoot);
  const workflow = await state.readWorkflow(workflowId);
  if (!workflow) throw new WorkflowServiceError(404, `Workflow '${workflowId}' not found`);
  return workflow;
}

export async function upsertWorkflow(
  projectRoot: string,
  workflowId: string,
  payload: Record<string, unknown>,
): Promise<WorkflowDefinition> {
  const normalizedId = workflowId.trim();
  if (!normalizedId) throw new WorkflowServiceError(400, "workflow id is required");
  const state = await getStateWithBuiltins(projectRoot);
  const existing = await state.readWorkflow(normalizedId);
  const next = buildWorkflowDefinition(normalizedId, payload, existing);
  await state.writeWorkflow(next);
  return next;
}

export async function removeWorkflow(projectRoot: string, workflowId: string): Promise<void> {
  const normalizedId = workflowId.trim();
  if (!normalizedId) throw new WorkflowServiceError(400, "workflow id is required");
  const state = await getStateWithBuiltins(projectRoot);
  const existing = await state.readWorkflow(normalizedId);
  if (!existing) throw new WorkflowServiceError(404, `Workflow '${workflowId}' not found`);
  await state.deleteWorkflow(normalizedId);
}

export async function listWorkflowRuns(
  projectRoot: string,
  workflowId?: string,
): Promise<WorkflowRun[]> {
  const state = await getStateWithBuiltins(projectRoot);
  return await state.readWorkflowRuns(workflowId?.trim() || undefined);
}

export async function getWorkflowRun(projectRoot: string, runId: string): Promise<WorkflowRun> {
  const state = await getStateWithBuiltins(projectRoot);
  const run = await state.readWorkflowRun(runId.trim());
  if (!run) throw new WorkflowServiceError(404, `Workflow run '${runId}' not found`);
  return run;
}

export async function executeWorkflow(
  projectRoot: string,
  workflowId: string,
  payload: Record<string, unknown>,
  deps: WorkflowRunnerDeps = {},
): Promise<WorkflowRun> {
  const normalizedId = workflowId.trim();
  if (!normalizedId) throw new WorkflowServiceError(400, "workflow id is required");
  const state = await getStateWithBuiltins(projectRoot);
  const workflow = await state.readWorkflow(normalizedId);
  if (!workflow) throw new WorkflowServiceError(404, `Workflow '${workflowId}' not found`);
  if (!workflow.enabled) {
    throw new WorkflowServiceError(400, `Workflow '${workflowId}' is disabled`);
  }
  const input = normalizeInputRecord(payload.input);
  return await runWorkflow(projectRoot, workflow, input, deps);
}

