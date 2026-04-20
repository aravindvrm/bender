import { readEffectiveConfig } from "../../state/config.js";
import { StateManager, type TaskGitHubLink } from "../../state/manager.js";
import { GitOperations } from "../../git/operations.js";
import { taskSlugFromTitle, parseGitHubRepoFullName } from "./github-utils.js";

const STATE_GIT_TIMEOUT_MS = 3_500;

async function safeGit<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

export async function getProjectState(projectRoot: string): Promise<Record<string, unknown>> {
  const state = new StateManager(projectRoot);

  if (!state.isInitialized()) {
    return { initialized: false, projectRoot };
  }

  const config = await readEffectiveConfig(projectRoot);
  const context = await state.gatherContext();
  const decisions = await state.readDecisions();
  const completedTasks = await state.readCompletedTasks();
  const flows = await state.readFlows();
  const taskAgents = await state.readTaskAgents();
  const taskGitHubLinks = await state.readTaskGitHubLinks();
  const currentTaskPlan = await state.readCurrentTaskPlan();

  let git: {
    branch: string;
    clean: boolean;
    recentCommits: Array<{ hash: string; message: string; date: string }>;
  } | null = null;
  let inferredRepoFullName: string | undefined;

  try {
    const gitOps = new GitOperations(projectRoot, { timeoutMs: STATE_GIT_TIMEOUT_MS });
    if (await gitOps.isRepo()) {
      const branch = await safeGit(() => gitOps.getCurrentBranch(), "HEAD");
      const clean = await safeGit(async () => !(await gitOps.hasChanges(false)), false);
      const recentCommits = await safeGit(() => gitOps.log(5), []);
      git = { branch, clean, recentCommits };
      const remotes = await safeGit(() => gitOps.getRemotes(), []);
      const origin = remotes.find((r) => r.name === "origin");
      if (origin?.fetch) {
        inferredRepoFullName = parseGitHubRepoFullName(origin.fetch) ?? undefined;
      }
    }
  } catch {
    // Not a git repo or git unavailable.
  }

  const mergedTaskGitHubLinks: Record<string, TaskGitHubLink> = { ...taskGitHubLinks };
  for (const task of currentTaskPlan?.tasks ?? []) {
    const key = String(task.id);
    const slug = taskSlugFromTitle(task.title);
    const inferredBranch = `task/${task.id}-${slug || "work"}`;

    if (!mergedTaskGitHubLinks[key]) {
      if (inferredRepoFullName || inferredBranch) {
        mergedTaskGitHubLinks[key] = {
          ...(inferredRepoFullName ? { repoFullName: inferredRepoFullName } : {}),
          ...(inferredBranch ? { branchName: inferredBranch } : {}),
        };
      }
      continue;
    }

    const existing = mergedTaskGitHubLinks[key];
    if (!existing.branchName) {
      existing.branchName = inferredBranch;
    }
    if (!existing.repoFullName && inferredRepoFullName) {
      existing.repoFullName = inferredRepoFullName;
    }
  }

  return {
    initialized: true,
    projectRoot,
    brief: context.brief,
    architecture: context.architecture,
    conventions: context.conventions,
    schema: context.schema,
    decisions,
    currentTasks: context.currentTasks,
    currentTaskPlan,
    completedTasks,
    taskAgents,
    taskGitHubLinks: mergedTaskGitHubLinks,
    apiContracts: context.apiContracts,
    flows,
    config: {
      llm: { provider: config.llm.provider, models: config.llm.models },
      stack: config.stack,
    },
    git,
  };
}

export async function readSessions(projectRoot: string): Promise<{ name: string; operation: string; date: string; content: string }[]> {
  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    return [];
  }
  return await state.readSessions();
}
