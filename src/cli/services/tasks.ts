import { getAllAgents } from "../../state/agents.js";
import { type TaskGitHubLink, StateManager } from "../../state/manager.js";
import { appendTaskToCanonicalPlan } from "../../state/task-plan.js";

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

function normalizeTaskId(taskId: string): string {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId || !/^\d+$/.test(normalizedTaskId)) {
    throw new TasksServiceError(400, "taskId must be numeric");
  }
  return normalizedTaskId;
}

function parseDependencyIds(depStr: string): number[] {
  if (!depStr || depStr.trim().toLowerCase() === "none") return [];
  const matches = depStr.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

function requireTaskId(taskId: string): number {
  const id = Number(taskId);
  if (!Number.isFinite(id)) {
    throw new TasksServiceError(400, "taskId must be numeric");
  }
  return id;
}

export async function readTaskAgents(projectRoot: string): Promise<Record<string, string>> {
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    return {};
  }
  return await state.readTaskAgents();
}

export async function setTaskAgent(
  projectRoot: string,
  taskId: string,
  agentId?: string | null,
): Promise<Record<string, string>> {
  const normalizedTaskId = normalizeTaskId(taskId);
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : null;

  if (normalizedAgentId) {
    const allAgents = await getAllAgents();
    const selected = allAgents.find((a) => a.id === normalizedAgentId);
    if (!selected) {
      throw new TasksServiceError(400, `Unknown agent: ${normalizedAgentId}`);
    }
    if (selected.baseRole !== "implementer") {
      throw new TasksServiceError(400, `Agent ${normalizedAgentId} is not an implementer agent`);
    }
  }

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TasksServiceError(400, "Project is not initialized");
  }

  await state.setTaskAgent(normalizedTaskId, normalizedAgentId || null);
  return await state.readTaskAgents();
}

export async function readTaskLinks(projectRoot: string): Promise<Record<string, TaskGitHubLink>> {
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    return {};
  }
  return await state.readTaskGitHubLinks();
}

export async function setTaskLink(
  projectRoot: string,
  taskId: string,
  payload: Partial<TaskGitHubLink> & { clear?: boolean },
): Promise<{ links: Record<string, TaskGitHubLink>; link: TaskGitHubLink | null }> {
  const normalizedTaskId = normalizeTaskId(taskId);
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

  const links = await state.readTaskGitHubLinks();
  return { links, link: links[normalizedTaskId] ?? null };
}

export async function appendTask(
  projectRoot: string,
  payload: { title?: string; description?: string; files?: string[] },
): Promise<{ taskId: number }> {
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
    files: payload.files,
  });
  await state.writeCurrentTaskPlan(next.plan);
  return { taskId: next.taskId };
}

export async function patchTask(
  projectRoot: string,
  taskId: string,
  payload: {
    title?: string;
    description?: string;
    dependencies?: string;
    criteria?: string;
  },
): Promise<void> {
  if (
    payload.title === undefined
    && payload.description === undefined
    && payload.dependencies === undefined
    && payload.criteria === undefined
  ) {
    throw new TasksServiceError(400, "No task fields provided");
  }

  const id = requireTaskId(taskId);
  const state = new StateManager(projectRoot);
  const plan = await state.readCurrentTaskPlan();
  if (!plan || plan.tasks.length === 0) {
    throw new TasksServiceError(400, "No current task plan found");
  }

  const target = plan.tasks.find((t) => t.id === id);
  if (!target) {
    throw new TasksServiceError(404, `Task ${id} not found`);
  }

  const updatedTasks = plan.tasks.map((task) => {
    if (task.id !== id) return task;
    return {
      ...task,
      title: payload.title !== undefined ? payload.title.trim() : task.title,
      description: payload.description !== undefined ? payload.description.trim() : task.description,
      dependencies: payload.dependencies !== undefined ? (payload.dependencies.trim() || "None") : task.dependencies,
      acceptanceCriteria: payload.criteria !== undefined
        ? (payload.criteria.trim() || "Task implemented and tests pass")
        : task.acceptanceCriteria,
    };
  });

  await state.writeCurrentTaskPlan({
    ...plan,
    generatedAt: new Date().toISOString(),
    tasks: updatedTasks,
  });
}

export async function deleteTask(
  projectRoot: string,
  taskId: string,
  cascadeDependents: boolean,
): Promise<number[]> {
  const id = requireTaskId(taskId);
  const state = new StateManager(projectRoot);
  const plan = await state.readCurrentTaskPlan();
  if (!plan || plan.tasks.length === 0) {
    throw new TasksServiceError(400, "No current task plan found");
  }

  const target = plan.tasks.find((t) => t.id === id);
  if (!target) {
    throw new TasksServiceError(404, `Task ${id} not found`);
  }

  const idsToDelete = new Set<number>([id]);
  if (cascadeDependents) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of plan.tasks) {
        if (idsToDelete.has(task.id)) continue;
        const deps = parseDependencyIds(task.dependencies);
        if (deps.some((depId) => idsToDelete.has(depId))) {
          idsToDelete.add(task.id);
          changed = true;
        }
      }
    }
  }

  await state.writeCurrentTaskPlan({
    ...plan,
    generatedAt: new Date().toISOString(),
    tasks: plan.tasks.filter((task) => !idsToDelete.has(task.id)),
  });

  const taskAgents = await state.readTaskAgents();
  let changedAssignments = false;
  for (const deletedId of idsToDelete) {
    const key = String(deletedId);
    if (taskAgents[key]) {
      delete taskAgents[key];
      changedAssignments = true;
    }
  }
  if (changedAssignments) {
    await state.writeTaskAgents(taskAgents);
  }

  const taskGitHubLinks = await state.readTaskGitHubLinks();
  let changedLinks = false;
  for (const deletedId of idsToDelete) {
    const key = String(deletedId);
    if (taskGitHubLinks[key]) {
      delete taskGitHubLinks[key];
      changedLinks = true;
    }
  }
  if (changedLinks) {
    await state.writeTaskGitHubLinks(taskGitHubLinks);
  }

  return Array.from(idsToDelete).sort((a, b) => a - b);
}
