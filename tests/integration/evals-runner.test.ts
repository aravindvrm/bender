import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createTempDir } from "../helpers/temp-env.js";
import { runSuiteCompare, runTaskCompare } from "../../src/evals/runner.js";
import { EvalsStore } from "../../src/state/evals.js";
import type { EvalConfig, EvalSuite, EvalTask, EvalTaskRun } from "../../src/evals/types.js";

function makeTask(id: string, name: string): EvalTask {
  const now = Date.now();
  return { id, name, prompt: `Do ${name}`, createdAt: now, updatedAt: now };
}

function makeConfig(id: string, name: string): EvalConfig {
  const now = Date.now();
  return {
    id,
    name,
    role: "implementer",
    enabled: true,
    modelTier: "default",
    createdAt: now,
    updatedAt: now,
  };
}

function makeSuite(id: string, taskIds: string[]): EvalSuite {
  const now = Date.now();
  return { id, name: "suite", taskIds, createdAt: now, updatedAt: now };
}

describe("eval runner orchestration", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const path of cleanupPaths) {
      await rm(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("runs compare task across configs and persists run summaries", async () => {
    const projectRoot = await createTempDir("bender-evals-compare-");
    cleanupPaths.push(projectRoot);
    const task = makeTask("task-1", "compare-task");
    const configs = [makeConfig("cfg-a", "A"), makeConfig("cfg-b", "B")];

    const result = await runTaskCompare({
      projectRoot,
      task,
      configs,
      executeTask: async ({ compareRunId, task, config }): Promise<EvalTaskRun> => {
        const ok = config.id === "cfg-a";
        const startedAt = Date.now();
        const durationMs = ok ? 400 : 900;
        return {
          id: `${compareRunId}-${config.id}`,
          compareRunId,
          taskId: task.id,
          configId: config.id,
          role: "implementer",
          provider: "openai",
          model: "gpt-4o-mini",
          enabledSkills: [],
          enabledTools: [],
          status: ok ? "succeeded" : "failed",
          success: ok,
          output: ok ? "success output" : "",
          durationMs,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          estimatedCostUsd: ok ? 0.001 : 0.0015,
          error: ok ? undefined : "intentional failure",
          trace: { stub: true },
          startedAt,
          completedAt: startedAt + durationMs,
          score: {
            success: ok ? 1 : 0,
            latencyMs: durationMs,
            tokenUsage: 150,
            estimatedCostUsd: ok ? 0.001 : 0.0015,
          },
        };
      },
    });

    expect(result.runs).toHaveLength(2);
    expect(result.summary.status).toBe("failed");

    const store = new EvalsStore(projectRoot);
    await store.init();
    const persisted = await store.getCompareRunSummary(result.summary.id);
    expect(persisted?.runIds.length).toBe(2);
    const taskRuns = await store.getTaskRuns(persisted?.runIds ?? []);
    expect(taskRuns).toHaveLength(2);
  });

  it("runs suite, stores task runs, and computes per-config aggregates", async () => {
    const projectRoot = await createTempDir("bender-evals-suite-");
    cleanupPaths.push(projectRoot);
    const tasks = [makeTask("task-1", "t1"), makeTask("task-2", "t2")];
    const configs = [makeConfig("cfg-a", "A"), makeConfig("cfg-b", "B")];
    const suite = makeSuite("suite-1", tasks.map((t) => t.id));

    const result = await runSuiteCompare({
      projectRoot,
      suite,
      tasks,
      configs,
      executeTask: async ({ compareRunId, task, config }): Promise<EvalTaskRun> => {
        const ok = config.id === "cfg-a" || task.id === "task-1";
        const startedAt = Date.now();
        const durationMs = config.id === "cfg-a" ? 350 : 800;
        return {
          id: `${compareRunId}-${task.id}-${config.id}`,
          compareRunId,
          taskId: task.id,
          configId: config.id,
          role: "implementer",
          provider: "openai",
          model: "gpt-4o-mini",
          enabledSkills: [],
          enabledTools: [],
          status: ok ? "succeeded" : "failed",
          success: ok,
          output: ok ? "ok" : "",
          durationMs,
          usage: { totalTokens: config.id === "cfg-a" ? 100 : 180 },
          estimatedCostUsd: config.id === "cfg-a" ? 0.001 : 0.002,
          error: ok ? undefined : "fail",
          trace: {},
          startedAt,
          completedAt: startedAt + durationMs,
          score: {
            success: ok ? 1 : 0,
            latencyMs: durationMs,
            tokenUsage: config.id === "cfg-a" ? 100 : 180,
            estimatedCostUsd: config.id === "cfg-a" ? 0.001 : 0.002,
          },
        };
      },
    });

    expect(result.taskRuns).toHaveLength(4);
    expect(result.suiteRun.perConfig).toHaveLength(2);
    expect(result.suiteRun.ranking[0]?.configId).toBe("cfg-a");

    const store = new EvalsStore(projectRoot);
    await store.init();
    const persisted = await store.getSuiteRun(result.suiteRun.id);
    expect(persisted?.taskRunIds.length).toBe(4);
  });
});

