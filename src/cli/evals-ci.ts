import chalk from "chalk";
import { EvalsStore } from "../state/evals.js";
import { runSuiteCompare } from "../evals/runner.js";
import type { EvalConfig, EvalTask } from "../evals/types.js";

export interface EvalCiOptions {
  suiteId: string;
  configIds?: string[];
  concurrency?: number;
  minSuccessRate?: number;
  maxMedianLatencyMs?: number;
  maxAverageCostUsd?: number;
}

function parseOptionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) ? value : undefined;
}

function parseBoundedRate(value: unknown, fallback: number): number {
  const parsed = parseOptionalFiniteNumber(value) ?? fallback;
  return Math.min(1, Math.max(0, parsed));
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCost(value: number | null): string {
  if (typeof value !== "number") return "—";
  return `$${value.toFixed(4)}`;
}

export async function evalCiCommand(projectRoot: string, options: EvalCiOptions): Promise<void> {
  const suiteId = options.suiteId.trim();
  if (!suiteId) {
    throw new Error("suiteId is required");
  }

  const store = new EvalsStore(projectRoot);
  await store.init();
  const suite = await store.getSuite(suiteId);
  if (!suite) {
    throw new Error(`Eval suite not found: ${suiteId}`);
  }
  const allTasks = await store.listTasks();
  const tasks = suite.taskIds
    .map((id) => allTasks.find((task) => task.id === id))
    .filter((task): task is EvalTask => !!task);
  if (tasks.length === 0) {
    throw new Error(`Suite ${suite.name} has no valid tasks.`);
  }

  const allConfigs = await store.listConfigs();
  const requestedConfigIds = (options.configIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const configs = requestedConfigIds.length > 0
    ? allConfigs.filter((config) => requestedConfigIds.includes(config.id))
    : allConfigs.filter((config) => config.enabled);
  if (configs.length === 0) {
    throw new Error("No eval configs available for CI eval run.");
  }

  const minSuccessRate = parseBoundedRate(options.minSuccessRate, 1);
  const maxMedianLatencyMs = parseOptionalFiniteNumber(options.maxMedianLatencyMs);
  const maxAverageCostUsd = parseOptionalFiniteNumber(options.maxAverageCostUsd);
  const concurrency = parseOptionalFiniteNumber(options.concurrency);

  console.log(chalk.bold("Bender Eval CI Gate"));
  console.log(chalk.gray(`Suite: ${suite.name} (${suite.id})`));
  console.log(chalk.gray(`Tasks: ${tasks.length}, Configs: ${configs.length}`));
  console.log(chalk.gray(`Thresholds: successRate>=${Math.round(minSuccessRate * 100)}%`));
  if (typeof maxMedianLatencyMs === "number") {
    console.log(chalk.gray(`            medianLatency<=${fmtMs(maxMedianLatencyMs)}`));
  }
  if (typeof maxAverageCostUsd === "number") {
    console.log(chalk.gray(`            avgCost<=${fmtCost(maxAverageCostUsd)}`));
  }
  console.log();

  const { suiteRun } = await runSuiteCompare({
    projectRoot,
    suite,
    tasks,
    configs,
    concurrency,
  });

  const configNameById = new Map(configs.map((config) => [config.id, config.name]));
  const failures: string[] = [];

  for (const row of suiteRun.perConfig) {
    const name = configNameById.get(row.configId) ?? row.configId;
    const successRate = row.successRate;
    const latency = row.medianLatencyMs;
    const avgCost = row.averageEstimatedCostUsd;
    console.log(`${name.padEnd(24)} success ${(successRate * 100).toFixed(0).padStart(3)}%  median ${fmtMs(latency).padStart(8)}  avgCost ${fmtCost(avgCost).padStart(8)}`);

    if (successRate < minSuccessRate) {
      failures.push(`${name}: success rate ${(successRate * 100).toFixed(0)}% < ${(minSuccessRate * 100).toFixed(0)}%`);
    }
    if (typeof maxMedianLatencyMs === "number" && latency > maxMedianLatencyMs) {
      failures.push(`${name}: median latency ${latency}ms > ${maxMedianLatencyMs}ms`);
    }
    if (typeof maxAverageCostUsd === "number" && (avgCost === null || avgCost > maxAverageCostUsd)) {
      failures.push(`${name}: average cost ${avgCost === null ? "unknown" : `$${avgCost.toFixed(4)}`} > $${maxAverageCostUsd.toFixed(4)}`);
    }
  }

  console.log();
  if (failures.length > 0) {
    console.error(chalk.red("Eval CI gate failed:"));
    for (const failure of failures) {
      console.error(chalk.red(`- ${failure}`));
    }
    throw new Error(`Eval CI gate failed (${failures.length} threshold violation${failures.length === 1 ? "" : "s"}).`);
  }
  console.log(chalk.green("Eval CI gate passed."));
}
