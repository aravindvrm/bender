import { randomUUID } from "node:crypto";
import type { Response } from "express";
import {
  createUIMessageStream,
  convertToModelMessages,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { createModelForSelection, getProviderCapabilities } from "../../llm/provider.js";
import { createRoleRuntime, type RoleRuntime } from "../../llm/runtime.js";
import { createLogger, logError, toLoggerOptions } from "../../logger.js";
import { readEffectiveConfig, type BenderConfig } from "../../state/config.js";
import { ChatStore, type ChatThread, type LlmProvider } from "../../state/chat.js";
import { StateManager, formatContextForPrompt } from "../../state/manager.js";
import { normalizeTaskId } from "../../state/task-plan.js";
import { appendTask, deleteTask, patchTask } from "./tasks.js";
import { getAllAgents } from "../../state/agents.js";
import type { SpinnerAdapter, UIAdapter } from "../adapter.js";
import { runAnalyzeOperation, runAuditOperation, runImplementOperation } from "./run-operations.js";

const MAX_THREAD_TITLE_CHARS = 120;
const MAX_MESSAGE_TEXT_CHARS = 40_000;
const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "google", "groq", "ollama", "openai-compatible"];

const CHAT_SYSTEM_PROMPT = [
  "You are Bender Operator, the fixed project assistant for this repository.",
  "You can execute built-in Bender actions via tools: list/add/update/delete tasks, run a task, run audits, and run project analysis.",
  "When the user asks to perform one of those actions, call the appropriate Bender tool instead of only describing what to do.",
  "AGENT IDs: When specifying an implementerAgentId, you MUST use an exact agent ID from the list shown in the tool description. Never invent, guess, or paraphrase agent names. If unsure which agent fits, omit implementerAgentId entirely rather than fabricating one.",
  "Use external MCP tools only when needed for repository/external context, not for core Bender task/audit actions.",
  "After each tool call, summarize what changed and provide the resulting IDs/status clearly.",
  "If uncertain, state assumptions explicitly instead of hallucinating facts.",
].join("\n");

const inFlightChatResponses = new Set<string>();

export class ChatServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class ChatOperationAbortedError extends Error {
  constructor(message = "Chat action was interrupted.") {
    super(message);
    this.name = "ChatOperationAbortedError";
  }
}

interface ChatMessageMetadata {
  provider: string;
  model: string;
  toolsEnabled: boolean;
  createdAt: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof ChatOperationAbortedError) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    return /aborted|cancelled|canceled|interrupted|connection closed/i.test(error.message);
  }
  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ChatOperationAbortedError();
  }
}

function isUiMessage(value: unknown): value is UIMessage {
  if (!isObjectRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant") return false;
  return Array.isArray(value.parts);
}

function normalizeThreadId(raw: string | undefined): string {
  const threadId = decodeURIComponent(raw ?? "").trim();
  if (!threadId) throw new ChatServiceError(400, "threadId is required");
  return threadId;
}

function normalizeProvider(raw: unknown): LlmProvider {
  const provider = typeof raw === "string" ? raw.trim() : "";
  if (!provider || !PROVIDERS.includes(provider as LlmProvider)) {
    throw new ChatServiceError(400, "provider must be one of anthropic/openai/google/groq/ollama/openai-compatible");
  }
  return provider as LlmProvider;
}

function normalizeTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) return "New Chat";
  if (title.length > MAX_THREAD_TITLE_CHARS) {
    throw new ChatServiceError(400, `title cannot exceed ${MAX_THREAD_TITLE_CHARS} characters`);
  }
  return title;
}

function normalizeUserText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new ChatServiceError(400, "text is required");
  if (text.length > MAX_MESSAGE_TEXT_CHARS) {
    throw new ChatServiceError(400, `text cannot exceed ${MAX_MESSAGE_TEXT_CHARS} characters`);
  }
  return text;
}

function resolveStrongProviderAndModel(config: BenderConfig): { provider: LlmProvider; model: string } {
  const tier = config.llm.models.strong;
  if (typeof tier === "string") {
    const provider = normalizeProvider(config.llm.provider);
    const model = tier.trim() || config.providers?.[provider]?.model?.trim() || "";
    if (!model) throw new ChatServiceError(400, "Strong model is not configured");
    return { provider, model };
  }
  const provider = normalizeProvider(tier.provider || config.llm.provider);
  const model = tier.model?.trim() || config.providers?.[provider]?.model?.trim() || "";
  if (!model) throw new ChatServiceError(400, "Strong model is not configured");
  return { provider, model };
}

function attachMetadata(
  message: UIMessage,
  meta: ChatMessageMetadata,
): UIMessage {
  const existing = isObjectRecord(message.metadata) ? message.metadata : {};
  return {
    ...message,
    metadata: {
      ...existing,
      provider: meta.provider,
      model: meta.model,
      toolsEnabled: meta.toolsEnabled,
      createdAt: meta.createdAt,
    },
  };
}

function makeUserUiMessage(text: string): UIMessage {
  return {
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function parseTaskId(value: unknown): string {
  const normalized = normalizeTaskId(value);
  if (!normalized) {
    throw new ChatServiceError(400, "taskId must be in format task-N or numeric legacy format");
  }
  return normalized;
}

function createCapturingAdapter(signal?: AbortSignal): UIAdapter {
  const lines: string[] = [];
  const ensureActive = () => throwIfAborted(signal);
  const push = (level: "info" | "success" | "warn" | "error", text: string) => {
    ensureActive();
    lines.push(`[${level}] ${text}`);
  };
  const spinner = (text: string): SpinnerAdapter => {
    let current = text;
    return {
      get text() { return current; },
      set text(v: string) { ensureActive(); current = v; push("info", v); },
      start: () => { ensureActive(); push("info", current); },
      stop: () => { ensureActive(); push("info", current); },
      succeed: (value?: string) => { ensureActive(); push("success", value ?? current); },
      fail: (value?: string) => { ensureActive(); push("error", value ?? current); },
    };
  };

  return {
    header: (text) => { ensureActive(); push("info", text); },
    subheader: (text) => { ensureActive(); push("info", text); },
    info: (text) => { ensureActive(); push("info", text); },
    success: (text) => { ensureActive(); push("success", text); },
    warn: (text) => { ensureActive(); push("warn", text); },
    error: (text) => { ensureActive(); push("error", text); },
    streamWriter: () => (chunk: string) => {
      ensureActive();
      if (chunk.trim()) push("info", chunk.trim());
    },
    spinner,
    confirm: async () => {
      ensureActive();
      return true;
    },
    promptMultiline: async () => {
      ensureActive();
      return "";
    },
    showFileOperations: (ops) => {
      ensureActive();
      if (ops.length === 0) return;
      push("info", `File operations: ${ops.map((op) => `${op.action}:${op.path}`).join(", ")}`);
    },
    cleanup: () => { /* no-op */ },
  };
}

async function readCurrentTasksSummary(projectRoot: string): Promise<Array<{
  id: string;
  title: string;
  status: "todo" | "in_progress" | "done";
  implementerAgentId: string;
}>> {
  const state = new StateManager(projectRoot);
  const plan = await state.readCurrentTaskPlan();
  if (!plan) return [];
  return plan.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    implementerAgentId: task.implementerAgentId,
  }));
}

export async function createBenderChatTools(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<ToolSet> {
  // Fetch the real agent list once so descriptions and validation use live data.
  const agents = await getAllAgents().catch(() => []);
  const agentLines = agents.map((a) => `  • ${a.id}  (${a.name}, role: ${a.baseRole})`).join("\n");
  const agentHint = agents.length > 0
    ? `Available agents — use the exact id value:\n${agentLines}\nOmit implementerAgentId to use the project default.`
    : "No agents configured — omit implementerAgentId.";

  function validateAgentId(id: string | undefined): { ok: false; error: string } | null {
    const trimmed = id?.trim();
    if (!trimmed) return null; // omitted → always valid
    const known = agents.find((a) => a.id === trimmed);
    if (known) return null;
    const validIds = agents.map((a) => a.id).join(", ");
    return {
      ok: false,
      error: `Unknown implementerAgentId "${trimmed}". Valid ids are: ${validIds || "none"}. Omit the field to use the project default.`,
    };
  }

  return {
    bender_list_tasks: tool({
      description: "List current task-plan tasks with IDs, titles, status, and implementer agent assignment.",
      inputSchema: z.object({}),
      execute: async () => {
        throwIfAborted(signal);
        const tasks = await readCurrentTasksSummary(projectRoot);
        throwIfAborted(signal);
        return {
          ok: true,
          count: tasks.length,
          tasks,
        };
      },
    }),

    bender_add_task: tool({
      description: `Append a new task into the current task plan.\n${agentHint}`,
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string().min(1)).optional(),
        implementerAgentId: z.string().optional(),
      }),
      execute: async ({ title, description, acceptanceCriteria, implementerAgentId }, context?: { abortSignal?: AbortSignal }) => {
        throwIfAborted(context?.abortSignal ?? signal);
        const agentErr = validateAgentId(implementerAgentId);
        if (agentErr) return agentErr;
        const result = await appendTask(projectRoot, { title, description, acceptanceCriteria, implementerAgentId: implementerAgentId?.trim() || undefined });
        const tasks = await readCurrentTasksSummary(projectRoot);
        throwIfAborted(context?.abortSignal ?? signal);
        const created = tasks.find((task) => task.id === result.taskId) ?? null;
        return {
          ok: true,
          taskId: result.taskId,
          created,
        };
      },
    }),

    bender_update_task: tool({
      description: `Update an existing task's title/description/status/acceptance criteria/implementer assignment.\n${agentHint}`,
      inputSchema: z.object({
        taskId: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string().min(1)).optional(),
        criteria: z.string().optional(),
        status: z.enum(["todo", "in_progress", "done"]).optional(),
        implementerAgentId: z.string().optional(),
      }),
      execute: async ({ taskId, title, description, acceptanceCriteria, criteria, status, implementerAgentId }, context?: { abortSignal?: AbortSignal }) => {
        throwIfAborted(context?.abortSignal ?? signal);
        const agentErr = validateAgentId(implementerAgentId);
        if (agentErr) return agentErr;
        const normalizedTaskId = parseTaskId(taskId);
        await patchTask(projectRoot, normalizedTaskId, {
          title,
          description,
          acceptanceCriteria,
          criteria,
          status,
          implementerAgentId: implementerAgentId?.trim() || undefined,
        });
        const tasks = await readCurrentTasksSummary(projectRoot);
        throwIfAborted(context?.abortSignal ?? signal);
        const updated = tasks.find((task) => task.id === normalizedTaskId) ?? null;
        return {
          ok: true,
          taskId: normalizedTaskId,
          updated,
        };
      },
    }),

    bender_delete_task: tool({
      description: "Delete a task by ID. Optionally cascade-delete dependent tasks.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        cascadeDependents: z.boolean().optional(),
      }),
      execute: async ({ taskId, cascadeDependents }, context?: { abortSignal?: AbortSignal }) => {
        throwIfAborted(context?.abortSignal ?? signal);
        const deletedTaskIds = await deleteTask(projectRoot, parseTaskId(taskId), Boolean(cascadeDependents));
        return {
          ok: true,
          deletedTaskIds,
        };
      },
    }),

    bender_run_task: tool({
      description: "Execute a specific task implementation by task ID using Bender's implementer workflow.",
      inputSchema: z.object({
        taskId: z.string().min(1),
      }),
      execute: async ({ taskId }, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const taskResult = await runTaskForChat(projectRoot, parseTaskId(taskId), effectiveSignal);
        throwIfAborted(effectiveSignal);
        return {
          ok: true,
          ...taskResult,
        };
      },
    }),

    bender_run_audit: tool({
      description: "Run a Bender audit workflow. kind='security' checks vulnerabilities; kind='tests' (or 'ci') checks test harness and CI quality.",
      inputSchema: z.object({
        kind: z.enum(["security", "tests", "ci"]),
      }),
      execute: async ({ kind }, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const auditResult = await runAuditForChat(projectRoot, kind, effectiveSignal);
        throwIfAborted(effectiveSignal);
        return {
          ok: true,
          ...auditResult,
        };
      },
    }),
    bender_run_analyze: tool({
      description: "Re-run project analyze to refresh brief and architecture from current code.",
      inputSchema: z.object({}),
      execute: async (_args, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const summary = await runAnalyzeForChat(projectRoot, effectiveSignal);
        throwIfAborted(effectiveSignal);
        return {
          ok: true,
          ...summary,
        };
      },
    }),
  };
}

type OperatorCommand =
  | { type: "task-list" }
  | { type: "task-add"; title: string; description?: string; acceptanceCriteria?: string[]; implementerAgentId?: string }
  | { type: "task-update"; taskId: string; title?: string; description?: string; acceptanceCriteria?: string[]; criteria?: string; status?: "todo" | "in_progress" | "done"; implementerAgentId?: string }
  | { type: "task-delete"; taskId: string; cascadeDependents: boolean }
  | { type: "task-run"; taskId: string }
  | { type: "audit-run"; kind: "security" | "tests" | "ci" }
  | { type: "analyze-run" };

function formatCommandResponse(
  command: string,
  details: Array<string | null | undefined>,
): string {
  return [
    `Command '${command}' completed via normal pipeline.`,
    ...details.filter((line): line is string => typeof line === "string" && line.trim().length > 0),
  ].join("\n");
}

async function runAnalyzeForChat(projectRoot: string, signal?: AbortSignal): Promise<{
  message: string;
  hasBrief: boolean;
  hasArchitecture: boolean;
}> {
  throwIfAborted(signal);
  const captured = createCapturingAdapter(signal);
  await runAnalyzeOperation(projectRoot, captured);
  throwIfAborted(signal);
  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();
  throwIfAborted(signal);
  const hasBrief = Boolean(context.brief?.trim());
  const hasArchitecture = Boolean(context.architecture?.trim());
  return {
    message: "Analyze completed via normal pipeline.",
    hasBrief,
    hasArchitecture,
  };
}

async function runTaskForChat(projectRoot: string, taskId: string, signal?: AbortSignal): Promise<{
  taskId: string;
  completed: boolean;
  newlyCompleted: string[];
  message: string;
}> {
  throwIfAborted(signal);
  const state = new StateManager(projectRoot);
  const beforeCompleted = await state.readCompletedTasks();
  const beforeSet = new Set(beforeCompleted.map((task) => task.name));
  throwIfAborted(signal);
  const captured = createCapturingAdapter(signal);
  await runImplementOperation(projectRoot, { taskId }, captured);
  throwIfAborted(signal);
  const afterCompleted = await state.readCompletedTasks();
  const newlyCompleted = afterCompleted
    .filter((task) => !beforeSet.has(task.name))
    .map((task) => task.name);
  return {
    taskId,
    completed: newlyCompleted.length > 0,
    newlyCompleted,
    message: "Task execution completed via normal pipeline.",
  };
}

async function runAuditForChat(
  projectRoot: string,
  kind: "security" | "tests" | "ci",
  signal?: AbortSignal,
): Promise<{
  kind: "security" | "tests" | "ci";
  summary: string | null;
  coverageEstimate: string | null;
  issueCount: number;
  message: string;
}> {
  throwIfAborted(signal);
  const auditType = kind === "ci" ? "tests" : kind;
  const captured = createCapturingAdapter(signal);
  await runAuditOperation(projectRoot, auditType, captured);
  throwIfAborted(signal);
  const state = new StateManager(projectRoot);
  const result = await state.readAudit(auditType);
  throwIfAborted(signal);
  return {
    kind,
    summary: result?.summary ?? null,
    coverageEstimate: result?.coverageEstimate ?? null,
    issueCount: result?.issues.length ?? 0,
    message: `${kind} audit completed via normal pipeline.`,
  };
}

function extractUserMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function summarizeResponseMessage(message: UIMessage): {
  partCount: number;
  textChars: number;
  reasoningChars: number;
  toolParts: number;
  otherParts: number;
} {
  let textChars = 0;
  let reasoningChars = 0;
  let toolParts = 0;
  let otherParts = 0;
  for (const part of message.parts) {
    if (part.type === "text") {
      textChars += part.text.length;
      continue;
    }
    if (part.type === "reasoning") {
      reasoningChars += part.text.length;
      continue;
    }
    if (part.type.startsWith("tool-")) {
      toolParts += 1;
      continue;
    }
    otherParts += 1;
  }
  return {
    partCount: message.parts.length,
    textChars,
    reasoningChars,
    toolParts,
    otherParts,
  };
}

function parseKeyValueFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.includes(":") ? trimmed.indexOf(":") : trimmed.indexOf("=");
    if (sepIdx <= 0) continue;
    const key = trimmed.slice(0, sepIdx).trim().toLowerCase();
    const value = trimmed.slice(sepIdx + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function parseOperatorCommandFromText(text: string): OperatorCommand | null {
  const input = text.trim();
  const lowered = input.toLowerCase();
  if (!input.startsWith("/")) {
    if (
      /\b(re-?run|run)\b.*\banaly[sz]e\b/.test(lowered)
      || (/\banaly[sz]e\b/.test(lowered) && /\b(repo|repository|project)\b/.test(lowered))
    ) {
      return { type: "analyze-run" };
    }
    return null;
  }

  if (/^\/task\s+list$/i.test(input)) {
    return { type: "task-list" };
  }

  {
    const run = input.match(/^\/task\s+run\s+([a-z0-9_-]+)$/i);
    if (run) return { type: "task-run", taskId: parseTaskId(run[1]) };
  }

  {
    const del = input.match(/^\/task\s+delete\s+([a-z0-9_-]+)(\s+cascade)?$/i);
    if (del) {
      return {
        type: "task-delete",
        taskId: parseTaskId(del[1]),
        cascadeDependents: Boolean(del[2]),
      };
    }
  }

  {
    const audit = input.match(/^\/audit\s+(security|tests|ci)$/i);
    if (audit) return { type: "audit-run", kind: audit[1].toLowerCase() as "security" | "tests" | "ci" };
  }
  if (/^\/analy[sz]e(?:\s+rerun)?$/i.test(input)) {
    return { type: "analyze-run" };
  }

  {
    const add = input.match(/^\/task\s+add\s+(.+)$/i);
    if (add) {
      const body = add[1].trim();
      const fields = parseKeyValueFields(body);
      const title = fields.title ?? body.split(";")[0]?.trim();
      if (!title) return null;
      const acceptanceCriteria = fields.criteria
        ? fields.criteria.split("|").map((value) => value.trim()).filter(Boolean)
        : undefined;
      return {
        type: "task-add",
        title,
        ...(fields.description ? { description: fields.description } : {}),
        ...(acceptanceCriteria && acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
        ...(fields.agent ? { implementerAgentId: fields.agent } : {}),
      };
    }
  }

  {
    const update = input.match(/^\/task\s+update\s+([a-z0-9_-]+)\\s+(.+)$/i);
    if (update) {
      const taskId = parseTaskId(update[1]);
      const fields = parseKeyValueFields(update[2]);
      if (
        fields.title === undefined
        && fields.description === undefined
        && fields.criteria === undefined
        && fields.status === undefined
        && fields.agent === undefined
      ) {
        return null;
      }
      return {
        type: "task-update",
        taskId,
        ...(fields.title ? { title: fields.title } : {}),
        ...(fields.description ? { description: fields.description } : {}),
        ...(fields.criteria ? { criteria: fields.criteria } : {}),
        ...(fields.status ? { status: fields.status as "todo" | "in_progress" | "done" } : {}),
        ...(fields.agent ? { implementerAgentId: fields.agent } : {}),
      };
    }
  }

  return null;
}

async function executeOperatorCommand(projectRoot: string, command: OperatorCommand, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  switch (command.type) {
    case "task-list": {
      const tasks = await readCurrentTasksSummary(projectRoot);
      throwIfAborted(signal);
      if (tasks.length === 0) {
        return formatCommandResponse("/task list", ["No tasks found in the current task plan."]);
      }
      const lines = tasks.slice(0, 30).map((task) => (
        `${task.id} | ${task.status} | ${task.title} | agent: ${task.implementerAgentId}`
      ));
      return formatCommandResponse("/task list", [
        `Current tasks (${tasks.length}):`,
        lines.join("\n"),
      ]);
    }

    case "task-add": {
      throwIfAborted(signal);
      const result = await appendTask(projectRoot, {
        title: command.title,
        description: command.description,
        acceptanceCriteria: command.acceptanceCriteria,
        implementerAgentId: command.implementerAgentId,
      });
      throwIfAborted(signal);
      return formatCommandResponse("/task add", [`Added task ${result.taskId}: ${command.title}`]);
    }

    case "task-update": {
      throwIfAborted(signal);
      await patchTask(projectRoot, parseTaskId(command.taskId), {
        title: command.title,
        description: command.description,
        acceptanceCriteria: command.acceptanceCriteria,
        criteria: command.criteria,
        status: command.status,
        implementerAgentId: command.implementerAgentId,
      });
      throwIfAborted(signal);
      return formatCommandResponse("/task update", [`Updated task ${command.taskId}.`]);
    }

    case "task-delete": {
      throwIfAborted(signal);
      const deletedTaskIds = await deleteTask(
        projectRoot,
        parseTaskId(command.taskId),
        command.cascadeDependents,
      );
      throwIfAborted(signal);
      return formatCommandResponse("/task delete", [`Deleted task IDs: ${deletedTaskIds.join(", ")}`]);
    }

    case "task-run": {
      const result = await runTaskForChat(projectRoot, parseTaskId(command.taskId), signal);
      throwIfAborted(signal);
      if (result.completed) {
        return formatCommandResponse("/task run", [
          `Task ${command.taskId} executed and marked complete.`,
        ]);
      }
      return formatCommandResponse("/task run", [
        `Task ${command.taskId} executed. No completion entry was recorded.`,
      ]);
    }

    case "audit-run": {
      const result = await runAuditForChat(projectRoot, command.kind, signal);
      throwIfAborted(signal);
      return formatCommandResponse(`/audit ${command.kind}`, [
        `Ran ${command.kind} audit.`,
        result?.summary ? `Summary: ${result.summary}` : "Summary: (none)",
        result?.coverageEstimate ? `Coverage: ${result.coverageEstimate}` : null,
        `Issues: ${result.issueCount}`,
      ]);
    }

    case "analyze-run": {
      const result = await runAnalyzeForChat(projectRoot, signal);
      throwIfAborted(signal);
      return formatCommandResponse("/analyze", [
        "Analyze completed.",
        `Brief available: ${result.hasBrief ? "yes" : "no"}`,
        `Architecture available: ${result.hasArchitecture ? "yes" : "no"}`,
      ]);
    }
  }
}

function createAssistantTextMessage(text: string): UIMessage {
  return {
    id: randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

function streamAssistantTextResponse(
  res: Response,
  originalMessages: UIMessage[],
  text: string,
  onFinish: (responseMessage: UIMessage) => Promise<void>,
): void {
  const assistant = createAssistantTextMessage(text);
  const stream = createUIMessageStream<UIMessage>({
    originalMessages,
    execute: ({ writer }) => {
      writer.write({ type: "start", messageId: assistant.id });
      writer.write({ type: "start-step" });
      writer.write({ type: "text-start", id: "text-1" });
      writer.write({ type: "text-delta", id: "text-1", delta: text });
      writer.write({ type: "text-end", id: "text-1" });
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });
    },
    onFinish: async ({ responseMessage }) => {
      await onFinish({
        ...assistant,
        ...(responseMessage ? { parts: responseMessage.parts } : {}),
      });
    },
  });

  pipeUIMessageStreamToResponse({
    response: res,
    stream,
  });
}

async function requireThread(projectRoot: string, threadId: string): Promise<{ store: ChatStore; thread: ChatThread }> {
  const store = new ChatStore(projectRoot);
  await store.init();
  const thread = await store.getThread(threadId);
  if (!thread) throw new ChatServiceError(404, "Thread not found");
  return { store, thread };
}

export async function listChatThreads(projectRoot: string): Promise<ChatThread[]> {
  const store = new ChatStore(projectRoot);
  await store.init();
  return await store.listThreads();
}

export async function createChatThread(
  projectRoot: string,
  input: {
    title?: string;
    toolsEnabled?: boolean;
  },
): Promise<ChatThread> {
  const store = new ChatStore(projectRoot);
  await store.init();
  const config = await readEffectiveConfig(projectRoot);
  const fallback = resolveStrongProviderAndModel(config);
  return await store.createThread({
    title: normalizeTitle(input.title),
    provider: fallback.provider,
    model: fallback.model,
    toolsEnabled: true,
  });
}

export async function updateChatThread(
  projectRoot: string,
  rawThreadId: string | undefined,
  input: {
    title?: string;
    toolsEnabled?: boolean;
    archived?: boolean;
  },
): Promise<ChatThread> {
  const threadId = normalizeThreadId(rawThreadId);
  const { store, thread } = await requireThread(projectRoot, threadId);

  const nextTitle = input.title !== undefined ? normalizeTitle(input.title) : thread.title;

  const next: ChatThread = {
    ...thread,
    title: nextTitle,
    toolsEnabled: true,
    ...(typeof input.archived === "boolean" ? { archived: input.archived } : {}),
    updatedAt: Date.now(),
  };
  await store.upsertThread(next);
  return next;
}

export async function listChatMessages(
  projectRoot: string,
  rawThreadId: string | undefined,
): Promise<UIMessage[]> {
  const threadId = normalizeThreadId(rawThreadId);
  const { store } = await requireThread(projectRoot, threadId);
  const rows = await store.listMessages(threadId);
  return rows.map((row) => row.message);
}

export async function appendChatMessage(
  projectRoot: string,
  rawThreadId: string | undefined,
  input: { text?: string; message?: UIMessage },
): Promise<UIMessage> {
  const threadId = normalizeThreadId(rawThreadId);
  const { store, thread } = await requireThread(projectRoot, threadId);
  const config = await readEffectiveConfig(projectRoot);
  const selection = resolveStrongProviderAndModel(config);
  const activeThread: ChatThread = (
    thread.provider !== selection.provider || thread.model !== selection.model || thread.toolsEnabled !== true
  )
    ? {
        ...thread,
        provider: selection.provider,
        model: selection.model,
        toolsEnabled: true,
        updatedAt: Date.now(),
      }
    : thread;
  if (activeThread !== thread) {
    await store.upsertThread(activeThread);
  }

  const baseMessage = input.message && isUiMessage(input.message)
    ? input.message
    : makeUserUiMessage(normalizeUserText(input.text));
  const createdAt = Date.now();
  const withMeta = attachMetadata(baseMessage, {
    provider: activeThread.provider,
    model: activeThread.model,
    toolsEnabled: activeThread.toolsEnabled,
    createdAt,
  });
  await store.appendMessage({
    threadId,
    provider: activeThread.provider,
    model: activeThread.model,
    toolsEnabled: activeThread.toolsEnabled,
    message: withMeta,
    createdAt,
  });
  await store.touchThread(threadId);
  return withMeta;
}

export async function streamChatThreadResponse(
  projectRoot: string,
  rawThreadId: string | undefined,
  body: unknown,
  res: Response,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const signal = options?.signal;
  throwIfAborted(signal);
  const threadId = normalizeThreadId(rawThreadId);
  const inFlightKey = `${projectRoot}::${threadId}`;
  if (inFlightChatResponses.has(inFlightKey)) {
    throw new ChatServiceError(409, "A chat action is already running for this thread. Stop it before sending another request.");
  }
  inFlightChatResponses.add(inFlightKey);
  let releasedInFlight = false;
  const releaseInFlight = () => {
    if (releasedInFlight) return;
    releasedInFlight = true;
    inFlightChatResponses.delete(inFlightKey);
  };
  res.once("close", releaseInFlight);
  const { store, thread } = await requireThread(projectRoot, threadId);
  const config = await readEffectiveConfig(projectRoot);
  const selection = resolveStrongProviderAndModel(config);
  const activeThread: ChatThread = (
    thread.provider !== selection.provider || thread.model !== selection.model || thread.toolsEnabled !== true
  )
    ? {
        ...thread,
        provider: selection.provider,
        model: selection.model,
        toolsEnabled: true,
        updatedAt: Date.now(),
      }
    : thread;
  if (activeThread !== thread) {
    await store.upsertThread(activeThread);
  }
  const payload = isObjectRecord(body) ? body : {};
  const trigger = typeof payload.trigger === "string" ? payload.trigger : "submit-message";
  if (trigger === "regenerate-message") {
    throw new ChatServiceError(400, "regenerate-message is not implemented yet");
  }
  const logger = createLogger(
    "chat",
    projectRoot,
    null,
    toLoggerOptions(config.logging),
  );

  const requestedMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const requestedMessageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
  logger.info("Chat response requested", {
    threadId,
    trigger,
    provider: activeThread.provider,
    model: activeThread.model,
    toolsEnabled: activeThread.toolsEnabled,
    requestedMessageCount: requestedMessages.length,
  });

  let incomingUser: UIMessage | null = null;
  if (requestedMessageId) {
    incomingUser = requestedMessages.find((msg) => isUiMessage(msg) && msg.id === requestedMessageId && msg.role === "user") as UIMessage | null;
  }
  if (!incomingUser) {
    const last = requestedMessages[requestedMessages.length - 1];
    if (isUiMessage(last) && last.role === "user") incomingUser = last;
  }
  if (incomingUser && !(await store.hasMessage(threadId, incomingUser.id))) {
    throwIfAborted(signal);
    await appendChatMessage(projectRoot, threadId, { message: incomingUser });
  }

  throwIfAborted(signal);
  const history = await store.listMessages(threadId);
  const uiMessages = history.map((row) => row.message);
  if (uiMessages.length === 0) {
    throw new ChatServiceError(400, "No messages in thread. Submit a user message first.");
  }
  const last = uiMessages[uiMessages.length - 1];
  if (!last || last.role !== "user") {
    throw new ChatServiceError(400, "Last message must be a user message before requesting a response.");
  }
  const lastUserText = extractUserMessageText(last);
  const operatorCommand = parseOperatorCommandFromText(lastUserText);
  if (operatorCommand) {
    let responseText: string;
    logger.info("Executing deterministic operator command", {
      threadId,
      commandType: operatorCommand.type,
    });
    try {
      responseText = await executeOperatorCommand(projectRoot, operatorCommand, signal);
      throwIfAborted(signal);
      logger.info("Deterministic operator command completed", {
        threadId,
        commandType: operatorCommand.type,
      });
    } catch (err) {
      if (isAbortLikeError(err) || signal?.aborted) {
        logger.info("Deterministic operator command interrupted", {
          threadId,
          commandType: operatorCommand.type,
        });
        releaseInFlight();
        return;
      }
      logError(logger, "Deterministic operator command failed", err, {
        threadId,
        commandType: operatorCommand.type,
      });
      responseText = `Operator command failed: ${parseErrorMessage(err)}`;
    }
    if (signal?.aborted || res.destroyed || res.writableEnded) {
      logger.info("Skipping deterministic response stream after interruption", {
        threadId,
        commandType: operatorCommand.type,
      });
      releaseInFlight();
      return;
    }
    streamAssistantTextResponse(
      res,
      uiMessages,
      responseText,
      async (responseMessage) => {
        try {
          if (signal?.aborted || res.destroyed || res.writableEnded) return;
          const withMeta = attachMetadata(responseMessage, {
            provider: activeThread.provider,
            model: activeThread.model,
            toolsEnabled: activeThread.toolsEnabled,
            createdAt: Date.now(),
          });
          await store.appendMessage({
            threadId,
            provider: activeThread.provider,
            model: activeThread.model,
            toolsEnabled: activeThread.toolsEnabled,
            message: withMeta,
          });
          await store.touchThread(threadId);
        } finally {
          releaseInFlight();
        }
      },
    );
    return;
  }
  const state = new StateManager(projectRoot);
  const projectContext = await state.gatherContext();
  throwIfAborted(signal);

  let runtime: RoleRuntime;
  try {
    runtime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "planner",
        provider: activeThread.provider,
        model: activeThread.model,
        pinnedSkills: [],
        modelTier: "strong",
      },
      projectContext.architecture ?? undefined,
      logger,
    );
  } catch (err) {
    logError(logger, "Failed to initialize chat role runtime", err, {
      threadId,
      provider: activeThread.provider,
      model: activeThread.model,
    });
    throw err;
  }
  const benderTools = await createBenderChatTools(projectRoot, signal);
  const model = createModelForSelection(config, {
    provider: activeThread.provider,
    model: activeThread.model,
  });
  const capabilities = getProviderCapabilities(config, activeThread.provider, activeThread.model);
  let availableTools: ToolSet | undefined = {
    ...benderTools,
    ...(runtime.tools ?? {}),
  };
  if (capabilities.supportsTools === false) {
    availableTools = undefined;
  }
  logger.info("Starting chat model stream", {
    threadId,
    provider: activeThread.provider,
    model: activeThread.model,
    toolCount: availableTools ? Object.keys(availableTools).length : 0,
    mcpEnabled: runtime.summary.mcpEnabled,
    mcpTools: runtime.summary.mcpTools,
  });

  const systemPrompt = [
    CHAT_SYSTEM_PROMPT,
    formatContextForPrompt(projectContext),
    runtime.additionalSystemContext ?? null,
  ].filter(Boolean).join("\n\n---\n\n");

  const modelMessages = await convertToModelMessages(
    uiMessages.map(({ id, ...rest }) => rest),
  );

  let result;
  let runtimeClosed = false;
  const closeRuntime = async () => {
    if (runtimeClosed) return;
    runtimeClosed = true;
    await runtime.close();
  };
  const abortRuntime = () => {
    void closeRuntime();
  };
  signal?.addEventListener("abort", abortRuntime, { once: true });
  try {
    result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools: availableTools,
      providerOptions: runtime.providerOptions,
      stopWhen: stepCountIs(5),
      maxOutputTokens: 2400,
      abortSignal: signal,
    });
  } catch (err) {
    signal?.removeEventListener("abort", abortRuntime);
    if (isAbortLikeError(err) || signal?.aborted) {
      releaseInFlight();
      await closeRuntime();
      return;
    }
    logError(logger, "Failed to create chat stream", err, {
      threadId,
      provider: activeThread.provider,
      model: activeThread.model,
    });
    await closeRuntime();
    throw err;
  }

  const stream = result.toUIMessageStream<UIMessage>({
    originalMessages: uiMessages,
    onError: (err) => {
      if (isAbortLikeError(err) || signal?.aborted) {
        logger.info("Chat stream interrupted", {
          threadId,
          provider: activeThread.provider,
          model: activeThread.model,
        });
        return "";
      }
      logError(logger, "Chat stream emitted error", err, {
        threadId,
        provider: activeThread.provider,
        model: activeThread.model,
      });
      return `Chat failed: ${parseErrorMessage(err)}`;
    },
    onFinish: async ({ responseMessage }) => {
      try {
        if (signal?.aborted || res.destroyed || res.writableEnded) {
          logger.info("Chat stream finished after interruption; skipping persistence", {
            threadId,
            provider: activeThread.provider,
            model: activeThread.model,
          });
          return;
        }
        const stats = summarizeResponseMessage(responseMessage);
        if (stats.textChars === 0 && stats.reasoningChars === 0 && stats.toolParts === 0) {
          logger.warn("Chat stream finished without visible assistant output", {
            threadId,
            provider: activeThread.provider,
            model: activeThread.model,
            ...stats,
          });
        }
        const withMeta = attachMetadata(responseMessage, {
          provider: activeThread.provider,
          model: activeThread.model,
          toolsEnabled: activeThread.toolsEnabled,
          createdAt: Date.now(),
        });
        await store.appendMessage({
          threadId,
          provider: activeThread.provider,
          model: activeThread.model,
          toolsEnabled: activeThread.toolsEnabled,
          message: withMeta,
        });
        await store.touchThread(threadId);
        logger.info("Chat response stored", {
          threadId,
          provider: activeThread.provider,
          model: activeThread.model,
          ...stats,
        });
      } catch (err) {
        if (isAbortLikeError(err) || signal?.aborted) return;
        logError(logger, "Failed to persist streamed chat response", err, {
          threadId,
          provider: activeThread.provider,
          model: activeThread.model,
        });
        throw err;
      } finally {
        signal?.removeEventListener("abort", abortRuntime);
        releaseInFlight();
        await closeRuntime();
      }
    },
  });

  pipeUIMessageStreamToResponse({
    response: res,
    stream,
  });
}
