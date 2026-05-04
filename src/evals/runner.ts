import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type {
  Assertion,
  AssertionValueFunctionContext,
  CallApiContextParams,
  CallApiFunction,
  EvaluateResult,
  GradingResult,
  TokenUsage as PromptfooTokenUsage,
  evaluate as PromptfooEvaluate,
} from "promptfoo";

/**
 * Lazy-load promptfoo. The desktop bundle marks `promptfoo` as external and
 * does NOT ship it (it brings ~5GB of cloud SDKs as transitive deps). Eval
 * functionality is therefore source-only; callers should catch the import
 * failure and surface a clear error.
 */
async function loadPromptfoo(): Promise<typeof PromptfooEvaluate> {
  try {
    const mod = await import("promptfoo");
    return mod.evaluate;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Eval support requires the 'promptfoo' package, which is not installed in this build. ` +
      `Run from source or install it manually. Original error: ${detail}`,
    );
  }
}
import type { BaseRole } from "../state/agents.js";
import { getAllAgents, getEffectiveAgentForRole } from "../state/agents.js";
import type { CapabilityPolicy } from "../state/capabilities.js";
import { resolveConnectorAccess } from "../state/capabilities.js";
import type { BenderConfig, ModelTier } from "../state/config.js";
import { readEffectiveConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { EvalsStore } from "../state/evals.js";
import type {
  EvalCompareRunSummary,
  EvalAssertionResult,
  EvalAssertionSummary,
  EvalConfig,
  EvalSuite,
  EvalSuiteRun,
  EvalSuccessMode,
  EvalTask,
  EvalTaskAssertion,
  EvalTaskRun,
} from "./types.js";
import { aggregateSuiteByConfig, rankSuiteConfigs } from "./aggregate.js";
import { buildEvalScore, estimateCostUsd } from "./scoring.js";
import { createModelSet, getModelForTier } from "../llm/provider.js";
import { createRoleRuntime } from "../llm/runtime.js";
import { runRoleDetailed } from "../roles/base.js";
import { implementTask, type TaskDescription } from "../roles/implementer.js";

const execAsync = promisify(execCb);

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
const VERIFICATION_TIMEOUT_MS = 120_000;
const VERIFICATION_MAX_BUFFER = 1024 * 1024;
const PROMPTFOO_PROVIDER_PREFIX = "bender-config:";

interface BenderPromptfooMetadata {
  runId: string;
  configId: string;
  taskId: string;
  role: BaseRole;
  provider: string;
  model: string;
  enabledSkills: string[];
  enabledTools: string[];
  durationMs: number;
  usage?: EvalTaskRun["usage"];
  estimatedCostUsd?: number | null;
  error?: string;
  trace: Record<string, unknown>;
  startedAt: number;
  completedAt: number;
  success: boolean;
  output: string;
}

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

function makeDisabledConfigRun(params: {
  compareRunId: string;
  taskId: string;
  config: EvalConfig;
  defaultProvider: string;
}): EvalTaskRun {
  const now = Date.now();
  return {
    id: randomUUID(),
    compareRunId: params.compareRunId,
    taskId: params.taskId,
    configId: params.config.id,
    role: params.config.role,
    provider: params.config.provider ?? params.defaultProvider,
    model: params.config.model ?? "",
    enabledSkills: dedupe(params.config.pinnedSkills),
    enabledTools: dedupe(params.config.mcpServerIds),
    status: "failed",
    success: false,
    output: "",
    durationMs: 0,
    error: "Config is disabled.",
    trace: {},
    assertionSummary: {
      total: 1,
      passed: 0,
      failed: 1,
      score: 0,
      reason: "Config is disabled.",
    },
    assertions: [
      {
        id: "1",
        type: "bender-config",
        metric: "enabled",
        pass: false,
        score: 0,
        reason: "Config is disabled.",
        raw: null,
      },
    ],
    startedAt: now,
    completedAt: now,
    score: buildEvalScore({
      success: false,
      durationMs: 0,
    }),
  };
}

interface ResolvedExecution {
  role: BaseRole;
  modelTier: ModelTier;
  provider: string;
  model: string;
  pinnedSkills: string[];
  mcpServerIds: string[];
  capabilityPolicy?: CapabilityPolicy;
  systemPromptAddition?: string;
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

function resolveSuccessMode(config: EvalConfig): EvalSuccessMode {
  return config.successMode ?? "response-only";
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  const packageJsonPath = `${projectRoot}/package.json`;
  if (!existsSync(packageJsonPath)) return {};
  try {
    const raw = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === "string" && value.trim()) {
        out[name] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function runVerificationCommand(
  projectRoot: string,
  command: string,
): Promise<{ passed: boolean; command: string; output?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectRoot,
      timeout: VERIFICATION_TIMEOUT_MS,
      maxBuffer: VERIFICATION_MAX_BUFFER,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return { passed: true, command, ...(output ? { output } : {}) };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [
      (execErr.stdout ?? "").trim(),
      (execErr.stderr ?? "").trim(),
    ].filter(Boolean).join("\n");
    const message = execErr.message ?? "Verification command failed.";
    return { passed: false, command, error: output || message };
  }
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
    systemPromptAddition: agent.systemPromptAddition,
    agentId: agent.id,
    agentName: agent.name,
    runConfig,
  };
}

function promptfooProviderId(configId: string): string {
  return `${PROMPTFOO_PROVIDER_PREFIX}${configId}`;
}

function configIdFromPromptfooProviderId(providerId: string): string | null {
  return providerId.startsWith(PROMPTFOO_PROVIDER_PREFIX)
    ? providerId.slice(PROMPTFOO_PROVIDER_PREFIX.length)
    : null;
}

function toPromptfooTokenUsage(usage?: EvalTaskRun["usage"]): PromptfooTokenUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt: usage.inputTokens,
    completion: usage.outputTokens,
    total: usage.totalTokens,
  };
}

function toEvalUsage(usage?: Partial<PromptfooTokenUsage>): EvalTaskRun["usage"] | undefined {
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt === "number" ? usage.prompt : undefined;
  const outputTokens = typeof usage.completion === "number" ? usage.completion : undefined;
  const totalTokens = typeof usage.total === "number"
    ? usage.total
    : (typeof inputTokens === "number" || typeof outputTokens === "number")
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractAssertionResults(result: EvaluateResult): {
  assertions: EvalAssertionResult[];
  summary: EvalAssertionSummary;
} {
  const grading = result.gradingResult ?? null;
  const components = grading?.componentResults?.length
    ? grading.componentResults
    : grading
      ? [grading]
      : [];
  const assertions = components.map((component, index) => {
    const assertionMeta = toRecord(component.assertion);
    return {
      id: String(index + 1),
      type: typeof assertionMeta.type === "string" ? assertionMeta.type : "unknown",
      ...(typeof assertionMeta.metric === "string" ? { metric: assertionMeta.metric } : {}),
      pass: !!component.pass,
      score: toNumberOrNull(component.score),
      ...(typeof component.reason === "string" && component.reason.trim() ? { reason: component.reason.trim() } : {}),
      raw: toRecord(component.metadata ?? {}),
    } satisfies EvalAssertionResult;
  });
  const passed = assertions.filter((a) => a.pass).length;
  const failed = assertions.length - passed;
  return {
    assertions,
    summary: {
      total: assertions.length,
      passed,
      failed,
      score: toNumberOrNull(result.score),
      ...(typeof grading?.reason === "string" && grading.reason.trim() ? { reason: grading.reason.trim() } : {}),
    },
  };
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeCustomAssertionResult(
  value: unknown,
  assertionId: string,
): boolean | number | GradingResult {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const pass = typeof rec.pass === "boolean" ? rec.pass : undefined;
    const score = typeof rec.score === "number" ? rec.score : undefined;
    const reason = typeof rec.reason === "string" ? rec.reason : undefined;
    if (pass !== undefined || score !== undefined) {
      return {
        pass: pass ?? false,
        score: score ?? (pass ? 1 : 0),
        reason: reason ?? `Custom assertion ${assertionId}`,
        ...(rec && Object.keys(rec).length > 0 ? { metadata: rec } : {}),
      };
    }
  }
  return {
    pass: false,
    score: 0,
    reason: `Custom assertion ${assertionId} returned an unsupported value`,
  };
}

function compileCustomAssertion(assertion: EvalTaskAssertion): Assertion {
  return {
    type: "javascript",
    metric: assertion.metric?.trim() || assertion.id,
    value: async (output: string, context: AssertionValueFunctionContext) => {
      try {
        const runtime = toRecord(context.providerResponse?.metadata).bender;
        const fn = new Function("output", "context", "runtime", `"use strict";\n${assertion.source}`);
        const raw = await Promise.resolve(fn(output, context, runtime));
        return normalizeCustomAssertionResult(raw, assertion.id);
      } catch (err) {
        return {
          pass: false,
          score: 0,
          reason: `Custom assertion ${assertion.id} failed: ${safeErrorMessage(err)}`,
        };
      }
    },
  };
}

function buildTaskAssertions(task: EvalTask): Assertion[] {
  const defaults: Assertion[] = [
    {
      type: "javascript",
      metric: "bender-success",
      value: (_output: string, context: AssertionValueFunctionContext) => {
        const meta = toRecord(context.providerResponse?.metadata).bender;
        const pass = !!(meta && typeof meta === "object" && (meta as Record<string, unknown>).success === true);
        const reason = pass
          ? "Bender execution succeeded."
          : ((meta as Record<string, unknown> | undefined)?.error as string | undefined) ?? "Bender execution failed.";
        return {
          pass,
          score: pass ? 1 : 0,
          reason,
        };
      },
    },
  ];
  const custom = (task.assertions ?? [])
    .filter((assertion) => assertion.enabled !== false)
    .map((assertion) => compileCustomAssertion(assertion));
  return [...defaults, ...custom];
}

async function executeTaskForConfig(params: ExecuteTaskParams): Promise<EvalTaskRun> {
  const { projectRoot, compareRunId, task, config, baseConfig, state, adapter } = params;
  const runId = randomUUID();
  const startedAt = Date.now();
  const successMode = resolveSuccessMode(config);

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
  let verification: { passed: boolean; command: string; output?: string; error?: string } | undefined;
  let generatedDiff = false;
  let generatedResponse = false;

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
        systemPromptAddition: execution.systemPromptAddition,
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
        id: "task-eval",
        title: task.name,
        description: task.prompt,
        acceptanceCriteria: ["Implement task successfully."],
      };
      const fileOps = await implementTask(
        model,
        evalTask,
        projectRoot,
        context,
        undefined,
        runtime,
      );
      generatedDiff = fileOps.length > 0;
      if (!generatedDiff) {
        error = "Implementer returned no file operations for eval task.";
        output = "";
      } else {
        output = fileOps
          .map((op) => `### FILE: ${op.path}\nACTION: ${op.action}\n\n${op.content}`)
          .join("\n\n");
      }
      generatedResponse = output.trim().length > 0;
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
      generatedResponse = result.text.trim().length > 0;
      if (!generatedResponse) error = "Model returned empty output.";
    }

    const responseSuccess = generatedResponse;
    const diffSuccess = execution.role === "implementer" ? generatedDiff : generatedResponse;
    if (successMode === "response-only") {
      success = responseSuccess;
    } else if (successMode === "diff-generated") {
      success = diffSuccess;
    } else {
      if (!diffSuccess) {
        success = false;
        if (!error) {
          error = successMode === "build-verified"
            ? "No file changes produced before build verification."
            : "No file changes produced before test verification.";
        }
      } else {
        const scripts = await readPackageScripts(projectRoot);
        const verificationCommand = successMode === "build-verified"
          ? (scripts.build ? "npm run -s build" : undefined)
          : (execution.runConfig.test.command?.trim() || (scripts.test ? "npm run -s test" : undefined));
        if (!verificationCommand) {
          success = false;
          verification = {
            passed: false,
            command: "",
            error: successMode === "build-verified"
              ? "No build command found. Add package.json scripts.build."
              : "No test command found. Set config.test.command or package.json scripts.test.",
          };
          error = verification.error;
        } else {
          adapter?.info?.(`Verifying ${config.name} with: ${verificationCommand}`);
          verification = await runVerificationCommand(projectRoot, verificationCommand);
          success = verification.passed;
          if (!success) {
            error = verification.error
              ? `Verification failed: ${verification.error}`
              : "Verification command failed.";
          }
        }
      }
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
      successMode,
      verification: verification ?? null,
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

function toPromptfooMetadata(run: EvalTaskRun): BenderPromptfooMetadata {
  return {
    runId: run.id,
    configId: run.configId,
    taskId: run.taskId,
    role: run.role,
    provider: run.provider,
    model: run.model,
    enabledSkills: [...run.enabledSkills],
    enabledTools: [...run.enabledTools],
    durationMs: run.durationMs,
    usage: run.usage,
    estimatedCostUsd: run.estimatedCostUsd ?? null,
    error: run.error,
    trace: run.trace,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    success: run.success,
    output: run.output,
  };
}

async function runPromptfooMatrix(params: {
  projectRoot: string;
  compareRunId: string;
  tasks: EvalTask[];
  configs: EvalConfig[];
  adapter?: EvalAdapter;
  concurrency?: number;
}): Promise<EvalTaskRun[]> {
  const { projectRoot, compareRunId, tasks, configs, adapter, concurrency } = params;
  const state = new StateManager(projectRoot);
  await state.init();
  const baseConfig = await readEffectiveConfig(projectRoot);

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const configById = new Map(configs.map((config) => [config.id, config]));
  const promptfooRuns = new Map<string, EvalTaskRun>();

  const providers = configs.map((config) => {
    const provider: CallApiFunction = async (_prompt: string, context?: CallApiContextParams) => {
      const rawTaskId = context?.vars?.taskId;
      const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
      const task = taskById.get(taskId);
      if (!task) {
        return {
          error: `Unknown eval task: ${taskId || "(missing)"}`,
          output: "",
        };
      }
      const run = await executeTaskForConfig({
        projectRoot,
        compareRunId,
        task,
        config,
        baseConfig,
        state,
        adapter,
      });
      promptfooRuns.set(`${task.id}:${config.id}`, run);
      return {
        output: run.output,
        error: run.error,
        tokenUsage: toPromptfooTokenUsage(run.usage),
        cost: run.estimatedCostUsd ?? undefined,
        latencyMs: run.durationMs,
        metadata: {
          bender: toPromptfooMetadata(run),
        },
      };
    };
    provider.label = promptfooProviderId(config.id);
    return provider;
  });

  const tests = tasks.map((task) => ({
    description: task.name,
    vars: {
      taskId: task.id,
      taskPrompt: task.prompt,
    },
    assert: buildTaskAssertions(task),
    metadata: {
      taskId: task.id,
    },
  }));

  const promptfooEvaluate = await loadPromptfoo();
  const evaluated = await promptfooEvaluate(
    {
      prompts: ["{{taskPrompt}}"],
      providers,
      tests,
      writeLatestResults: false,
      description: `Bender eval run ${compareRunId}`,
    },
    {
      maxConcurrency: normalizeConcurrency(concurrency),
    },
  );
  const summary = await evaluated.toEvaluateSummary();
  const results = summary.results as EvaluateResult[];

  const runs: EvalTaskRun[] = [];
  for (const result of results) {
    const providerId = result.provider.id ?? "";
    const benderMeta = toRecord(result.response?.metadata).bender;
    const runtimeMeta = toRecord(benderMeta);
    const configId = configIdFromPromptfooProviderId(providerId)
      ?? (typeof runtimeMeta.configId === "string" ? runtimeMeta.configId : null);
    if (!configId) continue;
    const config = configById.get(configId);
    if (!config) continue;
    const rawTaskId = result.testCase?.vars?.taskId;
    const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
    const task = taskById.get(taskId);
    if (!task) continue;

    const key = `${task.id}:${config.id}`;
    const baseRun = promptfooRuns.get(key);
    const usage = toEvalUsage(result.tokenUsage) ?? baseRun?.usage;
    const estimatedCostUsd = typeof result.cost === "number"
      ? result.cost
      : (typeof result.response?.cost === "number"
        ? result.response.cost
        : (baseRun?.estimatedCostUsd ?? estimateCostUsd(baseRun?.provider ?? "", baseRun?.model ?? "", usage)));
    const output = formatOutput(result.response?.output ?? baseRun?.output ?? "");
    const error = result.error ?? result.response?.error ?? baseRun?.error;
    const durationMs = Number.isFinite(result.latencyMs) && result.latencyMs > 0
      ? Math.round(result.latencyMs)
      : Math.max(0, baseRun?.durationMs ?? 0);
    const { assertions, summary: assertionSummary } = extractAssertionResults(result);

    const runId = typeof runtimeMeta.runId === "string" ? runtimeMeta.runId : randomUUID();
    const startedAt = typeof runtimeMeta.startedAt === "number" ? runtimeMeta.startedAt : Date.now();
    const completedAt = typeof runtimeMeta.completedAt === "number"
      ? runtimeMeta.completedAt
      : startedAt + durationMs;

    const provider = typeof runtimeMeta.provider === "string"
      ? runtimeMeta.provider
      : (baseRun?.provider ?? config.provider ?? baseConfig.llm.provider);
    const model = typeof runtimeMeta.model === "string"
      ? runtimeMeta.model
      : (baseRun?.model ?? config.model ?? "");
    const enabledSkills = Array.isArray(runtimeMeta.enabledSkills)
      ? (runtimeMeta.enabledSkills.filter((v): v is string => typeof v === "string"))
      : (baseRun?.enabledSkills ?? dedupe(config.pinnedSkills));
    const enabledTools = Array.isArray(runtimeMeta.enabledTools)
      ? (runtimeMeta.enabledTools.filter((v): v is string => typeof v === "string"))
      : (baseRun?.enabledTools ?? dedupe(config.mcpServerIds));
    const role = (typeof runtimeMeta.role === "string" ? runtimeMeta.role : baseRun?.role ?? config.role) as BaseRole;

    const success = !!result.success;
    const run: EvalTaskRun = {
      id: runId,
      compareRunId,
      taskId: task.id,
      configId: config.id,
      role,
      provider,
      model,
      enabledSkills,
      enabledTools,
      status: success ? "succeeded" : "failed",
      success,
      output,
      durationMs,
      usage,
      estimatedCostUsd: typeof estimatedCostUsd === "number" && Number.isFinite(estimatedCostUsd) ? Number(estimatedCostUsd.toFixed(6)) : null,
      error: error ? String(error) : undefined,
      trace: {
        ...(baseRun?.trace ?? {}),
        promptfoo: {
          providerId,
          providerLabel: result.provider.label ?? null,
          promptId: result.promptId,
          failureReason: result.failureReason,
          namedScores: result.namedScores,
          metadata: result.metadata ?? null,
        },
      },
      assertionSummary,
      assertions,
      promptfoo: {
        provider: result.provider,
        gradingResult: result.gradingResult ?? null,
        namedScores: result.namedScores,
        failureReason: result.failureReason,
        metadata: result.metadata ?? null,
      },
      startedAt,
      completedAt,
      score: {
        success: success ? 1 : 0,
        latencyMs: durationMs,
        tokenUsage: usage?.totalTokens ?? null,
        estimatedCostUsd: typeof estimatedCostUsd === "number" && Number.isFinite(estimatedCostUsd) ? Number(estimatedCostUsd.toFixed(6)) : null,
      },
    };
    runs.push(run);
  }

  return runs;
}

export async function runTaskCompare(params: {
  projectRoot: string;
  task: EvalTask;
  configs: EvalConfig[];
  adapter?: EvalAdapter;
  executeTask?: ExecuteTaskFn;
  concurrency?: number;
}): Promise<{ summary: EvalCompareRunSummary; runs: EvalTaskRun[] }> {
  if (params.executeTask) {
    return await runTaskCompareLegacy(params);
  }

  const { projectRoot, task, configs, adapter, concurrency } = params;
  const store = new EvalsStore(projectRoot);
  await store.init();

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
  adapter?.info?.(`Running ${configs.length} config(s) with concurrency ${normalizeConcurrency(concurrency)} via Promptfoo.`);

  const baseConfig = await readEffectiveConfig(projectRoot);
  const enabledConfigs = configs.filter((cfg) => cfg.enabled);
  const runs = await runPromptfooMatrix({
    projectRoot,
    compareRunId,
    tasks: [task],
    configs: enabledConfigs,
    adapter,
    concurrency,
  });
  for (const disabled of configs.filter((cfg) => !cfg.enabled)) {
    runs.push(makeDisabledConfigRun({
      compareRunId,
      taskId: task.id,
      config: disabled,
      defaultProvider: baseConfig.llm.provider,
    }));
  }

  for (const run of runs) {
    await store.writeTaskRun(run);
  }
  const runIds = runs.map((run) => run.id);
  const summaryEnd: EvalCompareRunSummary = {
    ...summaryStart,
    runIds,
    status: runs.length > 0 && runs.every((r) => r.success) ? "succeeded" : "failed",
    completedAt: Date.now(),
  };
  await store.upsertCompareRunSummary(summaryEnd);
  return { summary: summaryEnd, runs };
}

async function runTaskCompareLegacy(params: {
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
  if (params.executeTask) {
    return await runSuiteCompareLegacy(params);
  }

  const { projectRoot, suite, tasks, configs, adapter, concurrency } = params;
  const store = new EvalsStore(projectRoot);
  await store.init();

  const suiteRunId = randomUUID();
  const createdAt = Date.now();
  adapter?.header?.(`Evals Suite — ${suite.name}`);
  adapter?.info?.(`Running ${tasks.length * configs.length} task-config run(s) with concurrency ${normalizeConcurrency(concurrency)} via Promptfoo.`);

  const baseConfig = await readEffectiveConfig(projectRoot);
  const enabledConfigs = configs.filter((cfg) => cfg.enabled);
  const taskRuns = await runPromptfooMatrix({
    projectRoot,
    compareRunId: suiteRunId,
    tasks,
    configs: enabledConfigs,
    adapter,
    concurrency,
  });
  for (const disabled of configs.filter((cfg) => !cfg.enabled)) {
    for (const task of tasks) {
      taskRuns.push(makeDisabledConfigRun({
        compareRunId: suiteRunId,
        taskId: task.id,
        config: disabled,
        defaultProvider: baseConfig.llm.provider,
      }));
    }
  }
  for (const run of taskRuns) {
    await store.writeTaskRun(run);
  }

  const perConfig = aggregateSuiteByConfig(taskRuns, configs.map((c) => c.id));
  const ranking = rankSuiteConfigs(perConfig);
  const suiteRun: EvalSuiteRun = {
    id: suiteRunId,
    suiteId: suite.id,
    configIds: configs.map((c) => c.id),
    taskRunIds: taskRuns.map((r) => r.id),
    status: taskRuns.length > 0 && taskRuns.every((r) => r.success) ? "succeeded" : "failed",
    createdAt,
    completedAt: Date.now(),
    perConfig,
    ranking,
  };
  await store.writeSuiteRun(suiteRun);
  return { suiteRun, taskRuns };
}

async function runSuiteCompareLegacy(params: {
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
