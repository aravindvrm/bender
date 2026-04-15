import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { createTempDir } from "../helpers/temp-env.js";
import { EvalsStore } from "../../src/state/evals.js";
import type { EvalConfig, EvalSuite, EvalTask } from "../../src/evals/types.js";

const runSuiteCompareMock = vi.fn();
vi.mock("../../src/evals/runner.js", () => ({
  runSuiteCompare: runSuiteCompareMock,
}));

const { evalCiCommand } = await import("../../src/cli/evals-ci.js");

function makeTask(id: string): EvalTask {
  const now = Date.now();
  return {
    id,
    name: id,
    prompt: `Prompt ${id}`,
    createdAt: now,
    updatedAt: now,
  };
}

function makeConfig(id: string, enabled = true): EvalConfig {
  const now = Date.now();
  return {
    id,
    name: id,
    role: "implementer",
    enabled,
    createdAt: now,
    updatedAt: now,
  };
}

function makeSuite(id: string, taskIds: string[]): EvalSuite {
  const now = Date.now();
  return {
    id,
    name: id,
    taskIds,
    createdAt: now,
    updatedAt: now,
  };
}

describe("eval ci command", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    runSuiteCompareMock.mockReset();
    for (const path of cleanupPaths) {
      await rm(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("passes when thresholds are met", async () => {
    const projectRoot = await createTempDir("bender-evals-ci-pass-");
    cleanupPaths.push(projectRoot);
    const store = new EvalsStore(projectRoot);
    await store.init();
    await store.upsertTask(makeTask("t1"));
    await store.upsertConfig(makeConfig("cfg-a", true));
    await store.upsertSuite(makeSuite("suite-1", ["t1"]));

    runSuiteCompareMock.mockResolvedValue({
      suiteRun: {
        id: "run-1",
        suiteId: "suite-1",
        configIds: ["cfg-a"],
        taskRunIds: [],
        status: "succeeded",
        createdAt: Date.now(),
        completedAt: Date.now(),
        perConfig: [
          {
            configId: "cfg-a",
            tasksAttempted: 1,
            tasksSucceeded: 1,
            successRate: 1,
            totalLatencyMs: 220,
            medianLatencyMs: 220,
            totalEstimatedCostUsd: 0.001,
            averageEstimatedCostUsd: 0.001,
            totalTokenUsage: 120,
          },
        ],
        ranking: [],
      },
      taskRuns: [],
    });

    await expect(evalCiCommand(projectRoot, {
      suiteId: "suite-1",
      minSuccessRate: 1,
      maxMedianLatencyMs: 500,
      maxAverageCostUsd: 0.01,
    })).resolves.toBeUndefined();
    expect(runSuiteCompareMock).toHaveBeenCalledOnce();
  });

  it("fails when thresholds are violated", async () => {
    const projectRoot = await createTempDir("bender-evals-ci-fail-");
    cleanupPaths.push(projectRoot);
    const store = new EvalsStore(projectRoot);
    await store.init();
    await store.upsertTask(makeTask("t1"));
    await store.upsertConfig(makeConfig("cfg-a", true));
    await store.upsertSuite(makeSuite("suite-1", ["t1"]));

    runSuiteCompareMock.mockResolvedValue({
      suiteRun: {
        id: "run-1",
        suiteId: "suite-1",
        configIds: ["cfg-a"],
        taskRunIds: [],
        status: "failed",
        createdAt: Date.now(),
        completedAt: Date.now(),
        perConfig: [
          {
            configId: "cfg-a",
            tasksAttempted: 1,
            tasksSucceeded: 0,
            successRate: 0,
            totalLatencyMs: 1500,
            medianLatencyMs: 1500,
            totalEstimatedCostUsd: 0.02,
            averageEstimatedCostUsd: 0.02,
            totalTokenUsage: 120,
          },
        ],
        ranking: [],
      },
      taskRuns: [],
    });

    await expect(evalCiCommand(projectRoot, {
      suiteId: "suite-1",
      minSuccessRate: 0.9,
      maxMedianLatencyMs: 1000,
      maxAverageCostUsd: 0.01,
    })).rejects.toThrow("Eval CI gate failed");
  });
});
