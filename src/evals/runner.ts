import { randomUUID } from "node:crypto";
import type { BaseRole } from "../state/agents.js";
import { getAllAgents, getEffectiveAgentForRole } from "../state/agents.js";
import type { CapabilityPolicy } from "../state/capabilities.js";
import { resolveConnectorAccess } from "../state/capabilities.js";
import type { BenderConfig, ModelTier } from "../state/config.js";
import { readEffectiveConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { EvalsStore } from "../state/evals.js";
import type { EvalCompareRunSummary, EvalConfig, EvalSuite, EvalSuiteRun, EvalTask, EvalTaskRun } from "./types.js";
import { aggregateSuiteByConfig, rankSuiteConfigs } from "./aggregate.js";
import { buildEvalScore, estimateCostUsd } from "./scoring.js";
import { createModelSet, getModelForTier } from "../llm/provider.js";
import { createRoleRuntime } from "../llm/runtime.js";
import { runRoleDetailed } from "../roles/base.js";
import { implementTask, type TaskDescription } from "../roles/implementer.js";

interface EvalAdapter {
  header?: (text: string) => void;
  subheader?: (text: string) => void;
  info?: (text: string) => void;
  warn?: (text: string) => void;
  error?: (text: string) => void;
}

interface ExecuteTaskParams {
  projectRoot: string;
  compareRunId: string;
  task: EvalTask;
  config: EvalConfig;
  baseConfig: BenderConfig;
  state: StateManager;
  adapter?: EvalAdapter;
}

type ExecuteTaskFn = (params: ExecuteTaskParams) => Promise<EvalTaskRun>;
const DEFAULT_EVAL_CONCURRENCY = 2;

function normalizeConcurrency(value?: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_EVAL_CONCURRENCY;
  return Math.max(1, Math.min(8, Math.floor(value ?? DEFAULT_EVAL_CONCURRENCY)));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = normalizeConcurrency(concurrency);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
}

interface ResolvedExecution {
  role: BaseRole;
  modelTier: ModelTier;
  provider: string;
  model: string;
  pinnedSkills: string[];
  mcpServerIds: string[];
  capabilityPolicy?: CapabilityPolicy;
  agentId: string;
  agentName: string;
  runConfig: BenderConfig;
}

function dedupe(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

function cloneConfig(config: BenderConfig): BenderConfig {
  return JSON.parse(JSON.stringify(config)) as BenderConfig;
}

function resolveTierSnapshot(config: BenderConfig, tier: ModelTier): { provider: string; model: string } {
  const tierModel = config.llm.models[tier];
  if (typeof tierModel === "string") {
    return { provider: config.llm.provider, model: tierModel };
  }
  return {
    provider: tierModel.provider,
    model: tierModel.model,
  };
}

function buildConfigWithModelOverride(base: BenderConfig, evalConfig: EvalConfig, tier: ModelTier): BenderConfig {
  const next = cloneConfig(base);
  if (evalConfig.provider?.trim()) {
    next.llm.provider = evalConfig.provider.trim();
  }
  if (evalConfig.model?.trim()) {
    next.llm.models[tier] = {
      provider: evalConfig.provider?.trim() || next.llm.provider,
      model: evalConfig.model.trim(),
    };
  }
  return next;
}

async function resolveExecution(
  baseConfig: BenderConfig,
  evalConfig: EvalConfig,
): Promise<ResolvedExecution> {
  const role = evalConfig.role;
  const allAgents = await getAllAgents();
  const selectedAgent = evalConfig.agentId
    ? allAgents.find((a) => a.id === evalConfig.agentId && a.baseRole === role)
    : null;
  const fallback = await getEffectiveAgentForRole(role);
  const agent = selectedAgent ?? fallback;

  const modelTier: ModelTier = evalConfig.modelTier ?? agent.modelTier;
  const runConfig = buildConfigWithModelOverride(baseConfig, evalConfig, modelTier);
  const snapshot = resolveTierSnapshot(runConfig, modelTier);

  return {
    role,
    modelTier,
    provider: snapshot.provider,
    model: snapshot.model,
    pinnedSkills: dedupe(evalConfig.pinnedSkills?.length ? evalConfig.pinnedSkills : agent.pinnedSkills),
    mcpServerIds: dedupe(evalConfig.mcpServerIds?.length ? evalConfig.mcpServerIds : agent.mcpServerIds),
    capabilityPolicy: evalConfig.capabilityPolicy ?? agent.capabilityPolicy,
    agentId: agent.id,
    agentName: agent.name,
    runConfig,
  };
}

async function executeTaskForConfig(params: ExecuteTaskParams): Promise<EvalTaskRun> {
  const { projectRoot, compareRunId, task, config, baseConfig, state, adapter } = params;
  const runId = randomUUID();
  const startedAt = Date.now();

  const execution = await resolveExecution(baseConfig, config);
  const connectorResolution = resolveConnectorAccess(
    {
      mcpServerIds: execution.mcpServerIds,
      capabilityPolicy: execution.capabilityPolicy,
    },
    execution.runConfig.mcp?.servers ?? [],
  );
  const enabledTools = [...connectorResolution.allowedConnectorIds].sort();

  adapter?.info?.(`Running ${task.name} with ${config.name} (${execution.provider}/${execution.model})`);

  let output = "";
  let error: string | undefined;
  let usage: EvalTaskRun["usage"];
  let success = false;
  let runtimeSummary: Record<string, unknown> | null = null;

  let runtime: Awaited<ReturnType<typeof createRoleRuntime>> | null = null;
  try {
    runtime = await createRoleRuntime(
      projectRoot,
      execution.runConfig,
      {
        role: execution.role,
        taskDescription: task.prompt,
        pinnedSkills: execution.pinnedSkills,
        mcpServerIds: execution.mcpServerIds,
        capabilityPolicy: execution.capabilityPolicy,
        modelTier: execution.modelTier,
      },
      (await state.readArchitecture()) ?? undefined,
    );
    runtimeSummary = {
      mcpEnabled: runtime.summary.mcpEnabled,
      skillsEnabled: runtime.summary.skillsEnabled,
      mcpTools: runtime.summary.mcpTools,
      skillFiles: runtime.summary.skillFiles,
    };

    const modelSet = createModelSet(execution.runConfig);
    const model = getModelForTier(modelSet, execution.modelTier);
    if (execution.role === "implementer") {
      const context = await state.gatherContext();
      const evalTask: TaskDescription = {
        id: 0,
        title: task.name,
        description: task.prompt,
        files: [],
        acceptanceCriteria: "Implement task successfully.",
      };
      const fileOps = await implementTask(
        model,
        evalTask,
        projectRoot,
        context,
        undefined,
        runtime,
      );
      success = fileOps.length > 0;
      if (!success) {
        error = "Implementer returned no file operations for eval task.";
        output = "";
      } else {
        output = fileOps
          .map((op) => `### FILE: ${op.path}\nACTION: ${op.action}\n\n${op.content}`)
          .join("\n\n");
      }
    } else {
      const result = await runRoleDetailed(
        model,
        execution.role,
        "",
        task.prompt,
        runtime,
      );
      output = result.text;
      usage = result.usage;
      success = result.text.trim().length > 0;
      if (!success) error = "Model returned empty output.";
    }
  } catch (err: unknown) {
    success = false;
    error = (err as Error).message;
  } finally {
    if (runtime) await runtime.close();
  }

  const completedAt = Date.now();
  const durationMs = Math.max(0, completedAt - startedAt);
  const estimatedCostUsd = estimateCostUsd(execution.provider, execution.model, usage);
  const status = success ? "succeeded" : "failed";
  const run: EvalTaskRun = {
    id: runId,
    compareRunId,
    taskId: task.id,
    configId: config.id,
    role: execution.role,
    provider: execution.provider,
    model: execution.model,
    enabledSkills: execution.pinnedSkills,
    enabledTools,
    status,
    success,
    output,
    durationMs,
    usage,
    estimatedCostUsd,
    error,
    trace: {
      agentId: execution.agentId,
      agentName: execution.agentName,
      modelTier: execution.modelTier,
      capabilityPolicy: execution.capabilityPolicy ?? null,
      runtime: runtimeSummary,
    },
    startedAt,
    completedAt,
    score: buildEvalScore({
      success,
      durationMs,
      usage,
      estimatedCostUsd,
    }),
  };
  if (!success) {
    adapter?.warn?.(`${config.name} failed: ${error ?? "Unknown error"}`);
  } else {
    adapter?.info?.(`${config.name} succeeded.`);
  }
  return run;
}

export async function runTaskCompare(params: {
  projectRoot: string;
  task: EvalTask;
  configs: EvalConfig[];
  adapter?: EvalAdapter;
  executeTask?: ExecuteTaskFn;
  concurrency?: number;
}): Promise<{ summary: EvalCompareRunSummary; runs: EvalTaskRun[] }> {
  const { projectRoot, task, configs, adapter, executeTask, concurrency } = params;
  const state = new StateManager(projectRoot);
  const store = new EvalsStore(projectRoot);
  await Promise.all([state.init(), store.init()]);

  const compareRunId = randomUUID();
  const createdAt = Date.now();
  const summaryStart: EvalCompareRunSummary = {
    id: compareRunId,
    taskId: task.id,
    configIds: configs.map((c) => c.id),
    runIds: [],
    status: "running",
    createdAt,
  };
  await store.upsertCompareRunSummary(summaryStart);
  adapter?.header?.(`Evals Compare — ${task.name}`);
  adapter?.info?.(`Running ${configs.length} config(s) with concurrency ${normalizeConcurrency(concurrency)}.`);

  const baseConfig = await readEffectiveConfig(projectRoot);
  const runs: EvalTaskRun[] = [];
  const runIds = new Set<string>();
  await runWithConcurrency(configs, concurrency ?? DEFAULT_EVAL_CONCURRENCY, async (cfg) => {
    if (!cfg.enabled) {
      const now = Date.now();
      const skipped: EvalTaskRun = {
        id: randomUUID(),
        compareRunId,
        taskId: task.id,
        configId: cfg.id,
        role: cfg.role,
        provider: cfg.provider ?? baseConfig.llm.provider,
        model: cfg.model ?? "",
        enabledSkills: dedupe(cfg.pinnedSkills),
        enabledTools: dedupe(cfg.mcpServerIds),
        status: "failed",
        success: false,
        output: "",
        durationMs: 0,
        error: "Config is disabled.",
        trace: {},
        startedAt: now,
        completedAt: now,
        score: buildEvalScore({
          success: false,
          durationMs: 0,
        }),
      };
      await store.writeTaskRun(skipped);
      runs.push(skipped);
      runIds.add(skipped.id);
      await store.upsertCompareRunSummary({
        ...summaryStart,
        runIds: [...runIds],
        status: "running",
      });
      return;
    }

    const run = await (executeTask ?? executeTaskForConfig)({
      projectRoot,
      compareRunId,
      task,
      config: cfg,
      baseConfig,
      state,
      adapter,
    });
    await store.writeTaskRun(run);
    runs.push(run);
    runIds.add(run.id);
    await store.upsertCompareRunSummary({
      ...summaryStart,
      runIds: [...runIds],
      status: "running",
    });
  });

  const summaryEnd: EvalCompareRunSummary = {
    ...summaryStart,
    runIds: [...runIds],
    status: runs.every((r) => r.success) ? "succeeded" : "failed",
    completedAt: Date.now(),
  };
  await store.upsertCompareRunSummary(summaryEnd);
  return { summary: summaryEnd, runs };
}

export async function runSuiteCompare(params: {
  projectRoot: string;
  suite: EvalSuite;
  tasks: EvalTask[];
  configs: EvalConfig[];
  adapter?: EvalAdapter;
  executeTask?: ExecuteTaskFn;
  concurrency?: number;
}): Promise<{ suiteRun: EvalSuiteRun; taskRuns: EvalTaskRun[] }> {
  const { projectRoot, suite, tasks, configs, adapter, executeTask, concurrency } = params;
  const state = new StateManager(projectRoot);
  const store = new EvalsStore(projectRoot);
  await Promise.all([state.init(), store.init()]);

  const suiteRunId = randomUUID();
  const createdAt = Date.now();
  adapter?.header?.(`Evals Suite — ${suite.name}`);
  adapter?.info?.(`Running ${tasks.length * configs.length} task-config run(s) with concurrency ${normalizeConcurrency(concurrency)}.`);
  const baseConfig = await readEffectiveConfig(projectRoot);
  const taskRuns: EvalTaskRun[] = [];

  const jobs = tasks.flatMap((task) => configs.map((config) => ({ task, config })));
  await runWithConcurrency(jobs, concurrency ?? DEFAULT_EVAL_CONCURRENCY, async ({ task, config }) => {
    const run = await (executeTask ?? executeTaskForConfig)({
      projectRoot,
      compareRunId: suiteRunId,
      task,
      config,
      baseConfig,
      state,
      adapter,
    });
    await store.writeTaskRun(run);
    taskRuns.push(run);
  });

  const perConfig = aggregateSuiteByConfig(taskRuns, configs.map((c) => c.id));
  const ranking = rankSuiteConfigs(perConfig);
  const suiteRun: EvalSuiteRun = {
    id: suiteRunId,
    suiteId: suite.id,
    configIds: configs.map((c) => c.id),
    taskRunIds: taskRuns.map((r) => r.id),
    status: taskRuns.every((r) => r.success) ? "succeeded" : "failed",
    createdAt,
    completedAt: Date.now(),
    perConfig,
    ranking,
  };
  await store.writeSuiteRun(suiteRun);
  return { suiteRun, taskRuns };
}
