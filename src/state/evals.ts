import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBenderDir } from "./config.js";
import { LocalProjectDb } from "./local-db.js";
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

const NS_TASK = "eval.task";
const NS_CONFIG = "eval.config";
const NS_SUITE = "eval.suite";
const NS_COMPARE_RUN = "eval.compare_run";
const NS_TASK_RUN = "eval.task_run";
const NS_SUITE_RUN = "eval.suite_run";

const LEGACY_IMPORT_KEY = "evals:legacy-imported:v1";

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function normalizeLimit(limit = 50): number {
  return Math.max(1, Math.min(10_000, Math.floor(limit)));
}

export class EvalsStore {
  private readonly db: LocalProjectDb;
  private readonly legacyBaseDir: string;
  private readonly legacyRunsDir: string;
  private readonly legacyTaskRunsDir: string;
  private readonly legacySuiteRunsDir: string;
  private readonly legacyTasksPath: string;
  private readonly legacyConfigsPath: string;
  private readonly legacySuitesPath: string;
  private readonly legacyCompareIndexPath: string;
  private readonly legacySuiteIndexPath: string;

  constructor(projectRoot: string) {
    this.db = LocalProjectDb.forProject(projectRoot);
    this.legacyBaseDir = join(getBenderDir(projectRoot), "evals");
    this.legacyRunsDir = join(this.legacyBaseDir, "runs");
    this.legacyTaskRunsDir = join(this.legacyRunsDir, "tasks");
    this.legacySuiteRunsDir = join(this.legacyRunsDir, "suites");
    this.legacyTasksPath = join(this.legacyBaseDir, "tasks.json");
    this.legacyConfigsPath = join(this.legacyBaseDir, "configs.json");
    this.legacySuitesPath = join(this.legacyBaseDir, "suites.json");
    this.legacyCompareIndexPath = join(this.legacyRunsDir, "compare-index.json");
    this.legacySuiteIndexPath = join(this.legacyRunsDir, "suite-index.json");
  }

  async init(): Promise<void> {
    await this.db.init();
    const imported = this.db.getKv(LEGACY_IMPORT_KEY);
    if (imported === "1") return;
    await this.importLegacyFilesIfPresent();
    this.db.setKv(LEGACY_IMPORT_KEY, "1");
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  async listTasks(): Promise<EvalTask[]> {
    return this.db.listRecords<EvalTask>(NS_TASK, { limit: 10_000, orderBy: "updated_at", desc: true })
      .filter((task) => typeof task?.id === "string");
  }

  async getTask(taskId: string): Promise<EvalTask | null> {
    return this.db.getRecord<EvalTask>(NS_TASK, taskId);
  }

  async upsertTask(task: EvalTask): Promise<void> {
    this.db.upsertRecord(NS_TASK, task.id, task, {
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    this.db.deleteRecord(NS_TASK, taskId);
  }

  // ── Configs ────────────────────────────────────────────────────────────────

  async listConfigs(): Promise<EvalConfig[]> {
    return this.db.listRecords<EvalConfig>(NS_CONFIG, { limit: 10_000, orderBy: "updated_at", desc: true })
      .filter((config) => typeof config?.id === "string");
  }

  async getConfig(configId: string): Promise<EvalConfig | null> {
    return this.db.getRecord<EvalConfig>(NS_CONFIG, configId);
  }

  async upsertConfig(config: EvalConfig): Promise<void> {
    this.db.upsertRecord(NS_CONFIG, config.id, config, {
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
  }

  async deleteConfig(configId: string): Promise<void> {
    this.db.deleteRecord(NS_CONFIG, configId);
  }

  // ── Suites ─────────────────────────────────────────────────────────────────

  async listSuites(): Promise<EvalSuite[]> {
    return this.db.listRecords<EvalSuite>(NS_SUITE, { limit: 10_000, orderBy: "updated_at", desc: true })
      .filter((suite) => typeof suite?.id === "string");
  }

  async getSuite(suiteId: string): Promise<EvalSuite | null> {
    return this.db.getRecord<EvalSuite>(NS_SUITE, suiteId);
  }

  async upsertSuite(suite: EvalSuite): Promise<void> {
    this.db.upsertRecord(NS_SUITE, suite.id, suite, {
      createdAt: suite.createdAt,
      updatedAt: suite.updatedAt,
    });
  }

  async deleteSuite(suiteId: string): Promise<void> {
    this.db.deleteRecord(NS_SUITE, suiteId);
  }

  // ── Compare runs ───────────────────────────────────────────────────────────

  async listCompareRuns(limit = 50): Promise<EvalCompareRunSummary[]> {
    const capped = normalizeLimit(limit);
    return this.db.listRecords<EvalCompareRunSummary>(NS_COMPARE_RUN, {
      limit: capped,
      orderBy: "created_at",
      desc: true,
    }).filter((run) => typeof run?.id === "string")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, capped);
  }

  async getCompareRunSummary(compareRunId: string): Promise<EvalCompareRunSummary | null> {
    return this.db.getRecord<EvalCompareRunSummary>(NS_COMPARE_RUN, compareRunId);
  }

  async upsertCompareRunSummary(summary: EvalCompareRunSummary): Promise<void> {
    this.db.upsertRecord(NS_COMPARE_RUN, summary.id, summary, {
      createdAt: summary.createdAt,
      updatedAt: summary.completedAt ?? summary.createdAt,
    });
  }

  async writeTaskRun(run: EvalTaskRun): Promise<void> {
    this.db.upsertRecord(NS_TASK_RUN, run.id, run, {
      createdAt: run.startedAt,
      updatedAt: run.completedAt,
    });
  }

  async getTaskRun(runId: string): Promise<EvalTaskRun | null> {
    return this.db.getRecord<EvalTaskRun>(NS_TASK_RUN, runId);
  }

  async getTaskRuns(runIds: string[]): Promise<EvalTaskRun[]> {
    const out: EvalTaskRun[] = [];
    for (const runId of runIds) {
      const run = await this.getTaskRun(runId);
      if (run) out.push(run);
    }
    return out;
  }

  // ── Suite runs ─────────────────────────────────────────────────────────────

  async listSuiteRuns(limit = 50): Promise<EvalSuiteRun[]> {
    const capped = normalizeLimit(limit);
    return this.db.listRecords<EvalSuiteRun>(NS_SUITE_RUN, {
      limit: capped,
      orderBy: "created_at",
      desc: true,
    }).filter((run) => typeof run?.id === "string")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, capped);
  }

  async getSuiteRun(runId: string): Promise<EvalSuiteRun | null> {
    return this.db.getRecord<EvalSuiteRun>(NS_SUITE_RUN, runId);
  }

  async writeSuiteRun(run: EvalSuiteRun): Promise<void> {
    this.db.upsertRecord(NS_SUITE_RUN, run.id, run, {
      createdAt: run.createdAt,
      updatedAt: run.completedAt ?? run.createdAt,
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  async ensureConsistentTaskReferences(): Promise<void> {
    const tasks = await this.listTasks();
    const taskIds = new Set(tasks.map((task) => task.id));
    const suites = await this.listSuites();
    for (const suite of suites) {
      const next: EvalSuite = {
        ...suite,
        taskIds: suite.taskIds.filter((id) => taskIds.has(id)),
      };
      if (next.taskIds.length !== suite.taskIds.length) {
        await this.upsertSuite(next);
      }
    }
  }

  async readBlob(blobPath: string): Promise<JsonObject | null> {
    const parsed = await readJsonOr<unknown>(blobPath, null);
    return parsed ? asRecord(parsed) : null;
  }

  private async importLegacyFilesIfPresent(): Promise<void> {
    const tasks = asArray<EvalTask>(await readJsonOr<unknown>(this.legacyTasksPath, []));
    const configs = asArray<EvalConfig>(await readJsonOr<unknown>(this.legacyConfigsPath, []));
    const suites = asArray<EvalSuite>(await readJsonOr<unknown>(this.legacySuitesPath, []));
    const compareRuns = asArray<EvalCompareRunSummary>(await readJsonOr<unknown>(this.legacyCompareIndexPath, []));
    const suiteRunIndex = asArray<EvalSuiteRun>(await readJsonOr<unknown>(this.legacySuiteIndexPath, []));
    const taskRunFiles = await this.readLegacyJsonFiles<EvalTaskRun>(this.legacyTaskRunsDir);
    const suiteRunFiles = await this.readLegacyJsonFiles<EvalSuiteRun>(this.legacySuiteRunsDir);

    this.db.transaction(() => {
      for (const task of tasks) {
        if (!task?.id) continue;
        this.db.upsertRecord(NS_TASK, task.id, task, {
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      }
      for (const config of configs) {
        if (!config?.id) continue;
        this.db.upsertRecord(NS_CONFIG, config.id, config, {
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
        });
      }
      for (const suite of suites) {
        if (!suite?.id) continue;
        this.db.upsertRecord(NS_SUITE, suite.id, suite, {
          createdAt: suite.createdAt,
          updatedAt: suite.updatedAt,
        });
      }
      for (const summary of compareRuns) {
        if (!summary?.id) continue;
        this.db.upsertRecord(NS_COMPARE_RUN, summary.id, summary, {
          createdAt: summary.createdAt,
          updatedAt: summary.completedAt ?? summary.createdAt,
        });
      }
      for (const run of taskRunFiles) {
        if (!run?.id) continue;
        this.db.upsertRecord(NS_TASK_RUN, run.id, run, {
          createdAt: run.startedAt,
          updatedAt: run.completedAt,
        });
      }
      const suiteRunsById = new Map<string, EvalSuiteRun>();
      for (const run of suiteRunIndex) {
        if (run?.id) suiteRunsById.set(run.id, run);
      }
      for (const run of suiteRunFiles) {
        if (run?.id) suiteRunsById.set(run.id, run);
      }
      for (const run of suiteRunsById.values()) {
        this.db.upsertRecord(NS_SUITE_RUN, run.id, run, {
          createdAt: run.createdAt,
          updatedAt: run.completedAt ?? run.createdAt,
        });
      }
    });
  }

  private async readLegacyJsonFiles<T>(dirPath: string): Promise<T[]> {
    if (!existsSync(dirPath)) return [];
    const files = await readdir(dirPath);
    const out: T[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const parsed = await readJsonOr<unknown>(join(dirPath, file), null);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as T);
      }
    }
    return out;
  }
}

