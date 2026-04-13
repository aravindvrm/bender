import chalk from "chalk";
import { readEffectiveConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { GitOperations } from "../git/operations.js";
import * as ui from "./ui.js";

export async function statusCommand(projectRoot: string): Promise<void> {
  const state = new StateManager(projectRoot);

  if (!state.isInitialized()) {
    ui.error("No .bender/ directory found. Run `bender init` to start a project.");
    return;
  }

  const config = await readEffectiveConfig(projectRoot);
  const context = await state.gatherContext();

  ui.header("Bender Project Status");

  // Project overview
  if (context.brief) {
    const titleMatch = context.brief.match(/^#\s+Product Brief:\s*(.+)/m);
    const overviewMatch = context.brief.match(/##\s*Overview\s*\n([\s\S]*?)(?=\n##)/);
    if (titleMatch) {
      console.log(chalk.bold(`  Project: ${titleMatch[1]}`));
    }
    if (overviewMatch) {
      console.log(chalk.gray(`  ${overviewMatch[1].trim().split("\n")[0]}`));
    }
    console.log();
  }

  // Stack
  console.log(chalk.bold("  Stack:"));
  console.log(`    Framework: ${config.stack.framework}`);
  console.log(`    Database:  ${config.stack.database}`);
  console.log(`    ORM:       ${config.stack.orm}`);
  console.log(`    Auth:      ${config.stack.auth}`);
  console.log(`    Styling:   ${config.stack.styling}`);
  console.log();

  // LLM config
  console.log(chalk.bold("  LLM:"));
  console.log(`    Provider: ${config.llm.provider}`);
  const models = config.llm.models;
  console.log(`    Fast:     ${typeof models.fast === "string" ? models.fast : `${models.fast.provider}/${models.fast.model}`}`);
  console.log(`    Default:  ${typeof models.default === "string" ? models.default : `${models.default.provider}/${models.default.model}`}`);
  console.log(`    Strong:   ${typeof models.strong === "string" ? models.strong : `${models.strong.provider}/${models.strong.model}`}`);
  console.log();

  // Tasks
  if (context.currentTasks) {
    const taskLines = context.currentTasks.match(/###\s*Task\s*\d+:.+/g);
    if (taskLines) {
      console.log(chalk.bold(`  Tasks: ${taskLines.length} in current plan`));
      for (const line of taskLines) {
        console.log(`    ${line.replace(/^###\s*/, "")}`);
      }
    }
  } else {
    console.log(chalk.gray("  No current task plan."));
  }
  console.log();

  // Completed tasks
  const completed = await state.readCompletedTasks();
  if (completed.length > 0) {
    console.log(chalk.bold(`  Completed tasks: ${completed.length}`));
    for (const task of completed.slice(-5)) {
      const titleMatch = task.content.match(/^#\s*(.+)/m);
      if (titleMatch) {
        console.log(chalk.green(`    ${titleMatch[1]}`));
      }
    }
    if (completed.length > 5) {
      console.log(chalk.gray(`    ... and ${completed.length - 5} more`));
    }
  }
  console.log();

  // Decisions
  const decisions = await state.readDecisions();
  if (decisions.length > 0) {
    console.log(chalk.bold(`  Architecture decisions: ${decisions.length}`));
    for (const dec of decisions) {
      const titleMatch = dec.content.match(/^#\s*(.+)/m);
      if (titleMatch) {
        console.log(`    ${dec.name}: ${titleMatch[1]}`);
      }
    }
  }
  console.log();

  // Git status
  try {
    const git = new GitOperations(projectRoot);
    if (await git.isRepo()) {
      const branch = await git.getCurrentBranch();
      const changes = await git.hasChanges();
      const log = await git.log(3);

      console.log(chalk.bold("  Git:"));
      console.log(`    Branch: ${branch}${changes ? chalk.yellow(" (uncommitted changes)") : chalk.green(" (clean)")}`);
      if (log.length > 0) {
        console.log("    Recent commits:");
        for (const entry of log) {
          console.log(`      ${chalk.gray(entry.hash)} ${entry.message}`);
        }
      }
    }
  } catch {
    // Not a git repo, skip
  }

  console.log();
  ui.info("Files: .bender/brief.md, .bender/architecture.md, .bender/conventions.md");
  ui.info("Run `bender plan \"feature\"` to plan a new feature.");
  ui.info("Run `bender implement` to execute the current task plan.");
}
