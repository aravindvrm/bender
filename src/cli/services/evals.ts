import { randomUUID } from "node:crypto";
import { runSuiteCompare, runTaskCompare } from "../../evals/runner.js";
import type {
  EvalCompareRunSummary,
  EvalConfig,
  EvalSuccessMode,
  EvalSuite,
  EvalSuiteRun,
  EvalTask,
  EvalTaskAssertion,
  EvalTaskRun,
} from "../../evals/types.js";
import { EvalsStore } from "../../state/evals.js";
import type { BaseRole } from "../../state/agents.js";
import { MAX_MCP_SERVERS_PER_AGENT, MAX_PINNED_SKILLS_PER_AGENT } from "../../state/agents.js";
import { normalizeCapabilityPolicy } from "../../state/capabilities.js";
import type { ModelTier } from "../../state/config.js";

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS: ModelTier[] = ["fast", "default", "strong"];
const SUCCESS_MODES: EvalSuccessMode[] = ["response-only", "diff-generated", "build-verified", "test-verified"];
const ALLOWED_CONNECTOR_IDS = new Set(["github", "figma", "neon", "vercel"]);
const MAX_EVAL_NAME_CHARS = 120;
const MAX_EVAL_PROMPT_CHARS = 20_000;
const MAX_EVAL_ASSERTIONS = 12;
const MAX_EVAL_ASSERTION_SOURCE_CHARS = 10_000;

interface EvalAdapter {
  header?: (text: string) => void;
  subheader?: (text: string) => void;
  info?: (text: string) => void;
  warn?: (text: string) => void;
  error?: (text: string) => void;
}

export class EvalServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isBaseRole(value: string): value is BaseRole {
  return BASE_ROLES.includes(value as BaseRole);
}

function isModelTier(value: string): value is ModelTier {
  return MODEL_TIERS.includes(value as ModelTier);
}

function isSuccessMode(value: string): value is EvalSuccessMode {
  return SUCCESS_MODES.includes(value as EvalSuccessMode);
}

function normalizePinnedSkills(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new EvalServiceError(400, "pinnedSkills must be an array of skill names");
  }
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const skill = item.trim();
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }
  if (skills.length > MAX_PINNED_SKILLS_PER_AGENT) {
    throw new EvalServiceError(400, `pinnedSkills cannot exceed ${MAX_PINNED_SKILLS_PER_AGENT} items`);
  }
  return skills;
}

function normalizeMcpServerIds(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new EvalServiceError(400, "mcpServerIds must be an array of connector IDs");
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id) || !ALLOWED_CONNECTOR_IDS.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_MCP_SERVERS_PER_AGENT) {
    throw new EvalServiceError(400, `mcpServerIds cannot exceed ${MAX_MCP_SERVERS_PER_AGENT} items`);
  }
  return ids;
}

function parseLimit(input: unknown, fallback = 30): number {
  const parsed = Number.parseInt(String(input ?? fallback), 10) || fallback;
  return Math.max(1, Math.min(200, parsed));
}

function parseConcurrency(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

function requireId(raw: string | undefined, label = "id"): string {
  const id = decodeURIComponent(raw ?? "").trim();
  if (!id) {
    throw new EvalServiceError(400, `${label} is required`);
  }
  return id;
}

function normalizeEvalTaskPayload(input: Partial<EvalTask>): EvalTask {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name) throw new EvalServiceError(400, "name is required");
  if (!prompt) throw new EvalServiceError(400, "prompt is required");
  if (name.length > MAX_EVAL_NAME_CHARS) {
    throw new EvalServiceError(400, `name cannot exceed ${MAX_EVAL_NAME_CHARS} characters`);
  }
  if (prompt.length > MAX_EVAL_PROMPT_CHARS) {
    throw new EvalServiceError(400, `prompt cannot exceed ${MAX_EVAL_PROMPT_CHARS} characters`);
  }

  const now = Date.now();
  return {
    id: input.id?.trim() || randomUUID(),
    name,
    prompt,
    assertions: normalizeEvalTaskAssertions(input.assertions),
    createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
    updatedAt: now,
  };
}

function normalizeEvalTaskAssertions(input: unknown): EvalTaskAssertion[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new EvalServiceError(400, "assertions must be an array");
  }
  const normalized: EvalTaskAssertion[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<EvalTaskAssertion>;
    const id = (raw.id ?? randomUUID()).trim();
    const type = raw.type ?? "javascript";
    const source = (raw.source ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (type !== "javascript") {
      throw new EvalServiceError(400, `Unsupported assertion type: ${String(type)}`);
    }
    if (!source) {
      throw new EvalServiceError(400, "assertion source is required");
    }
    if (source.length > MAX_EVAL_ASSERTION_SOURCE_CHARS) {
      throw new EvalServiceError(400, `assertion source cannot exceed ${MAX_EVAL_ASSERTION_SOURCE_CHARS} characters`);
    }
    seen.add(id);
    normalized.push({
      id,
      type: "javascript",
      source,
      ...(typeof raw.metric === "string" && raw.metric.trim() ? { metric: raw.metric.trim() } : {}),
      ...(raw.enabled === false ? { enabled: false } : { enabled: true }),
    });
  }
  if (normalized.length > MAX_EVAL_ASSERTIONS) {
    throw new EvalServiceError(400, `assertions cannot exceed ${MAX_EVAL_ASSERTIONS} items`);
  }
  return normalized;
}

function normalizeEvalConfigPayload(input: Partial<EvalConfig>): EvalConfig {
  const name = input.name?.trim();
  if (!name) throw new EvalServiceError(400, "name is required");
  if (name.length > MAX_EVAL_NAME_CHARS) {
    throw new EvalServiceError(400, `name cannot exceed ${MAX_EVAL_NAME_CHARS} characters`);
  }

  const roleRaw = input.role;
  if (!roleRaw || !isBaseRole(roleRaw)) {
    throw new EvalServiceError(400, "role must be one of analyzer/architect/planner/implementer/reviewer");
  }

  const modelTierRaw = input.modelTier;
  if (modelTierRaw !== undefined && !isModelTier(modelTierRaw)) {
    throw new EvalServiceError(400, `Invalid modelTier: ${String(modelTierRaw)}`);
  }
  const successModeRaw = input.successMode;
  if (successModeRaw !== undefined && !isSuccessMode(successModeRaw)) {
    throw new EvalServiceError(400, `Invalid successMode: ${String(successModeRaw)}`);
  }

  const now = Date.now();
  const capabilityPolicy = normalizeCapabilityPolicy(input.capabilityPolicy);

  return {
    id: input.id?.trim() || randomUUID(),
    name,
    role: roleRaw,
    enabled: input.enabled !== false,
    ...(modelTierRaw ? { modelTier: modelTierRaw } : {}),
    ...(successModeRaw ? { successMode: successModeRaw } : {}),
    ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
    pinnedSkills: normalizePinnedSkills(input.pinnedSkills ?? []),
    mcpServerIds: normalizeMcpServerIds(input.mcpServerIds ?? []),
    ...(capabilityPolicy ? { capabilityPolicy } : {}),
    createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
    updatedAt: now,
  };
}

function normalizeEvalSuitePayload(input: Partial<EvalSuite>): EvalSuite {
  const name = input.name?.trim();
  if (!name) throw new EvalServiceError(400, "name is required");
  if (name.length > MAX_EVAL_NAME_CHARS) {
    throw new EvalServiceError(400, `name cannot exceed ${MAX_EVAL_NAME_CHARS} characters`);
  }
  if (!Array.isArray(input.taskIds)) {
    throw new EvalServiceError(400, "taskIds must be an array");
  }
  const taskIds = [...new Set(
    input.taskIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean),
  )];
  const now = Date.now();
  return {
    id: input.id?.trim() || randomUUID(),
    name,
    taskIds,
    createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
    updatedAt: now,
  };
}

export async function listEvalTasks(projectRoot: string): Promise<EvalTask[]> {
  const store = new EvalsStore(projectRoot);
  await store.init();
  return await store.listTasks();
}

export async function createEvalTask(projectRoot: string, input: Partial<EvalTask>): Promise<EvalTask> {
  const task = normalizeEvalTaskPayload(input);
  const store = new EvalsStore(projectRoot);
  await store.init();
  await store.upsertTask(task);
  return task;
}

export async function updateEvalTask(projectRoot: string, rawId: string | undefined, input: Partial<EvalTask>): Promise<EvalTask> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  const current = await store.getTask(id);
  if (!current) throw new EvalServiceError(404, "Task not found");
  const task = normalizeEvalTaskPayload({
    ...current,
    ...input,
    id,
    createdAt: current.createdAt,
  });
  await store.upsertTask(task);
  return task;
}

export async function deleteEvalTask(projectRoot: string, rawId: string | undefined): Promise<void> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  await store.deleteTask(id);
  await store.ensureConsistentTaskReferences();
}

export async function listEvalConfigs(projectRoot: string): Promise<EvalConfig[]> {
  const store = new EvalsStore(projectRoot);
  await store.init();
  return await store.listConfigs();
}

export async function createEvalConfig(projectRoot: string, input: Partial<EvalConfig>): Promise<EvalConfig> {
  const config = normalizeEvalConfigPayload(input);
  const store = new EvalsStore(projectRoot);
  await store.init();
  await store.upsertConfig(config);
  return config;
}

export async function updateEvalConfig(projectRoot: string, rawId: string | undefined, input: Partial<EvalConfig>): Promise<EvalConfig> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  const current = await store.getConfig(id);
  if (!current) throw new EvalServiceError(404, "Config not found");
  const config = normalizeEvalConfigPayload({
    ...current,
    ...input,
    id,
    createdAt: current.createdAt,
  });
  await store.upsertConfig(config);
  return config;
}

export async function deleteEvalConfig(projectRoot: string, rawId: string | undefined): Promise<void> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  await store.deleteConfig(id);
}

export async function listEvalSuites(projectRoot: string): Promise<EvalSuite[]> {
  const store = new EvalsStore(projectRoot);
  await store.init();
  return await store.listSuites();
}

export async function createEvalSuite(projectRoot: string, input: Partial<EvalSuite>): Promise<EvalSuite> {
  const suite = normalizeEvalSuitePayload(input);
  const store = new EvalsStore(projectRoot);
  await store.init();
  await store.upsertSuite(suite);
  return suite;
}

export async function updateEvalSuite(projectRoot: string, rawId: string | undefined, input: Partial<EvalSuite>): Promise<EvalSuite> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  const current = await store.getSuite(id);
  if (!current) throw new EvalServiceError(404, "Suite not found");
  const suite = normalizeEvalSuitePayload({
    ...current,
    ...input,
    id,
    createdAt: current.createdAt,
  });
  await store.upsertSuite(suite);
  return suite;
}

export async function deleteEvalSuite(projectRoot: string, rawId: string | undefined): Promise<void> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  await store.deleteSuite(id);
}

export async function listCompareRuns(projectRoot: string, limitQuery: unknown): Promise<EvalCompareRunSummary[]> {
  const store = new EvalsStore(projectRoot);
  await store.init();
  return await store.listCompareRuns(parseLimit(limitQuery));
}

export async function getCompareRun(projectRoot: string, rawId: string | undefined): Promise<{
  summary: EvalCompareRunSummary;
  runs: EvalTaskRun[];
}> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  const summary = await store.getCompareRunSummary(id);
  if (!summary) throw new EvalServiceError(404, "Compare run not found");
  const runs = await store.getTaskRuns(summary.runIds);
  return { summary, runs };
}

export async function listSuiteRuns(projectRoot: string, limitQuery: unknown): Promise<EvalSuiteRun[]> {
  const store = new EvalsStore(projectRoot);
  await store.init();
  return await store.listSuiteRuns(parseLimit(limitQuery));
}

export async function getSuiteRun(projectRoot: string, rawId: string | undefined): Promise<{
  suiteRun: EvalSuiteRun;
  taskRuns: EvalTaskRun[];
}> {
  const id = requireId(rawId);
  const store = new EvalsStore(projectRoot);
  await store.init();
  const suiteRun = await store.getSuiteRun(id);
  if (!suiteRun) throw new EvalServiceError(404, "Suite run not found");
  const taskRuns = await store.getTaskRuns(suiteRun.taskRunIds);
  return { suiteRun, taskRuns };
}

export async function runEvalCompare(
  projectRoot: string,
  input: { taskId?: string; configIds?: string[]; concurrency?: number },
  adapter?: EvalAdapter,
): Promise<{
  runs: EvalTaskRun[];
  configNameById: Map<string, string>;
}> {
  const taskId = (input.taskId ?? "").trim();
  if (!taskId) throw new EvalServiceError(400, "taskId is required");

  const requestedConfigIds = Array.isArray(input.configIds)
    ? input.configIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean)
    : [];
  if (requestedConfigIds.length === 0) {
    throw new EvalServiceError(400, "At least one configId is required");
  }

  const store = new EvalsStore(projectRoot);
  await store.init();
  const task = await store.getTask(taskId);
  if (!task) throw new EvalServiceError(400, `Eval task not found: ${taskId}`);
  const configs = (await store.listConfigs()).filter((c) => requestedConfigIds.includes(c.id));
  if (configs.length === 0) throw new EvalServiceError(400, "No valid eval configs selected.");
  const concurrency = parseConcurrency(input.concurrency);

  const result = await runTaskCompare({
    projectRoot,
    task,
    configs,
    adapter,
    concurrency,
  });

  return {
    runs: result.runs,
    configNameById: new Map(configs.map((c) => [c.id, c.name])),
  };
}

export async function runEvalSuite(
  projectRoot: string,
  rawSuiteId: string | undefined,
  input: { configIds?: string[]; concurrency?: number },
  adapter?: EvalAdapter,
): Promise<{
  suiteRun: EvalSuiteRun;
  taskRuns: EvalTaskRun[];
}> {
  const suiteId = requireId(rawSuiteId, "suiteId");
  const store = new EvalsStore(projectRoot);
  await store.init();

  const suite = await store.getSuite(suiteId);
  if (!suite) throw new EvalServiceError(400, `Eval suite not found: ${suiteId}`);
  const allTasks = await store.listTasks();
  const tasks = suite.taskIds.map((id) => allTasks.find((t) => t.id === id)).filter((t): t is EvalTask => !!t);
  if (tasks.length === 0) throw new EvalServiceError(400, "Suite has no valid tasks.");

  const requestedConfigIds = Array.isArray(input.configIds)
    ? input.configIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean)
    : [];
  const allConfigs = await store.listConfigs();
  const configs = requestedConfigIds.length > 0
    ? allConfigs.filter((c) => requestedConfigIds.includes(c.id))
    : allConfigs.filter((c) => c.enabled);
  if (configs.length === 0) {
    throw new EvalServiceError(400, "No eval configs available for suite run.");
  }
  const concurrency = parseConcurrency(input.concurrency);

  return await runSuiteCompare({
    projectRoot,
    suite,
    tasks,
    configs,
    adapter,
    concurrency,
  });
}
