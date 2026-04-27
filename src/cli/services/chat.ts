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
import { createModelForSelection, createModelSet, getModelForRole, getProviderCapabilities } from "../../llm/provider.js";
import { createRoleRuntime, type RoleRuntime } from "../../llm/runtime.js";
import { createLogger, logError, toLoggerOptions } from "../../logger.js";
import { readEffectiveConfig, type BenderConfig } from "../../state/config.js";
import { ChatStore, type ChatThread, type LlmProvider } from "../../state/chat.js";
import { StateManager, formatContextForPrompt } from "../../state/manager.js";
import { normalizeTaskId } from "../../state/task-plan.js";
import { appendTask, deleteTask, patchTask } from "./tasks.js";
import { generateClarifyingQuestions, generateBrief } from "../../roles/clarifier.js";
import { generateArchitecture, updateArchitecture } from "../../roles/architect.js";
import { generateInitialPlan, generateFeaturePlan } from "../../roles/planner.js";
import { getAllAgents } from "../../state/agents.js";
import type { SpinnerAdapter, UIAdapter } from "../adapter.js";
import { runAnalyzeOperation, runAuditOperation, runImplementOperation } from "./run-operations.js";
import { RunHistoryStore, wrapAdapterWithHistory } from "./run-history.js";

const MAX_THREAD_TITLE_CHARS = 120;
const MAX_MESSAGE_TEXT_CHARS = 40_000;
const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "google", "groq", "ollama", "local", "openai-compatible"];

const CHAT_SYSTEM_PROMPT = [
  "You are Bender Operator, the fixed project assistant for this repository.",
  "",
  "## Core capabilities",
  "You have two categories of tools:",
  "",
  "**Task management:** list, add, update, delete tasks; run a specific task; run audits; re-analyze the project.",
  "",
  "**Planning pipeline (propose → approve → save):**",
  "These tools drive the full planning workflow conversationally. The flow is:",
  "  1. bender_clarify_project  — ask targeted questions about what the user wants to build",
  "  2. bender_generate_brief   — produce a structured product brief from the description + your Q&A answers",
  "  3. bender_save_brief       — persist the approved brief (only after user says it looks right)",
  "  4. bender_propose_architecture — generate architecture doc from the brief (or update for a new feature)",
  "  5. bender_save_architecture — persist the approved architecture",
  "  6. bender_propose_tasks    — break the work into ordered implementation tasks",
  "  7. bender_save_tasks       — persist the approved task plan",
  "",
  "## Rules for the planning pipeline",
  "- ALWAYS call bender_clarify_project before generating a brief for a new project or major feature.",
  "- Present each proposal (brief, architecture, tasks) to the user before saving. Ask: 'Does this look right? Any changes?'",
  "- Only call a _save_ tool after the user explicitly approves. Never save without approval.",
  "- If the user edits something, incorporate their edits into the content before saving.",
  "- For an EXISTING project feature: skip clarify/brief steps and go straight to bender_propose_architecture with the feature description.",
  "- For a NEW project: run the full pipeline in order.",
  "",
  "## Question formatting",
  "When asking the user questions (clarifying or approval), format them as clear prose — one question at a time or a short numbered list if multiple are needed. Be specific about what you need and why it matters.",
  "",
  "## General rules",
  "- When the user asks to perform an action, call the appropriate tool instead of only describing what to do.",
  "- AGENT IDs: when specifying an implementerAgentId, use an exact agent ID from the tool description. Never invent or guess agent names; omit the field rather than fabricate one.",
  "- After each tool call, summarize what happened and provide resulting IDs/status clearly.",
  "- If uncertain, state assumptions explicitly instead of hallucinating facts.",
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
    throw new ChatServiceError(400, "provider must be one of anthropic/openai/google/groq/ollama/local");
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

/**
 * Creates a capturing adapter that also records events to .bender/runs/ history.
 * Returns both the adapter and a finish callback so the caller can mark the run done/error.
 */
async function createHistoryCapturingAdapter(
  projectRoot: string,
  operationType: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ adapter: UIAdapter; finishRun: (status: "done" | "error") => Promise<void> }> {
  const base = createCapturingAdapter(signal);
  try {
    const store = new RunHistoryStore(projectRoot);
    await store.init();
    const handle = await store.startRun(operationType, label);
    const wrapped = wrapAdapterWithHistory(base, handle);
    return {
      adapter: wrapped,
      finishRun: (status) => handle.finish(status),
    };
  } catch {
    // History unavailable — fall back to plain capturing adapter silently.
    return {
      adapter: base,
      finishRun: async () => {/* no-op */},
    };
  }
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

    // -----------------------------------------------------------------------
    // Planning pipeline tools
    // -----------------------------------------------------------------------

    bender_clarify_project: tool({
      description: [
        "Ask targeted clarifying questions about what the user wants to build.",
        "Use this as the first step before generating a product brief for a new project or major feature.",
        "Returns a numbered list of clarifying questions. Present them to the user and wait for answers.",
        "Then call bender_generate_brief with the description and the Q&A exchange.",
      ].join(" "),
      inputSchema: z.object({
        description: z.string().min(1).describe("The user's raw description of what they want to build."),
      }),
      execute: async ({ description }, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const config = await readEffectiveConfig(projectRoot);
        const models = createModelSet(config);
        const model = getModelForRole(models, "clarifier");
        const state = new StateManager(projectRoot);
        const existingContext = state.isInitialized() ? await state.gatherContext() : null;
        throwIfAborted(effectiveSignal);
        const questions = await generateClarifyingQuestions(model, description, existingContext);
        throwIfAborted(effectiveSignal);
        return { ok: true, questions };
      },
    }),

    bender_generate_brief: tool({
      description: [
        "Generate a structured product brief from the user's description and the clarification Q&A.",
        "Call this after bender_clarify_project and after the user has answered the questions.",
        "Returns the brief as markdown text. Present it to the user for review.",
        "Only call bender_save_brief after the user explicitly approves.",
      ].join(" "),
      inputSchema: z.object({
        description: z.string().min(1).describe("The original description of what the user wants to build."),
        qa: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })).describe("The clarification conversation: assistant questions and user answers, in order."),
      }),
      execute: async ({ description, qa }, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const config = await readEffectiveConfig(projectRoot);
        const models = createModelSet(config);
        const model = getModelForRole(models, "clarifier");
        const state = new StateManager(projectRoot);
        const existingContext = state.isInitialized() ? await state.gatherContext() : null;
        throwIfAborted(effectiveSignal);
        const brief = await generateBrief(model, description, qa, existingContext);
        throwIfAborted(effectiveSignal);
        return { ok: true, brief };
      },
    }),

    bender_save_brief: tool({
      description: [
        "Persist the approved product brief to .bender/brief.md.",
        "Only call this after the user has explicitly approved the brief content.",
        "Pass the final brief text (including any user edits).",
      ].join(" "),
      inputSchema: z.object({
        content: z.string().min(1).describe("The approved brief markdown content to save."),
      }),
      execute: async ({ content }, context?: { abortSignal?: AbortSignal }) => {
        throwIfAborted(context?.abortSignal ?? signal);
        const state = new StateManager(projectRoot);
        if (!state.isInitialized()) await state.init();
        await state.writeBrief(content.trim());
        return { ok: true, message: "Brief saved to .bender/brief.md" };
      },
    }),

    bender_propose_architecture: tool({
      description: [
        "Generate an architecture document from the product brief.",
        "For a NEW project: reads the saved brief (or accepts briefContent directly) and calls the architect role.",
        "For an EXISTING project feature: pass featureDescription and the architect will produce targeted updates",
        "  (schema migrations, API changes, new conventions) relative to the existing architecture.",
        "Returns the proposed architecture as markdown. Present it to the user for review.",
        "Only call bender_save_architecture after the user explicitly approves.",
      ].join(" "),
      inputSchema: z.object({
        featureDescription: z.string().optional().describe("For existing projects: the feature or change being planned. Omit for new projects."),
        briefContent: z.string().optional().describe("For new projects: the brief text to use. If omitted, reads .bender/brief.md."),
      }),
      execute: async ({ featureDescription, briefContent }, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const config = await readEffectiveConfig(projectRoot);
        const models = createModelSet(config);
        const model = getModelForRole(models, "architect");
        const state = new StateManager(projectRoot);
        const existingContext = state.isInitialized() ? await state.gatherContext() : null;
        throwIfAborted(effectiveSignal);

        if (featureDescription && existingContext?.architecture) {
          // Existing project — produce targeted architecture update
          const result = await updateArchitecture(model, featureDescription, config, existingContext);
          throwIfAborted(effectiveSignal);
          return {
            ok: true,
            kind: "update" as const,
            architectureUpdate: result.architectureUpdate,
            schemaMigration: result.schemaMigration,
          };
        } else {
          // New project — generate full architecture from brief
          const brief = briefContent?.trim() || existingContext?.brief || null;
          if (!brief) {
            return { ok: false, error: "No brief available. Call bender_generate_brief first or pass briefContent." };
          }
          const architecture = await generateArchitecture(model, brief, config, existingContext);
          throwIfAborted(effectiveSignal);
          return {
            ok: true,
            kind: "full" as const,
            architecture,
            schemaMigration: null,
          };
        }
      },
    }),

    bender_save_architecture: tool({
      description: [
        "Persist the approved architecture to .bender/architecture.md.",
        "For architecture updates (existing project), also writes any schema migration to .bender/schema.sql.",
        "Only call this after the user has explicitly approved the architecture content.",
      ].join(" "),
      inputSchema: z.object({
        content: z.string().min(1).describe("The approved architecture markdown content to save."),
        schemaMigration: z.string().optional().describe("SQL migration to append to .bender/schema.sql, if any."),
      }),
      execute: async ({ content, schemaMigration }, context?: { abortSignal?: AbortSignal }) => {
        throwIfAborted(context?.abortSignal ?? signal);
        const state = new StateManager(projectRoot);
        if (!state.isInitialized()) await state.init();
        await state.writeArchitecture(content.trim());
        if (schemaMigration?.trim()) {
          const existing = await state.readSchema();
          const separator = existing?.trim() ? "\n\n-- Migration\n" : "";
          await state.writeSchema(`${existing ?? ""}${separator}${schemaMigration.trim()}\n`);
        }
        return {
          ok: true,
          message: schemaMigration?.trim()
            ? "Architecture and schema migration saved."
            : "Architecture saved to .bender/architecture.md",
        };
      },
    }),

    bender_propose_tasks: tool({
      description: [
        "Generate an ordered implementation task plan.",
        "For an EXISTING project feature: pass featureDescription and architectureUpdate (from bender_propose_architecture).",
        "For a NEW project: pass briefContent and architectureContent (full architecture text).",
        "Returns the task plan as markdown. Present it to the user for review.",
        "Only call bender_save_tasks after the user explicitly approves.",
      ].join(" "),
      inputSchema: z.object({
        featureDescription: z.string().optional().describe("For existing projects: the feature being planned."),
        architectureUpdate: z.string().optional().describe("For existing projects: the architecture update text from bender_propose_architecture."),
        briefContent: z.string().optional().describe("For new projects: the brief text. If omitted, reads .bender/brief.md."),
        architectureContent: z.string().optional().describe("For new projects: the full architecture text. If omitted, reads .bender/architecture.md."),
      }),
      execute: async ({ featureDescription, architectureUpdate, briefContent, architectureContent }, context?: { abortSignal?: AbortSignal }) => {
        const effectiveSignal = context?.abortSignal ?? signal;
        throwIfAborted(effectiveSignal);
        const config = await readEffectiveConfig(projectRoot);
        const models = createModelSet(config);
        const model = getModelForRole(models, "planner");
        const state = new StateManager(projectRoot);
        const existingContext = state.isInitialized() ? await state.gatherContext() : null;
        throwIfAborted(effectiveSignal);

        let tasks: string;
        if (featureDescription && architectureUpdate && existingContext) {
          // Existing project feature plan
          tasks = await generateFeaturePlan(model, featureDescription, architectureUpdate, existingContext);
        } else {
          // New project initial plan
          const brief = briefContent?.trim() || existingContext?.brief || null;
          const architecture = architectureContent?.trim() || existingContext?.architecture || null;
          if (!brief || !architecture) {
            return {
              ok: false,
              error: "Both brief and architecture are required for a new project plan. Save them first or pass content directly.",
            };
          }
          tasks = await generateInitialPlan(model, brief, architecture);
        }
        throwIfAborted(effectiveSignal);
        return { ok: true, tasks };
      },
    }),

    bender_save_tasks: tool({
      description: [
        "Persist the approved task plan to .bender/tasks/current.md, replacing the current task list.",
        "Only call this after the user has explicitly approved the task plan.",
        "Pass the final task markdown (including any user edits).",
      ].join(" "),
      inputSchema: z.object({
        content: z.string().min(1).describe("The approved task plan markdown content to save."),
      }),
      execute: async ({ content }, context?: { abortSignal?: AbortSignal }) => {
        throwIfAborted(context?.abortSignal ?? signal);
        const state = new StateManager(projectRoot);
        if (!state.isInitialized()) await state.init();
        await state.writeCurrentTasks(content.trim());
        const plan = await state.readCurrentTaskPlan();
        return {
          ok: true,
          taskCount: plan?.tasks.length ?? 0,
          message: `Task plan saved with ${plan?.tasks.length ?? 0} tasks.`,
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
  const { adapter: captured, finishRun } = await createHistoryCapturingAdapter(
    projectRoot, "analyze", "Analyze project", signal,
  );
  let succeeded = false;
  try {
    await runAnalyzeOperation(projectRoot, captured);
    succeeded = true;
  } finally {
    await finishRun(succeeded ? "done" : "error");
  }
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
  const { adapter: captured, finishRun } = await createHistoryCapturingAdapter(
    projectRoot, "implement", `Implement ${taskId}`, signal,
  );
  let succeeded = false;
  try {
    await runImplementOperation(projectRoot, { taskId }, captured);
    succeeded = true;
  } finally {
    await finishRun(succeeded ? "done" : "error");
  }
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
  const auditLabels = { security: "Security audit", tests: "Tests audit", ci: "CI audit" } as const;
  const { adapter: captured, finishRun } = await createHistoryCapturingAdapter(
    projectRoot, `audit-${auditType}`, auditLabels[kind], signal,
  );
  let succeeded = false;
  try {
    await runAuditOperation(projectRoot, auditType, captured);
    succeeded = true;
  } finally {
    await finishRun(succeeded ? "done" : "error");
  }
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
