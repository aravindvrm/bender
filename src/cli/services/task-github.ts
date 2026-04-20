import { GitOperations } from "../../git/operations.js";
import { StateManager, type TaskGitHubLink } from "../../state/manager.js";
import { normalizeTaskId, type CanonicalTaskPlanTask } from "../../state/task-plan.js";
import { parseGitHubRepoFullName, taskSlugFromTitle } from "./github-utils.js";

interface GitHubSession {
  accessToken: string;
}

interface TaskGitHubDeps {
  readGitHubSession: () => Promise<GitHubSession | null>;
  githubApi: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

export class TaskGitHubServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireTaskId(taskId: string): string {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) {
    throw new TaskGitHubServiceError(400, "taskId must be in format task-N or numeric legacy format");
  }
  return normalizedTaskId;
}

function taskDetailsBody(task: CanonicalTaskPlanTask): string {
  const criteriaLines = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria.map((entry) => `  - ${entry}`)
    : ["  - Task implemented and tests pass"];
  return [
    `- **Description**: ${task.description}`,
    `- **Status**: ${task.status}`,
    `- **Implementer Agent**: ${task.implementerAgentId}`,
    "- **Acceptance criteria**:",
    ...criteriaLines,
  ].join("\n");
}

async function requireTaskFromPlan(state: StateManager, taskId: string): Promise<CanonicalTaskPlanTask> {
  const plan = await state.readCurrentTaskPlan();
  if (!plan || plan.tasks.length === 0) {
    throw new TaskGitHubServiceError(400, "No current task plan found");
  }
  const task = plan.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new TaskGitHubServiceError(404, `Task ${taskId} not found`);
  }
  return task;
}

async function resolveRepoFullName(projectRoot: string, explicit: string | undefined): Promise<string | undefined> {
  const normalized = explicit?.trim();
  if (normalized) return normalized;

  const gitOps = new GitOperations(projectRoot);
  if (!(await gitOps.isRepo())) return undefined;
  const remotes = await gitOps.getRemotes();
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin?.fetch) return undefined;
  return parseGitHubRepoFullName(origin.fetch) ?? undefined;
}

export async function createTaskIssue(
  projectRoot: string,
  taskId: string,
  payload: { repoFullName?: string },
  deps: TaskGitHubDeps,
): Promise<{ issueNumber: number; issueUrl: string; link: TaskGitHubLink | null }> {
  const normalizedTaskId = requireTaskId(taskId);
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TaskGitHubServiceError(400, "Project is not initialized");
  }

  const session = await deps.readGitHubSession();
  if (!session?.accessToken) {
    throw new TaskGitHubServiceError(401, "Not connected to GitHub");
  }

  const task = await requireTaskFromPlan(state, normalizedTaskId);
  const existingLink = await state.getTaskGitHubLink(normalizedTaskId);
  const repoFullName = await resolveRepoFullName(projectRoot, payload.repoFullName || existingLink?.repoFullName);
  if (!repoFullName) {
    throw new TaskGitHubServiceError(400, "Set linked repo first (task link repoFullName or origin remote).");
  }

  const issue = await deps.githubApi<{ number: number; html_url: string }>(
    `/repos/${repoFullName}/issues`,
    session.accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Task ${task.id}: ${task.title}`,
        body: [
          "Created from Bender task plan.",
          "",
          `Task ID: ${task.id}`,
          "",
          task.description.trim(),
        ].join("\n"),
      }),
    },
  );

  await state.setTaskGitHubLink(normalizedTaskId, {
    ...existingLink,
    repoFullName,
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    lastSyncedAt: Date.now(),
  });

  return {
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    link: await state.getTaskGitHubLink(normalizedTaskId),
  };
}

export async function createTaskBranch(
  projectRoot: string,
  taskId: string,
  payload: { branchName?: string },
): Promise<{ branchName: string; created: boolean; link: TaskGitHubLink | null }> {
  const normalizedTaskId = requireTaskId(taskId);
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TaskGitHubServiceError(400, "Project is not initialized");
  }

  const task = await requireTaskFromPlan(state, normalizedTaskId);
  const gitOps = new GitOperations(projectRoot);
  if (!(await gitOps.isRepo())) {
    throw new TaskGitHubServiceError(400, "Not a git repository");
  }

  const existingLink = await state.getTaskGitHubLink(normalizedTaskId);
  const requestedBranch = payload.branchName?.trim();
  const slug = taskSlugFromTitle(task.title);
  const branchName = requestedBranch || existingLink?.branchName || `task/${task.id}-${slug || "work"}`;

  const branches = await gitOps.getBranches();
  const exists = branches.all.includes(branchName);
  await gitOps.checkoutBranch(branchName, !exists);

  await state.setTaskGitHubLink(normalizedTaskId, {
    ...existingLink,
    branchName,
    lastSyncedAt: Date.now(),
  });

  return {
    branchName,
    created: !exists,
    link: await state.getTaskGitHubLink(normalizedTaskId),
  };
}

export async function createTaskPr(
  projectRoot: string,
  taskId: string,
  payload: { repoFullName?: string; head?: string; title?: string; base?: string; body?: string },
  deps: TaskGitHubDeps,
): Promise<{ prNumber: number; prUrl: string; link: TaskGitHubLink | null }> {
  const normalizedTaskId = requireTaskId(taskId);
  const session = await deps.readGitHubSession();
  if (!session?.accessToken) {
    throw new TaskGitHubServiceError(401, "Not connected to GitHub");
  }

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TaskGitHubServiceError(400, "Project is not initialized");
  }

  const existingLink = await state.getTaskGitHubLink(normalizedTaskId);
  const repoFullName = (payload.repoFullName?.trim() || existingLink?.repoFullName);
  const head = (payload.head?.trim() || existingLink?.branchName);

  if (!repoFullName) {
    throw new TaskGitHubServiceError(400, "linked repo is required (repoFullName).");
  }
  if (!head) {
    throw new TaskGitHubServiceError(400, "linked branch is required (branchName).");
  }

  const task = await requireTaskFromPlan(state, normalizedTaskId);
  const title = payload.title?.trim() || `Task ${task.id}: ${task.title}`;
  const base = payload.base?.trim() || "main";
  const bodyText = payload.body?.trim() || taskDetailsBody(task);

  const pr = await deps.githubApi<{ number: number; html_url: string }>(
    `/repos/${repoFullName}/pulls`,
    session.accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, head, base, body: bodyText }),
    },
  );

  await state.setTaskGitHubLink(normalizedTaskId, {
    ...existingLink,
    repoFullName,
    branchName: head,
    prNumber: pr.number,
    prUrl: pr.html_url,
    lastSyncedAt: Date.now(),
  });

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    link: await state.getTaskGitHubLink(normalizedTaskId),
  };
}

export async function commentTaskPr(
  projectRoot: string,
  taskId: string,
  payload: { body?: string; repoFullName?: string; prNumber?: number },
  deps: TaskGitHubDeps,
): Promise<{ commentUrl: string; link: TaskGitHubLink | null }> {
  const normalizedTaskId = requireTaskId(taskId);
  const session = await deps.readGitHubSession();
  if (!session?.accessToken) {
    throw new TaskGitHubServiceError(401, "Not connected to GitHub");
  }

  const commentBody = payload.body?.trim();
  if (!commentBody) {
    throw new TaskGitHubServiceError(400, "comment body is required");
  }

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    throw new TaskGitHubServiceError(400, "Project is not initialized");
  }

  const existingLink = await state.getTaskGitHubLink(normalizedTaskId);
  const repoFullName = payload.repoFullName?.trim() || existingLink?.repoFullName;
  const issueNumber = payload.prNumber ?? existingLink?.prNumber;
  if (!repoFullName) {
    throw new TaskGitHubServiceError(400, "linked repo is required (repoFullName).");
  }
  if (!issueNumber) {
    throw new TaskGitHubServiceError(400, "linked PR number is required (prNumber).");
  }

  const comment = await deps.githubApi<{ html_url: string }>(
    `/repos/${repoFullName}/issues/${issueNumber}/comments`,
    session.accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: commentBody }),
    },
  );

  await state.setTaskGitHubLink(normalizedTaskId, {
    ...existingLink,
    repoFullName,
    prNumber: issueNumber,
    lastSyncedAt: Date.now(),
  });

  return {
    commentUrl: comment.html_url,
    link: await state.getTaskGitHubLink(normalizedTaskId),
  };
}
