import { describe, expect, it } from "vitest";
import { aggregateSuiteByConfig, rankSuiteConfigs } from "../../src/evals/aggregate.js";
import type { EvalTaskRun } from "../../src/evals/types.js";

function makeRun(overrides: Partial<EvalTaskRun>): EvalTaskRun {
  return {
    id: overrides.id ?? "run",
    compareRunId: overrides.compareRunId ?? "cmp",
    taskId: overrides.taskId ?? "task",
    configId: overrides.configId ?? "cfg",
    role: overrides.role ?? "implementer",
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "gpt-4o-mini",
    enabledSkills: overrides.enabledSkills ?? [],
    enabledTools: overrides.enabledTools ?? [],
    status: overrides.status ?? "succeeded",
    success: overrides.success ?? true,
    output: overrides.output ?? "ok",
    durationMs: overrides.durationMs ?? 1000,
    usage: overrides.usage,
    estimatedCostUsd: overrides.estimatedCostUsd,
    error: overrides.error,
    trace: overrides.trace ?? {},
    startedAt: overrides.startedAt ?? Date.now(),
    completedAt: overrides.completedAt ?? Date.now() + 1000,
    score: overrides.score ?? {
      success: overrides.success === false ? 0 : 1,
      latencyMs: overrides.durationMs ?? 1000,
      tokenUsage: overrides.usage?.totalTokens ?? null,
      estimatedCostUsd: overrides.estimatedCostUsd ?? null,
    },
  };
}

describe("evals aggregate", () => {
  it("aggregates metrics per config and ranks by success/latency/cost", () => {
    const runs: EvalTaskRun[] = [
      makeRun({ id: "a1", configId: "a", durationMs: 500, success: true, estimatedCostUsd: 0.001, usage: { totalTokens: 100 } }),
      makeRun({ id: "a2", configId: "a", durationMs: 700, success: true, estimatedCostUsd: 0.0012, usage: { totalTokens: 120 } }),
      makeRun({ id: "b1", configId: "b", durationMs: 300, success: true, estimatedCostUsd: 0.002, usage: { totalTokens: 150 } }),
      makeRun({ id: "b2", configId: "b", durationMs: 1200, success: false, estimatedCostUsd: 0.0025, usage: { totalTokens: 180 } }),
    ];

    const aggregated = aggregateSuiteByConfig(runs, ["a", "b"]);
    const a = aggregated.find((row) => row.configId === "a");
    const b = aggregated.find((row) => row.configId === "b");
    expect(a?.tasksAttempted).toBe(2);
    expect(a?.tasksSucceeded).toBe(2);
    expect(a?.successRate).toBe(1);
    expect(a?.totalTokenUsage).toBe(220);
    expect(b?.tasksSucceeded).toBe(1);
    expect(b?.successRate).toBe(0.5);

    const ranked = rankSuiteConfigs(aggregated);
    expect(ranked[0]?.configId).toBe("a");
    expect(ranked[1]?.configId).toBe("b");
  });
});

