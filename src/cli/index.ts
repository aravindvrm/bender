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
import { evalCiCommand } from "./evals-ci.js";

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

program
  .command("eval-ci")
  .description("Run a saved eval suite as a CI quality gate (Promptfoo-backed)")
  .requiredOption("-s, --suite <id>", "Saved eval suite ID")
  .option("-c, --configs <ids>", "Comma-separated config IDs (defaults to enabled configs)")
  .option("--concurrency <n>", "Max eval concurrency", (value: string) => Number.parseInt(value, 10))
  .option("--min-success-rate <n>", "Minimum pass rate from 0 to 1", (value: string) => Number.parseFloat(value), 1)
  .option("--max-median-latency-ms <n>", "Maximum median latency per config in milliseconds", (value: string) => Number.parseFloat(value))
  .option("--max-average-cost-usd <n>", "Maximum average cost per task in USD", (value: string) => Number.parseFloat(value))
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (opts) => {
    const projectRoot = resolve(opts.dir);
    await evalCiCommand(projectRoot, {
      suiteId: String(opts.suite ?? ""),
      configIds: typeof opts.configs === "string"
        ? opts.configs.split(",").map((id: string) => id.trim()).filter(Boolean)
        : undefined,
      concurrency: typeof opts.concurrency === "number" ? opts.concurrency : undefined,
      minSuccessRate: typeof opts.minSuccessRate === "number" ? opts.minSuccessRate : undefined,
      maxMedianLatencyMs: typeof opts.maxMedianLatencyMs === "number" ? opts.maxMedianLatencyMs : undefined,
      maxAverageCostUsd: typeof opts.maxAverageCostUsd === "number" ? opts.maxAverageCostUsd : undefined,
    });
  });

program.parse();
