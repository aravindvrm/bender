import { readEffectiveConfig } from "../../state/config.js";
import { StateManager, type TaskGitHubLink } from "../../state/manager.js";
import { GitOperations } from "../../git/operations.js";
import { taskSlugFromTitle, parseGitHubRepoFullName } from "./github-utils.js";

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
    const gitOps = new GitOperations(projectRoot);
    if (await gitOps.isRepo()) {
      const branch = await gitOps.getCurrentBranch();
      const clean = !(await gitOps.hasChanges());
      const recentCommits = await gitOps.log(5);
      git = { branch, clean, recentCommits };
      const remotes = await gitOps.getRemotes();
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
