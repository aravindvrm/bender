import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { createTempDir } from "../helpers/temp-env.js";
import { EvalsStore } from "../../src/state/evals.js";
import type { EvalConfig, EvalSuite, EvalTask } from "../../src/evals/types.js";

const evaluateMock = vi.fn();
vi.mock("promptfoo", () => ({
  evaluate: evaluateMock,
}));

const { runTaskCompare, runSuiteCompare } = await import("../../src/evals/runner.js");

function makeTask(id: string, name: string): EvalTask {
  const now = Date.now();
  return { id, name, prompt: `Do ${name}`, createdAt: now, updatedAt: now };
}

function makeConfig(id: string, name: string, enabled = true): EvalConfig {
  const now = Date.now();
  return {
    id,
    name,
    role: "implementer",
    enabled,
    modelTier: "default",
    createdAt: now,
    updatedAt: now,
  };
}

function makeSuite(id: string, taskIds: string[]): EvalSuite {
  const now = Date.now();
  return { id, name: "suite", taskIds, createdAt: now, updatedAt: now };
}

function makePromptfooResult(params: {
  taskId: string;
  configId: string;
  success: boolean;
  score: number;
  output: string;
  durationMs: number;
  reason: string;
  cost?: number;
}) {
  const now = Date.now();
  return {
    promptIdx: 0,
    testIdx: 0,
    testCase: { vars: { taskId: params.taskId } },
    promptId: "prompt-1",
    prompt: { raw: "{{taskPrompt}}", label: "taskPrompt" },
    provider: { id: `bender-config:${params.configId}`, label: params.configId },
    vars: { taskId: params.taskId },
    response: {
      output: params.output,
      tokenUsage: { prompt: 20, completion: 10, total: 30 },
      metadata: {
        bender: {
          runId: `run-${params.taskId}-${params.configId}`,
          configId: params.configId,
          taskId: params.taskId,
          role: "implementer",
          provider: "openai",
          model: "gpt-4o-mini",
          enabledSkills: [],
          enabledTools: [],
          durationMs: params.durationMs,
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          estimatedCostUsd: params.cost ?? 0.001,
          error: params.success ? undefined : "forced failure",
          trace: { mocked: true },
          startedAt: now,
          completedAt: now + params.durationMs,
          success: params.success,
          output: params.output,
        },
      },
    },
    error: params.success ? null : "forced failure",
    failureReason: params.success ? 0 : 1,
    success: params.success,
    score: params.score,
    latencyMs: params.durationMs,
    gradingResult: {
      pass: params.success,
      score: params.score,
      reason: params.reason,
      componentResults: [
        {
          pass: params.success,
          score: params.score,
          reason: params.reason,
          assertion: {
            type: "javascript",
            metric: "bender-success",
          },
        },
      ],
    },
    namedScores: {},
    cost: params.cost ?? 0.001,
    metadata: { source: "promptfoo-mock" },
  };
}

describe("eval runner promptfoo backend", () => {
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    evaluateMock.mockReset();
  });

  afterEach(async () => {
    for (const path of cleanupPaths) {
      await rm(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("normalizes promptfoo compare results into bender runs", async () => {
    const projectRoot = await createTempDir("bender-evals-promptfoo-compare-");
    cleanupPaths.push(projectRoot);
    const task = makeTask("task-1", "compare-task");
    const configs = [makeConfig("cfg-a", "A"), makeConfig("cfg-b", "B"), makeConfig("cfg-c", "C", false)];

    evaluateMock.mockResolvedValue({
      toEvaluateSummary: async () => ({
        version: 3,
        timestamp: new Date().toISOString(),
        results: [
          makePromptfooResult({
            taskId: task.id,
            configId: "cfg-a",
            success: true,
            score: 1,
            output: "ok-a",
            durationMs: 220,
            reason: "passed",
            cost: 0.0011,
          }),
          makePromptfooResult({
            taskId: task.id,
            configId: "cfg-b",
            success: false,
            score: 0,
            output: "bad-b",
            durationMs: 480,
            reason: "failed",
            cost: 0.0015,
          }),
        ],
      }),
    });

    const result = await runTaskCompare({
      projectRoot,
      task,
      configs,
      concurrency: 2,
    });

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(result.runs).toHaveLength(3);
    const runA = result.runs.find((run) => run.configId === "cfg-a");
    const runB = result.runs.find((run) => run.configId === "cfg-b");
    const runC = result.runs.find((run) => run.configId === "cfg-c");
    expect(runA?.success).toBe(true);
    expect(runA?.assertionSummary?.passed).toBe(1);
    expect(runB?.success).toBe(false);
    expect(runB?.assertions?.[0]?.metric).toBe("bender-success");
    expect(runC?.error).toBe("Config is disabled.");
    expect(result.summary.status).toBe("failed");

    const store = new EvalsStore(projectRoot);
    await store.init();
    const persisted = await store.getCompareRunSummary(result.summary.id);
    expect(persisted?.runIds.length).toBe(3);
  });

  it("normalizes promptfoo suite results and computes ranking", async () => {
    const projectRoot = await createTempDir("bender-evals-promptfoo-suite-");
    cleanupPaths.push(projectRoot);
    const tasks = [makeTask("task-1", "t1"), makeTask("task-2", "t2")];
    const configs = [makeConfig("cfg-a", "A"), makeConfig("cfg-b", "B")];
    const suite = makeSuite("suite-1", tasks.map((task) => task.id));

    evaluateMock.mockResolvedValue({
      toEvaluateSummary: async () => ({
        version: 3,
        timestamp: new Date().toISOString(),
        results: [
          makePromptfooResult({ taskId: "task-1", configId: "cfg-a", success: true, score: 1, output: "a1", durationMs: 200, reason: "pass", cost: 0.001 }),
          makePromptfooResult({ taskId: "task-2", configId: "cfg-a", success: true, score: 1, output: "a2", durationMs: 250, reason: "pass", cost: 0.0012 }),
          makePromptfooResult({ taskId: "task-1", configId: "cfg-b", success: true, score: 1, output: "b1", durationMs: 500, reason: "pass", cost: 0.0018 }),
          makePromptfooResult({ taskId: "task-2", configId: "cfg-b", success: false, score: 0, output: "b2", durationMs: 900, reason: "fail", cost: 0.0022 }),
        ],
      }),
    });

    const result = await runSuiteCompare({
      projectRoot,
      suite,
      tasks,
      configs,
      concurrency: 2,
    });

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(result.taskRuns).toHaveLength(4);
    expect(result.suiteRun.perConfig).toHaveLength(2);
    expect(result.suiteRun.ranking[0]?.configId).toBe("cfg-a");

    const store = new EvalsStore(projectRoot);
    await store.init();
    const persisted = await store.getSuiteRun(result.suiteRun.id);
    expect(persisted?.taskRunIds.length).toBe(4);
  });
});
