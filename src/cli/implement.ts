import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForTier } from "../llm/provider.js";
import { implementTask, type TaskDescription, type FileOperation } from "../roles/implementer.js";
import { reviewCode, type ReviewResult } from "../roles/reviewer.js";
import { GitOperations } from "../git/operations.js";
import { runTests, runTypeCheck } from "../test/runner.js";
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { analyzeCommand } from "./analyze.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";
import { getAllAgents, getEffectiveAgentForRole, type AgentConfig } from "../state/agents.js";
import { readEffectiveConfig, type BenderConfig } from "../state/config.js";
import { createLogger, makeAdapterSink, toLoggerOptions, type Logger } from "../logger.js";
import type { ModelSet } from "../llm/provider.js";
import type { ProjectContext } from "../state/manager.js";

/** Keywords that indicate a task is "major" (architectural, schema-level changes). */
const MAJOR_TASK_KEYWORDS = [
  "schema", "migration", "database", "table", "model",
  "auth", "authentication", "authorization", "permission", "role",
  "api", "route", "endpoint", "controller",
  "refactor", "restructure", "architecture",
  "deploy", "infrastructure", "config", "environment",
];

/**
 * Returns true if a task likely causes architectural or structural changes
 * that would benefit from re-analysis.
 */
export function isMajorTask(task: TaskDescription): boolean {
  const text = `${task.title} ${task.description}`.toLowerCase();
  return MAJOR_TASK_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Check if auto-reanalyze should run and trigger it if so.
 * Increments the counter; resets and runs analysis when threshold is reached.
 */
export async function maybeAutoReanalyze(
  projectRoot: string,
  config: BenderConfig,
  task: TaskDescription,
  adapter: UIAdapter,
): Promise<void> {
  const reanalyzeCfg = config.reanalyze ?? {};
  if (reanalyzeCfg.enabled === false) return;
  if (!isMajorTask(task)) return;

  const state = new StateManager(projectRoot);
  const threshold = reanalyzeCfg.threshold ?? 3;
  const count = await state.incrementReanalyzeCounter();

  if (count >= threshold) {
    await state.resetReanalyzeCounter();
    adapter.info(`[Auto] Re-analyzing architecture after ${count} major task(s)...`);
    try {
      await analyzeCommand(projectRoot, adapter);
    } catch (err) {
      adapter.warn(`Auto re-analysis failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Parse a task plan markdown into structured task descriptions.
 */
export function parseTaskPlan(planMarkdown: string): TaskDescription[] {
  const tasks: TaskDescription[] = [];
  const taskPattern = /###\s*Task\s*(\d+):\s*(.+?)\n([\s\S]*?)(?=\n###\s*Task|\n##\s|$)/g;

  let match: RegExpExecArray | null;
  while ((match = taskPattern.exec(planMarkdown)) !== null) {
    const id = parseInt(match[1], 10);
    const title = match[2].trim();
    const body = match[3];

    const descMatch = body.match(/\*\*Description\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0];

    const files: string[] = [];
    const filesSection = body.match(/\*\*Files to create\/modify\*\*:\s*\n([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    if (filesSection) {
      const fileLines = filesSection[1].match(/`([^`]+)`/g);
      if (fileLines) {
        files.push(...fileLines.map((f) => f.replace(/`/g, "").split(" — ")[0].trim()));
      }
    }

    const criteriaMatch = body.match(/\*\*Acceptance criteria\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const acceptanceCriteria = criteriaMatch ? criteriaMatch[1].trim() : "Task implemented and tests pass";

    tasks.push({ id, title, description, files, acceptanceCriteria });
  }

  return tasks;
}

/**
 * Write file operations to disk.
 */
async function applyFileOperations(projectRoot: string, operations: FileOperation[]): Promise<void> {
  for (const op of operations) {
    const fullPath = join(projectRoot, op.path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, op.content + "\n", "utf-8");
  }
}

function printReviewSummary(adapter: UIAdapter, review: ReviewResult): void {
  const statusColor = review.status === "APPROVED"
    ? adapter.success.bind(adapter)
    : review.status === "NEEDS_CHANGES"
      ? adapter.warn.bind(adapter)
      : adapter.error.bind(adapter);

  statusColor(`Reviewer status: ${review.status}`);

  if (review.issues.length > 0) {
    adapter.warn(`Reviewer found ${review.issues.length} issue(s):`);
    for (const issue of review.issues) {
      const location = issue.file ? ` [${issue.file}]` : "";
      adapter.warn(`- ${issue.severity.toUpperCase()}${location}: ${issue.description}`);
      if (issue.fix) {
        adapter.info(`  Fix: ${issue.fix}`);
      }
    }
  } else {
    adapter.info("Reviewer provided no structured issues.");
  }

  if (review.observations.length > 0) {
    adapter.info("Reviewer observations:");
    for (const obs of review.observations) {
      adapter.info(`- ${obs}`);
    }
  }
}

async function runReviewerGate(
  projectRoot: string,
  config: BenderConfig,
  models: ModelSet,
  task: TaskDescription,
  fileOps: FileOperation[],
  context: ProjectContext,
  adapter: UIAdapter,
  reviewerAgent: AgentConfig,
  logger: Logger,
): Promise<boolean> {
  adapter.subheader("Reviewer Gate");
  adapter.info(`Using reviewer agent: ${reviewerAgent.name} (${reviewerAgent.modelTier})`);

  const reviewerModel = getModelForTier(models, reviewerAgent.modelTier);
  let reviewerRuntime: RoleRuntime;
  try {
    reviewerRuntime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "reviewer",
        taskDescription: `${task.title}\n${task.description}`,
        pinnedSkills: reviewerAgent.pinnedSkills,
        mcpServerIds: reviewerAgent.mcpServerIds,
        capabilityPolicy: reviewerAgent.capabilityPolicy,
        modelTier: reviewerAgent.modelTier,
      },
      context.architecture ?? undefined,
      logger,
    );
  } catch (err: unknown) {
    adapter.error(`Failed to initialize reviewer runtime: ${(err as Error).message}`);
    return false;
  }

  try {
    const spin = adapter.spinner("Running reviewer checks...");
    spin.start();
    let review: ReviewResult;
    try {
      review = await reviewCode(
        reviewerModel,
        task.title,
        fileOps,
        context,
        reviewerRuntime,
      );
    } catch (err: unknown) {
      spin.fail(`Reviewer failed: ${(err as Error).message}`);
      return false;
    }
    spin.stop();
    printReviewSummary(adapter, review);

    if (review.status === "APPROVED") {
      return true;
    }

    const proceed = await adapter.confirm(
      `Reviewer returned ${review.status}. Continue with these changes anyway?`,
      false,
    );
    if (!proceed) {
      adapter.info("Skipped based on reviewer feedback.");
      return false;
    }
    return true;
  } finally {
    await reviewerRuntime.close();
  }
}

async function ensureTaskBranch(
  state: StateManager,
  git: GitOperations,
  task: TaskDescription,
  adapter: UIAdapter,
): Promise<void> {
  if (!(await git.isRepo())) return;
  const link = await state.getTaskGitHubLink(String(task.id));
  const branchName = link?.branchName?.trim();
  if (!branchName) return;

  const branches = await git.getBranches();
  const exists = branches.all.includes(branchName);
  await git.checkoutBranch(branchName, !exists);
  adapter.info(`${exists ? "Switched to" : "Created and switched to"} branch: ${branchName}`);
}

export async function implementSingleTask(projectRoot: string, taskId: number, adapter: UIAdapter = terminalAdapter): Promise<void> {
  adapter.header(`Bender Implement — Task ${taskId}`);

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    adapter.error("No .bender/ directory found. Run `bender init` first.");
    adapter.cleanup();
    return;
  }

  const config = await readEffectiveConfig(projectRoot);
  const logger = createLogger(
    "implement",
    projectRoot,
    makeAdapterSink(adapter),
    toLoggerOptions(config.logging),
  );
  logger.info("Starting task implementation", { taskId });
  const currentTasks = await state.readCurrentTasks();

  if (!currentTasks) {
    adapter.error("No task plan found. Run `bender plan` first.");
    adapter.cleanup();
    return;
  }

  const tasks = parseTaskPlan(currentTasks);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    adapter.error(`Task ${taskId} not found in the current plan.`);
    adapter.cleanup();
    return;
  }

  adapter.subheader(`Task ${task.id}: ${task.title}`);
  adapter.info(task.description);

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    adapter.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  const taskAgents = await state.readTaskAgents();
  const allAgents = await getAllAgents();
  const defaultAgent = await getEffectiveAgentForRole("implementer");
  const assignedAgentId = taskAgents[String(task.id)];
  const assignedAgent = assignedAgentId
    ? allAgents.find((a) => a.id === assignedAgentId && a.baseRole === "implementer")
    : null;
  if (assignedAgentId && !assignedAgent) {
    adapter.warn(`Assigned agent '${assignedAgentId}' not found. Falling back to ${defaultAgent.name}.`);
  }
  const agent: AgentConfig = assignedAgent ?? defaultAgent;
  const reviewerAgent = await getEffectiveAgentForRole("reviewer");
  const implementerModel = getModelForTier(models, agent.modelTier);
  const git = new GitOperations(projectRoot);
  const gitEnabled = await git.isRepo();
  if (gitEnabled) {
    await ensureTaskBranch(state, git, task, adapter);
  }

  let runtime: RoleRuntime;
  try {
    runtime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "implementer",
        taskDescription: task.description,
        pinnedSkills: agent.pinnedSkills,
        mcpServerIds: agent.mcpServerIds,
        capabilityPolicy: agent.capabilityPolicy,
        modelTier: agent.modelTier,
      },
      undefined,
      logger,
    );
  } catch (err: unknown) {
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  try {
    const context = await state.gatherContext();
    adapter.info(`Using agent: ${agent.name} (${agent.modelTier})`);
    const spin = adapter.spinner(`Implementing task ${task.id}...`);
    spin.start();

    let fileOps: FileOperation[];
    try {
      fileOps = await implementTask(implementerModel, task, projectRoot, context, (_chunk) => {
        spin.text = `Implementing task ${task.id}... (generating)`;
      }, runtime);
    } catch (err: unknown) {
      spin.fail(`Task ${task.id} failed: ${(err as Error).message}`);
      adapter.cleanup();
      return;
    }

    spin.succeed(`Generated ${fileOps.length} files`);

    if (fileOps.length === 0) {
      adapter.warn("No file operations produced.");
      adapter.cleanup();
      return;
    }

    const reviewPassed = await runReviewerGate(
      projectRoot,
      config,
      models,
      task,
      fileOps,
      context,
      adapter,
      reviewerAgent,
      logger.child("reviewer"),
    );
    if (!reviewPassed) {
      adapter.cleanup();
      return;
    }

    adapter.showFileOperations(fileOps.map((op) => ({ path: op.path, action: op.action })));

    const approved = await adapter.confirm("Apply these changes?");
    if (!approved) {
      adapter.info("Skipped.");
      adapter.cleanup();
      return;
    }

    await applyFileOperations(projectRoot, fileOps);
    adapter.success("Files written.");

    const typeResult = await runTypeCheck(projectRoot);
    if (!typeResult.passed) {
      adapter.warn(`Type check failed: ${typeResult.error}`);
    }

    const testResult = await runTests(projectRoot, config);
    if (testResult.passed) {
      adapter.success(`Tests passed (${testResult.command})`);
    } else {
      adapter.warn(`Tests failed (${testResult.command}): ${testResult.error?.slice(0, 200)}`);
    }

    if (gitEnabled && await git.hasChanges()) {
      try {
        await git.commitAll(`feat: task ${task.id} — ${task.title}`);
        adapter.success(`Committed: task ${task.id} — ${task.title}`);
      } catch (err) {
        adapter.warn(`Git commit skipped: ${(err as Error).message}`);
      }
    }

    await state.completeTask(
      String(task.id),
      `# Task ${task.id}: ${task.title}\n\nCompleted: ${new Date().toISOString()}\n\nFiles: ${fileOps.map((op) => op.path).join(", ")}`,
    );

    logger.info("Task completed", {
      taskId: task.id,
      title: task.title,
      filesWritten: fileOps.length,
      files: fileOps.map((op) => op.path),
    });
    adapter.success(`Task ${task.id} complete.`);

    // Auto re-analyze if threshold reached
    await maybeAutoReanalyze(projectRoot, config, task, adapter);
  } finally {
    await runtime.close();
  }

  adapter.cleanup();
}

export async function implementCommand(projectRoot: string, adapter: UIAdapter = terminalAdapter): Promise<void> {
  adapter.header("Bender Implement — Executing Task Plan");

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    adapter.error("No .bender/ directory found. Run `bender init` first.");
    adapter.cleanup();
    return;
  }

  const config = await readEffectiveConfig(projectRoot);
  const logger = createLogger(
    "implement",
    projectRoot,
    makeAdapterSink(adapter),
    toLoggerOptions(config.logging),
  );
  const currentTasks = await state.readCurrentTasks();

  if (!currentTasks) {
    adapter.error("No task plan found. Run `bender plan` or `bender init` first.");
    adapter.cleanup();
    return;
  }

  const tasks = parseTaskPlan(currentTasks);
  if (tasks.length === 0) {
    adapter.error("Could not parse any tasks from the plan. Check .bender/tasks/current.md format.");
    adapter.cleanup();
    return;
  }

  adapter.info(`Found ${tasks.length} tasks to implement.\n`);

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    adapter.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  const git = new GitOperations(projectRoot);
  let gitEnabled = await git.isRepo();
  if (!gitEnabled) {
    adapter.warn("No git repository detected for this project.");
    const shouldInitGit = await adapter.confirm("Initialize a git repository now?", true);
    if (shouldInitGit) {
      await git.init();
      gitEnabled = true;
      adapter.success("Initialized git repository.");
    } else {
      adapter.info("Continuing without git commits.");
    }
  }
  const taskAgents = await state.readTaskAgents();
  const allAgents = await getAllAgents();
  const defaultAgent = await getEffectiveAgentForRole("implementer");
  const reviewerAgent = await getEffectiveAgentForRole("reviewer");
  const completedTaskSummaries: string[] = [];
  for (const task of tasks) {
    if (gitEnabled) {
      await ensureTaskBranch(state, git, task, adapter);
    }
    const assignedAgentId = taskAgents[String(task.id)];
    const assignedAgent = assignedAgentId
      ? allAgents.find((a) => a.id === assignedAgentId && a.baseRole === "implementer")
      : null;
    if (assignedAgentId && !assignedAgent) {
      adapter.warn(`Task ${task.id} assigned agent '${assignedAgentId}' not found. Falling back to ${defaultAgent.name}.`);
    }
    const agent: AgentConfig = assignedAgent ?? defaultAgent;
    const implementerModel = getModelForTier(models, agent.modelTier);
    let runtime: RoleRuntime;
    try {
      runtime = await createRoleRuntime(
        projectRoot,
        config,
        {
          role: "implementer",
          taskDescription: task.description,
          pinnedSkills: agent.pinnedSkills,
          mcpServerIds: agent.mcpServerIds,
          capabilityPolicy: agent.capabilityPolicy,
          modelTier: agent.modelTier,
        },
        undefined,
        logger,
      );
    } catch (err: unknown) {
      adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
      adapter.cleanup();
      return;
    }

    adapter.subheader(`Task ${task.id}: ${task.title}`);
    adapter.info(task.description);
    adapter.info(`Using agent: ${agent.name} (${agent.modelTier})`);

    try {
      const context = await state.gatherContext();

      const spin = adapter.spinner(`Implementing task ${task.id}...`);
      spin.start();

      let fileOps: FileOperation[];
      try {
        fileOps = await implementTask(implementerModel, task, projectRoot, context, (_chunk) => {
          spin.text = `Implementing task ${task.id}... (generating)`;
        }, runtime);
      } catch (err: unknown) {
        spin.fail(`Task ${task.id} failed: ${(err as Error).message}`);
        const shouldContinue = await adapter.confirm("Continue with next task?", false);
        if (!shouldContinue) break;
        continue;
      }

      spin.succeed(`Generated ${fileOps.length} files`);

      if (fileOps.length === 0) {
        adapter.warn("No file operations produced. The implementer may have failed to follow the output format.");
        const shouldContinue = await adapter.confirm("Continue with next task?");
        if (!shouldContinue) break;
        continue;
      }

      const reviewPassed = await runReviewerGate(
        projectRoot,
        config,
        models,
        task,
        fileOps,
        context,
        adapter,
        reviewerAgent,
        logger.child("reviewer"),
      );
      if (!reviewPassed) {
        const shouldContinue = await adapter.confirm("Continue with next task?", false);
        if (!shouldContinue) break;
        continue;
      }

      adapter.showFileOperations(fileOps.map((op) => ({ path: op.path, action: op.action })));

      const approved = await adapter.confirm("Apply these changes?");
      if (!approved) {
        adapter.info("Skipping task.");
        const shouldContinue = await adapter.confirm("Continue with next task?");
        if (!shouldContinue) break;
        continue;
      }

      // Write files to disk
      await applyFileOperations(projectRoot, fileOps);
      adapter.success("Files written.");

      // Run type check
      const typeResult = await runTypeCheck(projectRoot);
      if (!typeResult.passed) {
        adapter.warn(`Type check failed: ${typeResult.error}`);
      }

      // Run tests
      const testResult = await runTests(projectRoot, config);
      if (testResult.passed) {
        adapter.success(`Tests passed (${testResult.command})`);
      } else {
        adapter.warn(`Tests failed (${testResult.command}): ${testResult.error?.slice(0, 200)}`);
      }

      // Git commit
      if (gitEnabled && await git.hasChanges()) {
        try {
          await git.commitAll(`feat: task ${task.id} — ${task.title}`);
          adapter.success(`Committed: task ${task.id} — ${task.title}`);
        } catch (err) {
          adapter.warn(`Git commit skipped: ${(err as Error).message}`);
        }
      }

      // Mark task as completed
      await state.completeTask(
        String(task.id),
        `# Task ${task.id}: ${task.title}\n\nCompleted: ${new Date().toISOString()}\n\nFiles: ${fileOps.map((op) => op.path).join(", ")}`,
      );

      completedTaskSummaries.push(`Task ${task.id}: ${task.title}`);
      logger.info("Task completed", {
        taskId: task.id,
        title: task.title,
        filesWritten: fileOps.length,
        testsPassed: testResult.passed,
      });
      // Auto re-analyze if threshold reached
      await maybeAutoReanalyze(projectRoot, config, task, adapter);
    } finally {
      await runtime.close();
    }
  }

  logger.info("Implement session complete", { tasksCompleted: completedTaskSummaries.length });

  // Write session log
  await state.writeSession(
    "implement",
    `# Implement Session\n\nDate: ${new Date().toISOString()}\n\nCompleted tasks:\n${completedTaskSummaries.map((t) => `- ${t}`).join("\n")}\n\nStatus: completed`,
  );

  adapter.header("Implementation Complete");
  adapter.info("Review your changes and run `bender status` to see project state.");
  adapter.cleanup();
}
