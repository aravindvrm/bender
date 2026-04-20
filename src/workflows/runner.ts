import { randomUUID } from "node:crypto";
import { extractGitHubWorkItems } from "../cli/services/github-work-items.js";
import { runEvalCompare, runEvalSuite } from "../cli/services/evals.js";
import {
  runAnalyzeOperation,
  runImplementOperation,
  runIterativePlanOperation,
  runReviewOperation,
} from "../cli/services/run-operations.js";
import { StateManager } from "../state/manager.js";
import type { SpinnerAdapter, UIAdapter } from "../cli/adapter.js";
import type {
  BuiltinWorkflowAction,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowStep,
} from "./types.js";

interface GitHubSession {
  accessToken: string;
}

interface WorkflowRunnerDeps {
  readGitHubSession?: () => Promise<GitHubSession | null>;
  githubApi?: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

interface WorkflowExecutionState {
  input: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  lastOutput: Record<string, unknown> | null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function getByPath(source: unknown, path: string): unknown {
  if (!path.trim()) return source;
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolvePath(state: WorkflowExecutionState, rawPath: string): unknown {
  const path = rawPath.trim();
  if (!path) return undefined;
  if (path.startsWith("input.")) return getByPath(state.input, path.slice("input.".length));
  if (path === "input") return state.input;
  if (path.startsWith("steps.")) return getByPath(state.steps, path.slice("steps.".length));
  if (path === "steps") return state.steps;
  if (path === "lastOutput") return state.lastOutput;
  if (path.startsWith("lastOutput.")) return getByPath(state.lastOutput, path.slice("lastOutput.".length));
  if (Object.prototype.hasOwnProperty.call(state.steps, path)) return state.steps[path];
  return getByPath(state.input, path);
}

function renderTemplate(template: string, state: WorkflowExecutionState): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr) => {
    const value = resolvePath(state, String(expr));
    return toStringValue(value);
  });
}

function materializeTemplateValue(value: unknown, state: WorkflowExecutionState): unknown {
  if (typeof value === "string") {
    return renderTemplate(value, state);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeTemplateValue(entry, state));
  }
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = materializeTemplateValue(entry, state);
  }
  return out;
}

function createWorkflowAdapter(logs: string[]): UIAdapter {
  const push = (kind: "info" | "success" | "warn" | "error", text: string): void => {
    logs.push(`[${kind}] ${text}`);
  };
  const spinner = (text: string): SpinnerAdapter => ({
    text,
    start: () => push("info", text),
    stop: () => push("info", text),
    succeed: (value?: string) => push("success", value ?? text),
    fail: (value?: string) => push("error", value ?? text),
  });

  return {
    header: (text) => push("info", text),
    subheader: (text) => push("info", text),
    info: (text) => push("info", text),
    success: (text) => push("success", text),
    warn: (text) => push("warn", text),
    error: (text) => push("error", text),
    streamWriter: () => (chunk: string) => {
      if (chunk.trim()) push("info", chunk.trim());
    },
    spinner,
    confirm: async () => true,
    promptMultiline: async () => "",
    showFileOperations: () => undefined,
    cleanup: () => undefined,
  };
}

function parseConditionMatch(
  config: Record<string, unknown>,
  state: WorkflowExecutionState,
): { matched: boolean; value: unknown } {
  const field = typeof config.field === "string" ? config.field : "";
  const value = field ? resolvePath(state, field) : undefined;
  if (Object.prototype.hasOwnProperty.call(config, "equals")) {
    return { matched: Object.is(value, config.equals), value };
  }
  if (Object.prototype.hasOwnProperty.call(config, "truthy")) {
    const expected = Boolean(config.truthy);
    return { matched: Boolean(value) === expected, value };
  }
  return { matched: Boolean(value), value };
}

function parseStepInputSnapshot(step: WorkflowStep, state: WorkflowExecutionState): Record<string, unknown> {
  return {
    stepId: step.id,
    stepType: step.type,
    stepConfig: step.config,
    hasLastOutput: Boolean(state.lastOutput),
  };
}

async function executeActionStep(
  projectRoot: string,
  step: WorkflowStep,
  state: WorkflowExecutionState,
  deps: WorkflowRunnerDeps,
): Promise<Record<string, unknown>> {
  const logs: string[] = [];
  const adapter = createWorkflowAdapter(logs);
  const config = step.config;
  const action = String(config.action ?? "").trim() as BuiltinWorkflowAction;
  if (!action) throw new Error(`Step '${step.id}' is missing action`);

  const bodyTemplate = config.bodyTemplate;
  const body = toRecord(materializeTemplateValue(bodyTemplate ?? {}, state));

  if (action === "analyze") {
    await runAnalyzeOperation(projectRoot, adapter);
    return { action, message: "Analyze completed.", logs };
  }

  if (action === "implement") {
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : undefined;
    await runImplementOperation(projectRoot, taskId ? { taskId } : {}, adapter);
    return { action, taskId, completed: true, message: "Implement completed.", logs };
  }

  if (action === "review") {
    const result = await runReviewOperation(
      projectRoot,
      {
        taskTitle: typeof body.taskTitle === "string" ? body.taskTitle : undefined,
        staged: typeof body.staged === "boolean" ? body.staged : undefined,
        range: typeof body.range === "string" ? body.range : undefined,
      },
      adapter,
    );
    return { action, ...result, logs };
  }

  if (action === "plan") {
    const result = await runIterativePlanOperation(
      projectRoot,
      {
        feature: typeof body.feature === "string" ? body.feature : undefined,
        mode: body.mode === "commit" ? "commit" : "proposal",
        includeArchitectureImpact: body.includeArchitectureImpact !== false,
        officeHoursMode: body.officeHoursMode === "pressure-test" ? "pressure-test" : "off",
      },
      adapter,
    );
    return { action, ...toRecord(result), logs };
  }

  if (action === "eval") {
    if (typeof body.suiteId === "string" && body.suiteId.trim()) {
      const suiteRun = await runEvalSuite(
        projectRoot,
        body.suiteId.trim(),
        {
          configIds: Array.isArray(body.configIds)
            ? body.configIds.map((value) => String(value).trim()).filter(Boolean)
            : undefined,
          concurrency: typeof body.concurrency === "number" ? body.concurrency : undefined,
        },
        adapter,
      );
      return { action, suiteId: body.suiteId, ...toRecord(suiteRun), logs };
    }

    const compare = await runEvalCompare(
      projectRoot,
      {
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
        configIds: Array.isArray(body.configIds)
          ? body.configIds.map((value) => String(value).trim()).filter(Boolean)
          : undefined,
        concurrency: typeof body.concurrency === "number" ? body.concurrency : undefined,
      },
      adapter,
    );
    return { action, ...toRecord(compare), logs };
  }

  if (action === "github-issue-extract-candidates") {
    if (!deps.readGitHubSession || !deps.githubApi) {
      throw new Error("GitHub workflow action requires github dependencies.");
    }
    let workItems: Array<Record<string, unknown>>;
    if (Array.isArray(body.workItems) && body.workItems.length > 0) {
      workItems = body.workItems.map((item) => toRecord(item));
    } else {
      const issueNumberRaw = body.issueNumber;
      const issueNumber = typeof issueNumberRaw === "number"
        ? issueNumberRaw
        : Number.parseInt(String(issueNumberRaw ?? ""), 10);
      if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
        throw new Error("github-issue-extract-candidates requires issueNumber or workItems.");
      }
      workItems = [{
        sourceType: "issue",
        issueNumber,
        repoFullName: typeof body.repoFullName === "string" ? body.repoFullName.trim() : "",
      }];
    }

    const extraction = await extractGitHubWorkItems(
      projectRoot,
      { workItems },
      { readGitHubSession: deps.readGitHubSession, githubApi: deps.githubApi },
    );
    return { action, ...toRecord(extraction), logs };
  }

  throw new Error(`Unsupported workflow action: ${action}`);
}

async function executeStep(
  projectRoot: string,
  step: WorkflowStep,
  state: WorkflowExecutionState,
  deps: WorkflowRunnerDeps,
): Promise<{ output: Record<string, unknown>; skipNext: boolean }> {
  if (step.type === "prompt") {
    const template = typeof step.config.template === "string" ? step.config.template : "";
    const text = template ? renderTemplate(template, state) : "";
    return {
      output: {
        prompt: text,
      },
      skipNext: false,
    };
  }

  if (step.type === "action") {
    const output = await executeActionStep(projectRoot, step, state, deps);
    return { output, skipNext: false };
  }

  if (step.type === "condition") {
    const { matched, value } = parseConditionMatch(step.config, state);
    return {
      output: {
        matched,
        value,
      },
      skipNext: !matched,
    };
  }

  if (step.type === "extract") {
    const from = typeof step.config.from === "string" ? step.config.from : "lastOutput";
    const source = resolvePath(state, from);
    const sourceRecord = toRecord(source);
    const fields = Array.isArray(step.config.fields)
      ? step.config.fields.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (fields.length === 0) {
      return { output: sourceRecord, skipNext: false };
    }
    const output: Record<string, unknown> = {};
    for (const fieldPath of fields) {
      const key = fieldPath.includes(".") ? fieldPath.split(".").pop() ?? fieldPath : fieldPath;
      output[key] = getByPath(sourceRecord, fieldPath);
    }
    return { output, skipNext: false };
  }

  const fields = Array.isArray(step.config.fields)
    ? step.config.fields.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const template = typeof step.config.template === "string" ? step.config.template : "";
  const output: Record<string, unknown> = {};
  if (fields.length > 0) {
    for (const fieldPath of fields) {
      const key = fieldPath.includes(".") ? fieldPath.split(".").pop() ?? fieldPath : fieldPath;
      output[key] = resolvePath(state, fieldPath);
    }
  }
  if (template) {
    output.message = renderTemplate(template, state);
  }
  if (Object.keys(output).length === 0) {
    Object.assign(output, toRecord(state.lastOutput));
  }
  return { output, skipNext: false };
}

export async function runWorkflow(
  projectRoot: string,
  workflow: WorkflowDefinition,
  input: Record<string, unknown>,
  deps: WorkflowRunnerDeps = {},
): Promise<WorkflowRun> {
  const stateManager = new StateManager(projectRoot);
  const runId = randomUUID();
  const now = Date.now();
  const run: WorkflowRun = {
    id: runId,
    workflowId: workflow.id,
    status: "queued",
    input: toRecord(input),
    startedAt: now,
    steps: [],
  };
  await stateManager.writeWorkflowRun(run);

  run.status = "running";
  await stateManager.writeWorkflowRun(run);

  const execState: WorkflowExecutionState = {
    input: toRecord(input),
    steps: {},
    lastOutput: null,
  };
  let skipNextCount = 0;
  let finalOutput: Record<string, unknown> | undefined;

  for (const step of workflow.steps) {
    if (skipNextCount > 0) {
      const skipped: WorkflowRunStep = {
        stepId: step.id,
        type: step.type,
        status: "skipped",
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      run.steps.push(skipped);
      skipNextCount -= 1;
      await stateManager.writeWorkflowRun(run);
      continue;
    }

    const stepRun: WorkflowRunStep = {
      stepId: step.id,
      type: step.type,
      status: "running",
      input: parseStepInputSnapshot(step, execState),
      startedAt: Date.now(),
    };
    run.steps.push(stepRun);
    await stateManager.writeWorkflowRun(run);

    try {
      const result = await executeStep(projectRoot, step, execState, deps);
      stepRun.status = "completed";
      stepRun.output = result.output;
      stepRun.finishedAt = Date.now();
      execState.steps[step.id] = result.output;
      execState.lastOutput = result.output;
      if (step.type === "response") {
        finalOutput = result.output;
      }
      if (result.skipNext) {
        skipNextCount = 1;
      }
      await stateManager.writeWorkflowRun(run);
    } catch (err) {
      const message = (err as Error)?.message || "Unknown step error";
      stepRun.status = "failed";
      stepRun.error = message;
      stepRun.finishedAt = Date.now();
      run.status = "failed";
      run.error = `Step '${step.id}' failed: ${message}`;
      run.finishedAt = Date.now();
      await stateManager.writeWorkflowRun(run);
      return run;
    }
  }

  run.status = "completed";
  run.output = finalOutput ?? execState.lastOutput ?? {};
  run.finishedAt = Date.now();
  await stateManager.writeWorkflowRun(run);
  return run;
}

