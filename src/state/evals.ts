import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBenderDir } from "./config.js";
import type {
  EvalCompareRunSummary,
  EvalConfig,
  EvalSuite,
  EvalSuiteRun,
  EvalTask,
  EvalTaskRun,
} from "../evals/types.js";

interface JsonObject {
  [key: string]: unknown;
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

export class EvalsStore {
  private readonly baseDir: string;
  private readonly runsDir: string;
  private readonly taskRunsDir: string;
  private readonly suiteRunsDir: string;
  private readonly tasksPath: string;
  private readonly configsPath: string;
  private readonly suitesPath: string;
  private readonly compareIndexPath: string;
  private readonly suiteIndexPath: string;

  constructor(projectRoot: string) {
    this.baseDir = join(getBenderDir(projectRoot), "evals");
    this.runsDir = join(this.baseDir, "runs");
    this.taskRunsDir = join(this.runsDir, "tasks");
    this.suiteRunsDir = join(this.runsDir, "suites");
    this.tasksPath = join(this.baseDir, "tasks.json");
    this.configsPath = join(this.baseDir, "configs.json");
    this.suitesPath = join(this.baseDir, "suites.json");
    this.compareIndexPath = join(this.runsDir, "compare-index.json");
    this.suiteIndexPath = join(this.runsDir, "suite-index.json");
  }

  async init(): Promise<void> {
    const dirs = [this.baseDir, this.runsDir, this.taskRunsDir, this.suiteRunsDir];
    for (const dir of dirs) {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    }
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  async listTasks(): Promise<EvalTask[]> {
    const parsed = await readJsonOr<unknown>(this.tasksPath, []);
    return asArray<EvalTask>(parsed)
      .filter((t) => typeof t?.id === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getTask(taskId: string): Promise<EvalTask | null> {
    const tasks = await this.listTasks();
    return tasks.find((t) => t.id === taskId) ?? null;
  }

  async upsertTask(task: EvalTask): Promise<void> {
    const tasks = await this.listTasks();
    const next = [...tasks.filter((t) => t.id !== task.id), task];
    await writeJson(this.tasksPath, next.sort((a, b) => b.updatedAt - a.updatedAt));
  }

  async deleteTask(taskId: string): Promise<void> {
    const tasks = await this.listTasks();
    await writeJson(this.tasksPath, tasks.filter((t) => t.id !== taskId));
  }

  // ── Configs ────────────────────────────────────────────────────────────────

  async listConfigs(): Promise<EvalConfig[]> {
    const parsed = await readJsonOr<unknown>(this.configsPath, []);
    return asArray<EvalConfig>(parsed)
      .filter((c) => typeof c?.id === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getConfig(configId: string): Promise<EvalConfig | null> {
    const configs = await this.listConfigs();
    return configs.find((c) => c.id === configId) ?? null;
  }

  async upsertConfig(config: EvalConfig): Promise<void> {
    const configs = await this.listConfigs();
    const next = [...configs.filter((c) => c.id !== config.id), config];
    await writeJson(this.configsPath, next.sort((a, b) => b.updatedAt - a.updatedAt));
  }

  async deleteConfig(configId: string): Promise<void> {
    const configs = await this.listConfigs();
    await writeJson(this.configsPath, configs.filter((c) => c.id !== configId));
  }

  // ── Suites ─────────────────────────────────────────────────────────────────

  async listSuites(): Promise<EvalSuite[]> {
    const parsed = await readJsonOr<unknown>(this.suitesPath, []);
    return asArray<EvalSuite>(parsed)
      .filter((s) => typeof s?.id === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSuite(suiteId: string): Promise<EvalSuite | null> {
    const suites = await this.listSuites();
    return suites.find((s) => s.id === suiteId) ?? null;
  }

  async upsertSuite(suite: EvalSuite): Promise<void> {
    const suites = await this.listSuites();
    const next = [...suites.filter((s) => s.id !== suite.id), suite];
    await writeJson(this.suitesPath, next.sort((a, b) => b.updatedAt - a.updatedAt));
  }

  async deleteSuite(suiteId: string): Promise<void> {
    const suites = await this.listSuites();
    await writeJson(this.suitesPath, suites.filter((s) => s.id !== suiteId));
  }

  // ── Compare runs ───────────────────────────────────────────────────────────

  async listCompareRuns(limit = 50): Promise<EvalCompareRunSummary[]> {
    const parsed = await readJsonOr<unknown>(this.compareIndexPath, []);
    const all = asArray<EvalCompareRunSummary>(parsed)
      .filter((r) => typeof r?.id === "string")
      .sort((a, b) => b.createdAt - a.createdAt);
    return all.slice(0, Math.max(1, limit));
  }

  async getCompareRunSummary(compareRunId: string): Promise<EvalCompareRunSummary | null> {
    const runs = await this.listCompareRuns(500);
    return runs.find((r) => r.id === compareRunId) ?? null;
  }

  async upsertCompareRunSummary(summary: EvalCompareRunSummary): Promise<void> {
    const current = await this.listCompareRuns(1000);
    const next = [...current.filter((r) => r.id !== summary.id), summary]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 1000);
    await writeJson(this.compareIndexPath, next);
  }

  async writeTaskRun(run: EvalTaskRun): Promise<void> {
    const path = join(this.taskRunsDir, `${run.id}.json`);
    await writeJson(path, run);
  }

  async getTaskRun(runId: string): Promise<EvalTaskRun | null> {
    const path = join(this.taskRunsDir, `${runId}.json`);
    return readJsonOr<EvalTaskRun | null>(path, null);
  }

  async getTaskRuns(runIds: string[]): Promise<EvalTaskRun[]> {
    const loaded = await Promise.all(runIds.map((id) => this.getTaskRun(id)));
    return loaded.filter((r): r is EvalTaskRun => !!r);
  }

  // ── Suite runs ─────────────────────────────────────────────────────────────

  async listSuiteRuns(limit = 50): Promise<EvalSuiteRun[]> {
    const parsed = await readJsonOr<unknown>(this.suiteIndexPath, []);
    const all = asArray<EvalSuiteRun>(parsed)
      .filter((r) => typeof r?.id === "string")
      .sort((a, b) => b.createdAt - a.createdAt);
    return all.slice(0, Math.max(1, limit));
  }

  async getSuiteRun(runId: string): Promise<EvalSuiteRun | null> {
    const path = join(this.suiteRunsDir, `${runId}.json`);
    return readJsonOr<EvalSuiteRun | null>(path, null);
  }

  async writeSuiteRun(run: EvalSuiteRun): Promise<void> {
    const path = join(this.suiteRunsDir, `${run.id}.json`);
    await writeJson(path, run);

    const index = await this.listSuiteRuns(1000);
    const slim: EvalSuiteRun = {
      ...run,
      taskRunIds: run.taskRunIds,
      perConfig: run.perConfig,
      ranking: run.ranking,
    };
    const next = [...index.filter((r) => r.id !== run.id), slim]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 1000);
    await writeJson(this.suiteIndexPath, next);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  async ensureConsistentTaskReferences(): Promise<void> {
    const tasks = await this.listTasks();
    const taskIds = new Set(tasks.map((t) => t.id));
    const suites = await this.listSuites();
    const nextSuites = suites.map((suite) => ({
      ...suite,
      taskIds: suite.taskIds.filter((id) => taskIds.has(id)),
    }));
    await writeJson(this.suitesPath, nextSuites);
  }

  async readBlob(blobPath: string): Promise<JsonObject | null> {
    const parsed = await readJsonOr<unknown>(blobPath, null);
    return parsed ? asRecord(parsed) : null;
  }
}

