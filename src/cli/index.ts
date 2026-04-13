#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { initCommand } from "./init.js";
import { planCommand } from "./plan.js";
import { implementCommand } from "./implement.js";
import { statusCommand } from "./status.js";
import { bendCommand } from "./review.js";
import { analyzeCommand } from "./analyze.js";
import { stopCommand } from "./stop.js";

const program = new Command();

program
  .name("bender")
  .description("AI-powered software factory — turns messy product ideas into maintainable codebases")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a new project (clarification → architecture → task plan)")
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    await initCommand(projectRoot);
  });

program
  .command("plan")
  .description("Plan a new feature or change for an existing project")
  .argument("<description>", "Description of the feature or change")
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (description: string, opts) => {
    const projectRoot = resolve(opts.dir);
    await planCommand(projectRoot, description);
  });

program
  .command("implement")
  .description("Execute the current task plan")
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    await implementCommand(projectRoot);
  });

program
  .command("status")
  .description("Show project state, tasks, and recent decisions")
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    await statusCommand(projectRoot);
  });

program
  .command("bend")
  .alias("open")
  .alias("review")
  .description("Open the local web dashboard")
  .option("-d, --dir <path>", "Project directory (optional — can be set from the UI)")
  .action(async (opts) => {
    await bendCommand(opts.dir);
  });

program
  .command("stop")
  .description("Stop the local web dashboard server")
  .action(async () => {
    await stopCommand();
  });

program
  .command("analyze")
  .description("Analyze an existing codebase and generate .bender/ project state")
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    await analyzeCommand(projectRoot);
  });

program.parse();
