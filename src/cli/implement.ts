import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { readConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForRole } from "../llm/provider.js";
import { implementTask, type TaskDescription, type FileOperation } from "../roles/implementer.js";
import { reviewCode } from "../roles/reviewer.js";
import { GitOperations } from "../git/operations.js";
import { runTests, runTypeCheck } from "../test/runner.js";
import * as ui from "./ui.js";

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

    // Extract description
    const descMatch = body.match(/\*\*Description\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0];

    // Extract files
    const files: string[] = [];
    const filesSection = body.match(/\*\*Files to create\/modify\*\*:\s*\n([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    if (filesSection) {
      const fileLines = filesSection[1].match(/`([^`]+)`/g);
      if (fileLines) {
        files.push(...fileLines.map((f) => f.replace(/`/g, "").split(" — ")[0].trim()));
      }
    }

    // Extract acceptance criteria
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

export async function implementCommand(projectRoot: string): Promise<void> {
  ui.header("Bender Implement — Executing Task Plan");

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    ui.error("No .bender/ directory found. Run `bender init` first.");
    ui.cleanup();
    return;
  }

  const config = await readConfig(projectRoot);
  const currentTasks = await state.readCurrentTasks();

  if (!currentTasks) {
    ui.error("No task plan found. Run `bender plan` or `bender init` first.");
    ui.cleanup();
    return;
  }

  const tasks = parseTaskPlan(currentTasks);
  if (tasks.length === 0) {
    ui.error("Could not parse any tasks from the plan. Check .bender/tasks/current.md format.");
    ui.cleanup();
    return;
  }

  ui.info(`Found ${tasks.length} tasks to implement.\n`);

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    ui.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    ui.cleanup();
    return;
  }

  const implementerModel = getModelForRole(models, "implementer");
  const reviewerModel = getModelForRole(models, "reviewer");
  const git = new GitOperations(projectRoot);

  for (const task of tasks) {
    ui.subheader(`Task ${task.id}: ${task.title}`);
    ui.info(task.description);
    console.log();

    // Gather fresh context for each task (includes completed work)
    const context = await state.gatherContext();

    // Implement
    const spin = ui.spinner(`Implementing task ${task.id}...`);
    spin.start();

    let fileOps: FileOperation[];
    try {
      fileOps = await implementTask(implementerModel, task, projectRoot, context, (chunk) => {
        spin.text = `Implementing task ${task.id}... (generating)`;
      });
    } catch (err: unknown) {
      spin.fail(`Task ${task.id} failed: ${(err as Error).message}`);
      const shouldContinue = await ui.confirm("Continue with next task?", false);
      if (!shouldContinue) break;
      continue;
    }

    spin.succeed(`Generated ${fileOps.length} files`);

    if (fileOps.length === 0) {
      ui.warn("No file operations produced. The implementer may have failed to follow the output format.");
      const shouldContinue = await ui.confirm("Continue with next task?");
      if (!shouldContinue) break;
      continue;
    }

    // Show file operations summary
    ui.showFileOperations(fileOps.map((op) => ({ path: op.path, action: op.action })));
    console.log();

    // Ask for approval before writing
    const approved = await ui.confirm("Apply these changes?");
    if (!approved) {
      ui.info("Skipping task.");
      const shouldContinue = await ui.confirm("Continue with next task?");
      if (!shouldContinue) break;
      continue;
    }

    // Write files to disk
    await applyFileOperations(projectRoot, fileOps);
    ui.success("Files written.");

    // Run type check
    const typeResult = await runTypeCheck(projectRoot);
    if (!typeResult.passed) {
      ui.warn("Type check failed:");
      console.log(typeResult.error);
    }

    // Run tests
    const testResult = await runTests(projectRoot, config);
    if (testResult.passed) {
      ui.success(`Tests passed (${testResult.command})`);
    } else {
      ui.warn(`Tests failed (${testResult.command}):`);
      console.log(testResult.error?.slice(0, 500));
    }

    // Git commit
    if (await git.hasChanges()) {
      await git.commitAll(`feat: task ${task.id} — ${task.title}`);
      ui.success(`Committed: task ${task.id} — ${task.title}`);
    }

    // Mark task as completed
    await state.completeTask(
      String(task.id),
      `# Task ${task.id}: ${task.title}\n\nCompleted: ${new Date().toISOString()}\n\nFiles: ${fileOps.map((op) => op.path).join(", ")}`,
    );

    console.log();
  }

  ui.header("Implementation Complete");
  const log = await git.log(tasks.length);
  for (const entry of log) {
    ui.info(`${entry.hash} ${entry.message}`);
  }
  console.log();
  ui.info("Review your changes and run `bender status` to see project state.");
  ui.cleanup();
}
