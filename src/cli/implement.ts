import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { readEffectiveConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForRole } from "../llm/provider.js";
import { implementTask, type TaskDescription, type FileOperation } from "../roles/implementer.js";
import { GitOperations } from "../git/operations.js";
import { runTests, runTypeCheck } from "../test/runner.js";
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";

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

export async function implementSingleTask(projectRoot: string, taskId: number, adapter: UIAdapter = terminalAdapter): Promise<void> {
  adapter.header(`Bender Implement — Task ${taskId}`);

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    adapter.error("No .bender/ directory found. Run `bender init` first.");
    adapter.cleanup();
    return;
  }

  const config = await readEffectiveConfig(projectRoot);
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

  const implementerModel = getModelForRole(models, "implementer");
  const git = new GitOperations(projectRoot);
  const gitEnabled = await git.isRepo();

  let runtime: RoleRuntime;
  try {
    runtime = await createRoleRuntime(projectRoot, config, {
      info: (msg) => adapter.info(msg),
      warn: (msg) => adapter.warn(msg),
    });
  } catch (err: unknown) {
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

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
      adapter.cleanup();
      return;
    }

    spin.succeed(`Generated ${fileOps.length} files`);

    if (fileOps.length === 0) {
      adapter.warn("No file operations produced.");
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

    adapter.success(`Task ${task.id} complete.`);
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

  const implementerModel = getModelForRole(models, "implementer");
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
  const completedTaskSummaries: string[] = [];
  let runtime: RoleRuntime;
  try {
    runtime = await createRoleRuntime(projectRoot, config, {
      info: (msg) => adapter.info(msg),
      warn: (msg) => adapter.warn(msg),
    });
  } catch (err: unknown) {
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  try {
    for (const task of tasks) {
      adapter.subheader(`Task ${task.id}: ${task.title}`);
      adapter.info(task.description);

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
    }
  } finally {
    await runtime.close();
  }

  // Write session log
  await state.writeSession(
    "implement",
    `# Implement Session\n\nDate: ${new Date().toISOString()}\n\nCompleted tasks:\n${completedTaskSummaries.map((t) => `- ${t}`).join("\n")}\n\nStatus: completed`,
  );

  adapter.header("Implementation Complete");
  adapter.info("Review your changes and run `bender status` to see project state.");
  adapter.cleanup();
}
