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
import { appendTask, deleteTask, patchTask } from "./tasks.js";
import { implementSingleTask } from "../implement.js";
import { analyzeCommand } from "../analyze.js";
import type { SpinnerAdapter, UIAdapter } from "../adapter.js";
import { runAuditWorkflow } from "./audits.js";

const MAX_THREAD_TITLE_CHARS = 120;
const MAX_MESSAGE_TEXT_CHARS = 40_000;
const MAX_TOOL_LOG_CHARS = 7_000;
const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "google", "groq", "ollama", "openai-compatible"];

const CHAT_SYSTEM_PROMPT = [
  "You are Bender Operator, the fixed project assistant for this repository.",
  "You can execute built-in Bender actions via tools: list/add/update/delete tasks, run a task, run audits, and run project analysis.",
  "When the user asks to perform one of those actions, call the appropriate Bender tool instead of only describing what to do.",
  "Use external MCP tools only when needed for repository/external context, not for core Bender task/audit actions.",
  "After each tool call, summarize what changed and provide the resulting IDs/status clearly.",
  "If uncertain, state assumptions explicitly instead of hallucinating facts.",
].join("\n");

export class ChatServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

function compactText(value: string, maxChars = MAX_TOOL_LOG_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated]`;
}

function parseTaskId(value: number): number {
  const taskId = Number(value);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    throw new ChatServiceError(400, "taskId must be a positive integer");
  }
  return Math.floor(taskId);
}

function createCapturingAdapter(): { adapter: UIAdapter; readLog: () => string } {
  const lines: string[] = [];
  const push = (level: "info" | "success" | "warn" | "error", text: string) => {
    lines.push(`[${level}] ${text}`);
  };
  const spinner = (text: string): SpinnerAdapter => {
    let current = text;
    return {
      get text() { return current; },
      set text(v: string) { current = v; push("info", v); },
      start: () => push("info", current),
      stop: () => push("info", current),
      succeed: (value?: string) => push("success", value ?? current),
      fail: (value?: string) => push("error", value ?? current),
    };
  };

  return {
    adapter: {
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
      showFileOperations: (ops) => {
        if (ops.length === 0) return;
        push("info", `File operations: ${ops.map((op) => `${op.action}:${op.path}`).join(", ")}`);
      },
      cleanup: () => { /* no-op */ },
    },
    readLog: () => compactText(lines.join("\n")),
  };
}

async function readCurrentTasksSummary(projectRoot: string): Promise<Array<{
  id: number;
  title: string;
  dependencies: string;
  files: string[];
}>> {
  const state = new StateManager(projectRoot);
  const plan = await state.readCurrentTaskPlan();
  if (!plan) return [];
  return plan.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    dependencies: task.dependencies,
    files: task.files,
  }));
}

export function createBenderChatTools(
  projectRoot: string,
): ToolSet {
  return {
    bender_list_tasks: tool({
      description: "List current task-plan tasks with IDs, titles, dependencies, and file targets.",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await readCurrentTasksSummary(projectRoot);
        return {
          ok: true,
          count: tasks.length,
          tasks,
        };
      },
    }),

    bender_add_task: tool({
      description: "Append a new task into the current task plan.",
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        files: z.array(z.string().min(1)).optional(),
      }),
      execute: async ({ title, description, files }) => {
        const result = await appendTask(projectRoot, { title, description, files });
        const tasks = await readCurrentTasksSummary(projectRoot);
        const created = tasks.find((task) => task.id === result.taskId) ?? null;
        return {
          ok: true,
          taskId: result.taskId,
          created,
        };
      },
    }),

    bender_update_task: tool({
      description: "Update an existing task's title/description/dependencies/acceptance criteria.",
      inputSchema: z.object({
        taskId: z.number().int().positive(),
        title: z.string().optional(),
        description: z.string().optional(),
        dependencies: z.string().optional(),
        criteria: z.string().optional(),
      }),
      execute: async ({ taskId, title, description, dependencies, criteria }) => {
        await patchTask(projectRoot, String(parseTaskId(taskId)), {
          title,
          description,
          dependencies,
          criteria,
        });
        const tasks = await readCurrentTasksSummary(projectRoot);
        const updated = tasks.find((task) => task.id === taskId) ?? null;
        return {
          ok: true,
          taskId,
          updated,
        };
      },
    }),

    bender_delete_task: tool({
      description: "Delete a task by ID. Optionally cascade-delete dependent tasks.",
      inputSchema: z.object({
        taskId: z.number().int().positive(),
        cascadeDependents: z.boolean().optional(),
      }),
      execute: async ({ taskId, cascadeDependents }) => {
        const deletedTaskIds = await deleteTask(projectRoot, String(parseTaskId(taskId)), Boolean(cascadeDependents));
        return {
          ok: true,
          deletedTaskIds,
        };
      },
    }),

    bender_run_task: tool({
      description: "Execute a specific task implementation by task ID using Bender's implementer workflow.",
      inputSchema: z.object({
        taskId: z.number().int().positive(),
      }),
      execute: async ({ taskId }) => {
        const state = new StateManager(projectRoot);
        const beforeCompleted = await state.readCompletedTasks();
        const beforeSet = new Set(beforeCompleted.map((task) => task.name));

        const captured = createCapturingAdapter();
        await implementSingleTask(projectRoot, parseTaskId(taskId), captured.adapter);

        const afterCompleted = await state.readCompletedTasks();
        const newlyCompleted = afterCompleted
          .filter((task) => !beforeSet.has(task.name))
          .map((task) => task.name);
        return {
          ok: true,
          taskId,
          completed: newlyCompleted.length > 0,
          newlyCompleted,
          log: captured.readLog(),
        };
      },
    }),

    bender_run_audit: tool({
      description: "Run a Bender audit workflow. kind='security' checks vulnerabilities; kind='tests' (or 'ci') checks test harness and CI quality.",
      inputSchema: z.object({
        kind: z.enum(["security", "tests", "ci"]),
      }),
      execute: async ({ kind }) => {
        const auditType = kind === "ci" ? "tests" : kind;
        const captured = createCapturingAdapter();
        await runAuditWorkflow(projectRoot, auditType, captured.adapter);
        const state = new StateManager(projectRoot);
        const result = await state.readAudit(auditType);
        return {
          ok: true,
          kind,
          summary: result?.summary ?? null,
          coverageEstimate: result?.coverageEstimate ?? null,
          issueCount: result?.issues.length ?? 0,
          log: captured.readLog(),
        };
      },
    }),
    bender_run_analyze: tool({
      description: "Re-run project analyze to refresh brief and architecture from current code.",
      inputSchema: z.object({}),
      execute: async () => {
        const summary = await runAnalyzeWithCapture(projectRoot);
        return {
          ok: true,
          summary,
        };
      },
    }),
  };
}

type OperatorCommand =
  | { type: "task-list" }
  | { type: "task-add"; title: string; description?: string; files?: string[] }
  | { type: "task-update"; taskId: number; title?: string; description?: string; dependencies?: string; criteria?: string }
  | { type: "task-delete"; taskId: number; cascadeDependents: boolean }
  | { type: "task-run"; taskId: number }
  | { type: "audit-run"; kind: "security" | "tests" | "ci" }
  | { type: "analyze-run" };

async function runAnalyzeWithCapture(projectRoot: string): Promise<string> {
  const captured = createCapturingAdapter();
  try {
    await analyzeCommand(projectRoot, captured.adapter);
    const state = new StateManager(projectRoot);
    const context = await state.gatherContext();
    const briefPreview = context.brief?.trim()
      ? compactText(context.brief.trim(), 500)
      : "(no brief generated)";
    return [
      "Analyze completed.",
      `Brief: ${briefPreview}`,
      captured.readLog(),
    ].join("\n");
  } catch (err) {
    return `Analyze failed: ${parseErrorMessage(err)}\n${captured.readLog()}`;
  }
}

function extractUserMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
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
    const run = input.match(/^\/task\s+run\s+(\d+)$/i);
    if (run) return { type: "task-run", taskId: Number.parseInt(run[1], 10) };
  }

  {
    const del = input.match(/^\/task\s+delete\s+(\d+)(\s+cascade)?$/i);
    if (del) {
      return {
        type: "task-delete",
        taskId: Number.parseInt(del[1], 10),
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
      const files = fields.files
        ? fields.files.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined;
      return {
        type: "task-add",
        title,
        ...(fields.description ? { description: fields.description } : {}),
        ...(files && files.length > 0 ? { files } : {}),
      };
    }
  }

  {
    const update = input.match(/^\/task\s+update\s+(\d+)\s+(.+)$/i);
    if (update) {
      const taskId = Number.parseInt(update[1], 10);
      const fields = parseKeyValueFields(update[2]);
      if (
        fields.title === undefined
        && fields.description === undefined
        && fields.dependencies === undefined
        && fields.criteria === undefined
      ) {
        return null;
      }
      return {
        type: "task-update",
        taskId,
        ...(fields.title ? { title: fields.title } : {}),
        ...(fields.description ? { description: fields.description } : {}),
        ...(fields.dependencies ? { dependencies: fields.dependencies } : {}),
        ...(fields.criteria ? { criteria: fields.criteria } : {}),
      };
    }
  }

  return null;
}

async function executeOperatorCommand(projectRoot: string, command: OperatorCommand): Promise<string> {
  switch (command.type) {
    case "task-list": {
      const tasks = await readCurrentTasksSummary(projectRoot);
      if (tasks.length === 0) return "No tasks found in the current task plan.";
      const lines = tasks.slice(0, 30).map((task) => (
        `${task.id}. ${task.title} | deps: ${task.dependencies || "None"}`
      ));
      return `Current tasks (${tasks.length}):\n${lines.join("\n")}`;
    }

    case "task-add": {
      const result = await appendTask(projectRoot, {
        title: command.title,
        description: command.description,
        files: command.files,
      });
      return `Added task ${result.taskId}: ${command.title}`;
    }

    case "task-update": {
      await patchTask(projectRoot, String(parseTaskId(command.taskId)), {
        title: command.title,
        description: command.description,
        dependencies: command.dependencies,
        criteria: command.criteria,
      });
      return `Updated task ${command.taskId}.`;
    }

    case "task-delete": {
      const deletedTaskIds = await deleteTask(
        projectRoot,
        String(parseTaskId(command.taskId)),
        command.cascadeDependents,
      );
      return `Deleted task IDs: ${deletedTaskIds.join(", ")}`;
    }

    case "task-run": {
      const state = new StateManager(projectRoot);
      const beforeCompleted = await state.readCompletedTasks();
      const beforeSet = new Set(beforeCompleted.map((task) => task.name));
      const captured = createCapturingAdapter();
      await implementSingleTask(projectRoot, parseTaskId(command.taskId), captured.adapter);
      const afterCompleted = await state.readCompletedTasks();
      const newlyCompleted = afterCompleted
        .filter((task) => !beforeSet.has(task.name))
        .map((task) => task.name);
      return newlyCompleted.length > 0
        ? `Task ${command.taskId} executed and marked complete.\n${captured.readLog()}`
        : `Task ${command.taskId} executed, but no completion entry was recorded.\n${captured.readLog()}`;
    }

    case "audit-run": {
      const captured = createCapturingAdapter();
      const auditType = command.kind === "ci" ? "tests" : command.kind;
      await runAuditWorkflow(projectRoot, auditType, captured.adapter);
      const state = new StateManager(projectRoot);
      const result = await state.readAudit(auditType);
      return [
        `Ran ${command.kind} audit.`,
        result?.summary ? `Summary: ${result.summary}` : "Summary: (none)",
        result?.coverageEstimate ? `Coverage: ${result.coverageEstimate}` : null,
        `Issues: ${result?.issues.length ?? 0}`,
        captured.readLog(),
      ].filter(Boolean).join("\n");
    }

    case "analyze-run":
      return await runAnalyzeWithCapture(projectRoot);
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
    toolsEnabled: input.toolsEnabled !== false,
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
    ...(typeof input.toolsEnabled === "boolean" ? { toolsEnabled: input.toolsEnabled } : {}),
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
    thread.provider !== selection.provider || thread.model !== selection.model
  )
    ? {
        ...thread,
        provider: selection.provider,
        model: selection.model,
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
): Promise<void> {
  const threadId = normalizeThreadId(rawThreadId);
  const { store, thread } = await requireThread(projectRoot, threadId);
  const config = await readEffectiveConfig(projectRoot);
  const selection = resolveStrongProviderAndModel(config);
  const activeThread: ChatThread = (
    thread.provider !== selection.provider || thread.model !== selection.model
  )
    ? {
        ...thread,
        provider: selection.provider,
        model: selection.model,
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
    await appendChatMessage(projectRoot, threadId, { message: incomingUser });
  }

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
      responseText = await executeOperatorCommand(projectRoot, operatorCommand);
      logger.info("Deterministic operator command completed", {
        threadId,
        commandType: operatorCommand.type,
      });
    } catch (err) {
      logError(logger, "Deterministic operator command failed", err, {
        threadId,
        commandType: operatorCommand.type,
      });
      responseText = `Operator command failed: ${parseErrorMessage(err)}`;
    }
    streamAssistantTextResponse(
      res,
      uiMessages,
      responseText,
      async (responseMessage) => {
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
      },
    );
    return;
  }
  const state = new StateManager(projectRoot);
  const projectContext = await state.gatherContext();

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
  const benderTools = createBenderChatTools(projectRoot);
  if (!activeThread.toolsEnabled) {
    runtime.tools = undefined;
    runtime.providerOptions = undefined;
  }

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
  if (!activeThread.toolsEnabled) {
    availableTools = capabilities.supportsTools === false
      ? undefined
      : benderTools;
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
  try {
    result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      tools: availableTools,
      providerOptions: runtime.providerOptions,
      stopWhen: stepCountIs(5),
      maxOutputTokens: 2400,
    });
  } catch (err) {
    logError(logger, "Failed to create chat stream", err, {
      threadId,
      provider: activeThread.provider,
      model: activeThread.model,
    });
    await runtime.close();
    throw err;
  }

  const stream = result.toUIMessageStream<UIMessage>({
    originalMessages: uiMessages,
    onFinish: async ({ responseMessage }) => {
      try {
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
          responseParts: responseMessage.parts.length,
        });
      } catch (err) {
        logError(logger, "Failed to persist streamed chat response", err, {
          threadId,
          provider: activeThread.provider,
          model: activeThread.model,
        });
        throw err;
      } finally {
        await runtime.close();
      }
    },
  });

  pipeUIMessageStreamToResponse({
    response: res,
    stream,
  });
}
