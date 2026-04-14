import type { EvalSuiteConfigAggregate, EvalTaskRun } from "./types.js";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return sorted[mid];
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function aggregateSuiteByConfig(
  runs: EvalTaskRun[],
  configIds: string[],
): EvalSuiteConfigAggregate[] {
  return configIds.map((configId) => {
    const group = runs.filter((r) => r.configId === configId);
    const attempted = group.length;
    const succeeded = group.filter((r) => r.success).length;
    const latencies = group.map((r) => r.durationMs).filter((v) => Number.isFinite(v));
    const totalLatency = sum(latencies);
    const costs = group
      .map((r) => r.estimatedCostUsd)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const tokens = group
      .map((r) => r.usage?.totalTokens ?? ((r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)))
      .filter((v): v is number => Number.isFinite(v) && v > 0);

    const totalCost = costs.length > 0 ? sum(costs) : null;
    const avgCost = costs.length > 0 ? totalCost! / costs.length : null;
    const totalTokens = tokens.length > 0 ? sum(tokens) : null;

    return {
      configId,
      tasksAttempted: attempted,
      tasksSucceeded: succeeded,
      successRate: attempted > 0 ? round(succeeded / attempted) : 0,
      totalLatencyMs: Math.round(totalLatency),
      medianLatencyMs: median(latencies),
      totalEstimatedCostUsd: totalCost === null ? null : round(totalCost),
      averageEstimatedCostUsd: avgCost === null ? null : round(avgCost),
      totalTokenUsage: totalTokens === null ? null : Math.round(totalTokens),
    };
  });
}

export function rankSuiteConfigs(
  aggregates: EvalSuiteConfigAggregate[],
): EvalSuiteConfigAggregate[] {
  return [...aggregates].sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    if (a.medianLatencyMs !== b.medianLatencyMs) return a.medianLatencyMs - b.medianLatencyMs;

    const aCost = a.averageEstimatedCostUsd ?? Number.POSITIVE_INFINITY;
    const bCost = b.averageEstimatedCostUsd ?? Number.POSITIVE_INFINITY;
    if (aCost !== bCost) return aCost - bCost;

    return a.configId.localeCompare(b.configId);
  });
}

