import type { BaseRole } from "../state/agents.js";
import type { CapabilityPolicy } from "../state/capabilities.js";
import type { ModelTier } from "../state/config.js";

export type EvalRunStatus = "queued" | "running" | "succeeded" | "failed";
export type EvalSuccessMode = "response-only" | "diff-generated" | "build-verified" | "test-verified";

export interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface EvalScore {
  success: number;
  latencyMs: number | null;
  tokenUsage: number | null;
  estimatedCostUsd: number | null;
}

export interface EvalTask {
  id: string;
  name: string;
  prompt: string;
  assertions?: EvalTaskAssertion[];
  createdAt: number;
  updatedAt: number;
}

export interface EvalTaskAssertion {
  id: string;
  type: "javascript";
  source: string;
  metric?: string;
  enabled?: boolean;
}

export interface EvalAssertionResult {
  id: string;
  type: string;
  metric?: string;
  pass: boolean;
  score?: number | null;
  reason?: string;
  raw?: Record<string, unknown> | null;
}

export interface EvalAssertionSummary {
  total: number;
  passed: number;
  failed: number;
  score: number | null;
  reason?: string;
}

export interface EvalConfig {
  id: string;
  name: string;
  role: BaseRole;
  enabled: boolean;
  successMode?: EvalSuccessMode;
  modelTier?: ModelTier;
  provider?: string;
  model?: string;
  agentId?: string;
  pinnedSkills?: string[];
  mcpServerIds?: string[];
  capabilityPolicy?: CapabilityPolicy;
  createdAt: number;
  updatedAt: number;
}

export interface EvalSuite {
  id: string;
  name: string;
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface EvalTaskRun {
  id: string;
  compareRunId: string;
  taskId: string;
  configId: string;
  role: BaseRole;
  provider: string;
  model: string;
  enabledSkills: string[];
  enabledTools: string[];
  status: EvalRunStatus;
  success: boolean;
  output: string;
  durationMs: number;
  usage?: EvalUsage;
  estimatedCostUsd?: number | null;
  error?: string;
  trace: Record<string, unknown>;
  assertionSummary?: EvalAssertionSummary;
  assertions?: EvalAssertionResult[];
  promptfoo?: Record<string, unknown>;
  startedAt: number;
  completedAt: number;
  score: EvalScore;
}

export interface EvalCompareRunSummary {
  id: string;
  taskId: string;
  configIds: string[];
  runIds: string[];
  status: EvalRunStatus;
  createdAt: number;
  completedAt?: number;
}

export interface EvalSuiteConfigAggregate {
  configId: string;
  tasksAttempted: number;
  tasksSucceeded: number;
  successRate: number;
  totalLatencyMs: number;
  medianLatencyMs: number;
  totalEstimatedCostUsd: number | null;
  averageEstimatedCostUsd: number | null;
  totalTokenUsage: number | null;
}

export interface EvalSuiteRun {
  id: string;
  suiteId: string;
  configIds: string[];
  taskRunIds: string[];
  status: EvalRunStatus;
  createdAt: number;
  completedAt?: number;
  perConfig: EvalSuiteConfigAggregate[];
  ranking: EvalSuiteConfigAggregate[];
}
