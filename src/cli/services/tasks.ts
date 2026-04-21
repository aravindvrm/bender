import { getAllAgents } from "../../state/agents.js";
import { type TaskGitHubLink, StateManager } from "../../state/manager.js";
import {
  appendTaskToCanonicalPlan,
  normalizeAcceptanceCriteria,
  normalizeTaskId,
  type CanonicalTaskPlanTask,
  type TaskStatus,
} from "../../state/task-plan.js";

export class TasksServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function deriveTitleFromDescription(description: string): string {
  const firstLine = description
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const normalized = firstLine
    .replace(/^[-*]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= 96) return normalized;
  return `${normalized.slice(0, 93).trimEnd()}...`;
}

function normalizeTaskIdInput(taskId: string): string {
  const normalized = normalizeTaskId(taskId);
  if (!normalized) {
    throw new TasksServiceError(400, "taskId must be in format task-N or numeric legacy format");
  }
  return normalized;
}

function normalizeStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "todo" || value === "in_progress" || value === "done") {
    return value;
  }
  throw new TasksServiceError(400, "status must be one of todo, in_progress, done");
}

function asTaskMap(tasks: CanonicalTaskPlanTask[]): Record<string, CanonicalTaskPlanTask> {
  const map: Record<string, CanonicalTaskPlanTask> = {};
  for (const task of tasks) {
    map[task.id] = task;
  }
  return map;
}

export async function readTaskAgents(projectRoot: string): Promise<Record<string, string>> {
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    return {};
  }

  const assignments: Record<string, string> = {};
  const plan = await state.readCurrentTaskPlan();
  for (const task of plan?.tasks ?? []) {
    if (task.implementerAgentId?.trim()) {
      assignments[task.id] = task.implementerAgentId.trim();
    }
  }

  const legacy = await state.readTaskAgents();
  for (const [rawTaskId, agentId] of Object.entries(legacy)) {
    const normalizedTaskId = normalizeTaskId(rawTaskId);
    if (!normalizedTaskId) continue;
    if (!agentId?.trim()) continue;
    if (!assignments[normalizedTaskId]) assignments[normalizedTaskId] = agentId.trim();
  }

  return assignments;
}

export async function setTaskAgent(
  projectRoot: string,
  taskId: string,
  agentId?: string | null,
): Promise<Record<string, string>> {
  const normalizedTaskId = normalizeTaskIdInput(taskId);
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";

  if (normalizedAgentId) {
    const allAgents = await getAllAgents();
    const selected = allAgents.find((a) => a.id === normalizedAgentId);
    if (!selected) {
      throw new TasksServiceError(400, `Unknown agent: ${normalizedAgentId}`);
    }
  }

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TasksServiceError(400, "Project is not initialized");
  }

  const plan = await state.readCurrentTaskPlan();
  if (!plan || plan.tasks.length === 0) {
    throw new TasksServiceError(400, "No current task plan found");
  }

  const taskIndex = plan.tasks.findIndex((task) => task.id === normalizedTaskId);
  if (taskIndex < 0) {
    throw new TasksServiceError(404, `Task ${normalizedTaskId} not found`);
  }

  const updatedTasks = [...plan.tasks];
  updatedTasks[taskIndex] = {
    ...updatedTasks[taskIndex],
    implementerAgentId: normalizedAgentId || "implementer",
  };

  await state.writeCurrentTaskPlan({
    ...plan,
    generatedAt: new Date().toISOString(),
    tasks: updatedTasks,
  });

  await state.setTaskAgent(normalizedTaskId, normalizedAgentId || null);
  return await readTaskAgents(projectRoot);
}

export async function readTaskLinks(projectRoot: string): Promise<Record<string, TaskGitHubLink>> {
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    return {};
  }

  const raw = await state.readTaskGitHubLinks();
  const normalized: Record<string, TaskGitHubLink> = {};
  for (const [taskId, link] of Object.entries(raw)) {
    const normalizedId = normalizeTaskId(taskId);
    if (!normalizedId) continue;
    normalized[normalizedId] = link;
  }
  return normalized;
}

export async function setTaskLink(
  projectRoot: string,
  taskId: string,
  payload: Partial<TaskGitHubLink> & { clear?: boolean },
): Promise<{ links: Record<string, TaskGitHubLink>; link: TaskGitHubLink | null }> {
  const normalizedTaskId = normalizeTaskIdInput(taskId);
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TasksServiceError(400, "Project is not initialized");
  }

  if (payload.clear) {
    await state.setTaskGitHubLink(normalizedTaskId, null);
  } else {
    await state.setTaskGitHubLink(normalizedTaskId, {
      repoFullName: payload.repoFullName,
      issueNumber: payload.issueNumber,
      issueUrl: payload.issueUrl,
      branchName: payload.branchName,
      prNumber: payload.prNumber,
      prUrl: payload.prUrl,
      lastSyncedAt: Date.now(),
    });
  }

  const links = await readTaskLinks(projectRoot);
  return { links, link: links[normalizedTaskId] ?? null };
}

export async function appendTask(
  projectRoot: string,
  payload: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string[];
    implementerAgentId?: string;
  },
): Promise<{ taskId: string }> {
  const rawTitle = typeof payload.title === "string" ? payload.title.trim() : "";
  const rawDescription = typeof payload.description === "string" ? payload.description.trim() : "";
  const title = rawTitle || deriveTitleFromDescription(rawDescription);

  if (!title) {
    throw new TasksServiceError(400, "title or description is required");
  }

  const state = new StateManager(projectRoot);
  const existingPlan = await state.readCurrentTaskPlan();
  const next = appendTaskToCanonicalPlan(existingPlan, {
    title,
    description: rawDescription || undefined,
    acceptanceCriteria: payload.acceptanceCriteria,
    implementerAgentId: payload.implementerAgentId,
    status: "todo",
  });

  await state.writeCurrentTaskPlan(next.plan);

  // Maintain legacy assignment sidecar for backward compatibility.
  if (payload.implementerAgentId?.trim()) {
    await state.setTaskAgent(next.taskId, payload.implementerAgentId.trim());
  }

  return { taskId: next.taskId };
}

export async function patchTask(
  projectRoot: string,
  taskId: string,
  payload: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string[];
    criteria?: string;
    implementerAgentId?: string;
    status?: TaskStatus;
  },
): Promise<void> {
  if (
    payload.title === undefined
    && payload.description === undefined
    && payload.acceptanceCriteria === undefined
    && payload.criteria === undefined
    && payload.implementerAgentId === undefined
    && payload.status === undefined
  ) {
    throw new TasksServiceError(400, "No task fields provided");
  }

  const id = normalizeTaskIdInput(taskId);
  const state = new StateManager(projectRoot);
  const plan = await state.readCurrentTaskPlan();
  if (!plan || plan.tasks.length === 0) {
    throw new TasksServiceError(400, "No current task plan found");
  }

  const byId = asTaskMap(plan.tasks);
  const target = byId[id];
  if (!target) {
    throw new TasksServiceError(404, `Task ${id} not found`);
  }

  const nextAcceptanceCriteria = payload.acceptanceCriteria !== undefined
    ? normalizeAcceptanceCriteria(payload.acceptanceCriteria)
    : payload.criteria !== undefined
      ? normalizeAcceptanceCriteria(payload.criteria)
      : target.acceptanceCriteria;

  const nextAgentId = payload.implementerAgentId !== undefined
    ? (payload.implementerAgentId.trim() || "implementer")
    : target.implementerAgentId;

  const nextStatus = normalizeStatus(payload.status) ?? target.status;

  const updatedTasks = plan.tasks.map((task) => {
    if (task.id !== id) return task;
    return {
      ...task,
      title: payload.title !== undefined ? payload.title.trim() : task.title,
      description: payload.description !== undefined ? payload.description.trim() : task.description,
      acceptanceCriteria: nextAcceptanceCriteria,
      implementerAgentId: nextAgentId,
      status: nextStatus,
    };
  });

  await state.writeCurrentTaskPlan({
    ...plan,
    generatedAt: new Date().toISOString(),
    tasks: updatedTasks,
  });

  await state.setTaskAgent(id, nextAgentId === "implementer" ? null : nextAgentId);
}

export async function deleteTask(
  projectRoot: string,
  taskId: string,
  _cascadeDependents: boolean,
): Promise<string[]> {
  const id = normalizeTaskIdInput(taskId);
  const state = new StateManager(projectRoot);
  const plan = await state.readCurrentTaskPlan();
  if (!plan || plan.tasks.length === 0) {
    throw new TasksServiceError(400, "No current task plan found");
  }

  const target = plan.tasks.find((t) => t.id === id);
  if (!target) {
    throw new TasksServiceError(404, `Task ${id} not found`);
  }

  await state.writeCurrentTaskPlan({
    ...plan,
    generatedAt: new Date().toISOString(),
    tasks: plan.tasks.filter((task) => task.id !== id),
  });

  await state.setTaskAgent(id, null);
  await state.setTaskGitHubLink(id, null);

  return [id];
}
