import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { generateText, streamText, type LanguageModel, type ToolSet } from "ai";
import { createNullLogger, type Logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPromptCandidates(roleName: string): string[] {
  const file = `${roleName}.md`;
  return [
    join(__dirname, "..", "llm", "prompts", file),
    join(__dirname, "..", "llm", "prompts", "prompts", file),
    join(__dirname, "..", "..", "src", "llm", "prompts", file),
  ];
}

/**
 * Completion status protocol (inspired by gstack).
 * Each role returns a status that drives the orchestration flow.
 */
export type CompletionStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "NEEDS_INPUT"
  | "BLOCKED";

export interface RoleResult {
  status: CompletionStatus;
  output: string;
  concerns?: string[];
}

type RunProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

export interface RoleExecutionOptions {
  tools?: ToolSet;
  providerOptions?: RunProviderOptions;
  capabilities?: {
    supportsTools?: boolean;
    supportsJson?: boolean;
    supportsStreaming?: boolean;
  };
  additionalSystemContext?: string;
  maxOutputTokens?: number;
  logger?: Logger;
}

export interface RoleDetailedResult {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 6000;
const FALLBACK_MAX_OUTPUT_TOKENS = 2048;
const MAX_SYSTEM_CHARS_ON_TOKEN_RETRY = 48_000;
const MAX_PROMPT_CHARS_ON_TOKEN_RETRY = 12_000;
const MAX_CONVERSATION_CHARS_ON_TOKEN_RETRY = 24_000;
const MAX_MESSAGE_CHARS_ON_TOKEN_RETRY = 6_000;
const TOKEN_TRIM_MARKER = "\n\n[... trimmed for token budget ...]\n\n";

function normalizeMaxOutputTokens(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(256, Math.floor(Number(value)));
}

function trimForBudget(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const marker = TOKEN_TRIM_MARKER;
  const budget = Math.max(0, maxChars - marker.length);
  if (budget <= 0) return input.slice(0, maxChars);
  const head = Math.ceil(budget * 0.7);
  const tail = Math.max(0, budget - head);
  return `${input.slice(0, head)}${marker}${input.slice(input.length - tail)}`;
}

function compactConversationMessages(
  messages: { role: "user" | "assistant"; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const picked: { role: "user" | "assistant"; content: string }[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const perMessage = trimForBudget(message.content, MAX_MESSAGE_CHARS_ON_TOKEN_RETRY);
    const remaining = MAX_CONVERSATION_CHARS_ON_TOKEN_RETRY - used;
    if (remaining <= 0) break;
    const bounded = perMessage.length > remaining
      ? trimForBudget(perMessage, remaining)
      : perMessage;
    picked.push({ role: message.role, content: bounded });
    used += bounded.length;
  }

  const compacted = picked.reverse();
  return compacted.length > 0 ? compacted : messages.slice(-1);
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    const causeText = cause ? ` ${stringifyError(cause)}` : "";
    return `${error.message}${causeText}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isTokenBudgetError(error: unknown): boolean {
  const text = stringifyError(error).toLowerCase();
  return (
    text.includes("rate_limit_exceeded")
    || text.includes("tokens per min")
    || text.includes("request too large")
    || text.includes("context length")
    || text.includes("maximum context length")
    || text.includes("too many tokens")
  );
}

function isMcpConnectorError(error: unknown): boolean {
  const text = stringifyError(error).toLowerCase();
  return (
    text.includes("external_connector_error")
    || text.includes("error retrieving tool list from mcp server")
    || (text.includes("mcp") && text.includes("unauthorized"))
  );
}

function formatRoleFailure(roleName: string, error: unknown): string {
  const message = stringifyError(error).trim();
  if (isTokenBudgetError(error)) {
    return `Role '${roleName}' exceeded provider token budget after automatic compaction. ${message}`;
  }
  return message || `Role '${roleName}' failed`;
}

function buildSystemPrompt(
  systemPrompt: string,
  systemContext: string,
  options?: RoleExecutionOptions,
): string {
  const sections = [systemPrompt];
  if (options?.additionalSystemContext) {
    sections.push(options.additionalSystemContext);
  }
  sections.push(systemContext);
  return sections.join("\n\n---\n\n");
}

/**
 * Load a role's system prompt from its markdown file.
 */
export async function loadPrompt(roleName: string): Promise<string> {
  const candidates = getPromptCandidates(roleName);
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFile(path, "utf-8");
    }
  }
  throw new Error(`Prompt file not found for role '${roleName}'. Looked in: ${candidates.join(", ")}`);
}

/**
 * Run a role with streaming output to the console.
 */
export async function runRoleStreaming(
  model: LanguageModel,
  roleName: string,
  systemContext: string,
  userMessage: string,
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<string> {
  const logger = options?.logger ?? createNullLogger(roleName);
  const start = Date.now();
  const systemPrompt = await loadPrompt(roleName);
  const baseSystem = buildSystemPrompt(systemPrompt, systemContext, options);
  const maxOutputTokens = normalizeMaxOutputTokens(options?.maxOutputTokens);

  logger.debug(`Starting role: ${roleName}`, { streaming: true });

  const tools = options?.capabilities?.supportsTools === false ? undefined : options?.tools;
  if (options?.tools && options?.capabilities?.supportsTools === false) {
    logger.warn(`Provider for role '${roleName}' does not support tools. Continuing without tools.`);
  }
  const canDisableMcp = !!tools || !!options?.providerOptions;

  const attempts = [
    { system: baseSystem, prompt: userMessage, maxOutputTokens },
    {
      system: trimForBudget(baseSystem, MAX_SYSTEM_CHARS_ON_TOKEN_RETRY),
      prompt: trimForBudget(userMessage, MAX_PROMPT_CHARS_ON_TOKEN_RETRY),
      maxOutputTokens: Math.min(maxOutputTokens, FALLBACK_MAX_OUTPUT_TOKENS),
    },
  ];
  const canRetryCompacted = (
    attempts[1].system !== attempts[0].system
    || attempts[1].prompt !== attempts[0].prompt
    || attempts[1].maxOutputTokens !== attempts[0].maxOutputTokens
  );

  attemptLoop:
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const current = attempts[attempt];
    const modes = canDisableMcp ? [false, true] : [false];
    for (const disableMcp of modes) {
      const activeTools = disableMcp ? undefined : tools;
      const activeProviderOptions = disableMcp ? undefined : options?.providerOptions;
      try {
        if (options?.capabilities?.supportsStreaming === false) {
          const result = await generateText({
            model,
            system: current.system,
            prompt: current.prompt,
            tools: activeTools,
            providerOptions: activeProviderOptions,
            maxOutputTokens: current.maxOutputTokens,
          });
          if (onChunk) onChunk(result.text);
          logger.info(`Role complete: ${roleName}`, {
            elapsedMs: Date.now() - start,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            outputChars: result.text.length,
          });
          return result.text;
        }

        const stream = streamText({
          model,
          system: current.system,
          prompt: current.prompt,
          tools: activeTools,
          providerOptions: activeProviderOptions,
          maxOutputTokens: current.maxOutputTokens,
        });

        if (onChunk) {
          for await (const chunk of stream.textStream) {
            onChunk(chunk);
          }
        }

        const result = await stream.text;
        const usage = await stream.usage;
        if (!result.trim()) {
          logger.warn(`Role ${roleName} returned empty streamed output. Retrying once without streaming.`);
          const fallback = await generateText({
            model,
            system: current.system,
            prompt: current.prompt,
            tools: activeTools,
            providerOptions: activeProviderOptions,
            maxOutputTokens: current.maxOutputTokens,
          });
          if (!fallback.text.trim()) {
            throw new Error(`Role '${roleName}' returned an empty response`);
          }
          if (onChunk) onChunk(fallback.text);
          logger.info(`Role complete: ${roleName}`, {
            elapsedMs: Date.now() - start,
            inputTokens: fallback.usage?.inputTokens,
            outputTokens: fallback.usage?.outputTokens,
            outputChars: fallback.text.length,
            streamFallback: true,
          });
          return fallback.text;
        }
        logger.info(`Role complete: ${roleName}`, {
          elapsedMs: Date.now() - start,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          outputChars: result.length,
        });
        return result;
      } catch (error: unknown) {
        if (!disableMcp && canDisableMcp && isMcpConnectorError(error)) {
          logger.warn(`Role ${roleName} hit MCP connector error. Retrying without MCP tools.`);
          continue;
        }
        const isFirstAttempt = attempt === 0;
        if (isFirstAttempt && canRetryCompacted && isTokenBudgetError(error)) {
          logger.warn(`Role ${roleName} hit token budget. Retrying with compacted context.`);
          continue attemptLoop;
        }
        throw new Error(formatRoleFailure(roleName, error));
      }
    }
  }

  throw new Error(`Role '${roleName}' failed`);
}

/**
 * Run a role and return the full result (no streaming).
 */
export async function runRole(
  model: LanguageModel,
  roleName: string,
  systemContext: string,
  userMessage: string,
  options?: RoleExecutionOptions,
): Promise<string> {
  const detailed = await runRoleDetailed(model, roleName, systemContext, userMessage, options);
  return detailed.text;
}

/**
 * Run a role and return text + token usage.
 */
export async function runRoleDetailed(
  model: LanguageModel,
  roleName: string,
  systemContext: string,
  userMessage: string,
  options?: RoleExecutionOptions,
): Promise<RoleDetailedResult> {
  const logger = options?.logger ?? createNullLogger(roleName);
  const start = Date.now();
  const systemPrompt = await loadPrompt(roleName);
  const baseSystem = buildSystemPrompt(systemPrompt, systemContext, options);
  const maxOutputTokens = normalizeMaxOutputTokens(options?.maxOutputTokens);

  logger.debug(`Starting role: ${roleName}`);

  const tools = options?.capabilities?.supportsTools === false ? undefined : options?.tools;
  if (options?.tools && options?.capabilities?.supportsTools === false) {
    logger.warn(`Provider for role '${roleName}' does not support tools. Continuing without tools.`);
  }
  const canDisableMcp = !!tools || !!options?.providerOptions;

  const attempts = [
    { system: baseSystem, prompt: userMessage, maxOutputTokens },
    {
      system: trimForBudget(baseSystem, MAX_SYSTEM_CHARS_ON_TOKEN_RETRY),
      prompt: trimForBudget(userMessage, MAX_PROMPT_CHARS_ON_TOKEN_RETRY),
      maxOutputTokens: Math.min(maxOutputTokens, FALLBACK_MAX_OUTPUT_TOKENS),
    },
  ];
  const canRetryCompacted = (
    attempts[1].system !== attempts[0].system
    || attempts[1].prompt !== attempts[0].prompt
    || attempts[1].maxOutputTokens !== attempts[0].maxOutputTokens
  );

  attemptLoop:
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const current = attempts[attempt];
    const modes = canDisableMcp ? [false, true] : [false];
    for (const disableMcp of modes) {
      const activeTools = disableMcp ? undefined : tools;
      const activeProviderOptions = disableMcp ? undefined : options?.providerOptions;
      try {
        const result = await generateText({
          model,
          system: current.system,
          prompt: current.prompt,
          tools: activeTools,
          providerOptions: activeProviderOptions,
          maxOutputTokens: current.maxOutputTokens,
        });

        logger.info(`Role complete: ${roleName}`, {
          elapsedMs: Date.now() - start,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          outputChars: result.text.length,
        });

        return {
          text: result.text,
          usage: {
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
          },
        };
      } catch (error: unknown) {
        if (!disableMcp && canDisableMcp && isMcpConnectorError(error)) {
          logger.warn(`Role ${roleName} hit MCP connector error. Retrying without MCP tools.`);
          continue;
        }
        const isFirstAttempt = attempt === 0;
        if (isFirstAttempt && canRetryCompacted && isTokenBudgetError(error)) {
          logger.warn(`Role ${roleName} hit token budget. Retrying with compacted context.`);
          continue attemptLoop;
        }
        throw new Error(formatRoleFailure(roleName, error));
      }
    }
  }

  throw new Error(`Role '${roleName}' failed`);
}

/**
 * Run a conversational role (multi-turn, for clarification).
 */
export async function runConversationalRole(
  model: LanguageModel,
  roleName: string,
  systemContext: string,
  messages: { role: "user" | "assistant"; content: string }[],
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<string> {
  const systemPrompt = await loadPrompt(roleName);
  const baseSystem = buildSystemPrompt(systemPrompt, systemContext, options);
  const maxOutputTokens = normalizeMaxOutputTokens(options?.maxOutputTokens);
  const compactedSystem = trimForBudget(baseSystem, MAX_SYSTEM_CHARS_ON_TOKEN_RETRY);
  const compactedMessages = compactConversationMessages(messages);
  const logger = options?.logger ?? createNullLogger(roleName);
  const tools = options?.capabilities?.supportsTools === false ? undefined : options?.tools;
  if (options?.tools && options?.capabilities?.supportsTools === false) {
    logger.warn(`Provider for role '${roleName}' does not support tools. Continuing without tools.`);
  }
  const canDisableMcp = !!tools || !!options?.providerOptions;
  const attempts = [
    {
      system: baseSystem,
      messages,
      maxOutputTokens: Math.min(maxOutputTokens, 3072),
    },
    {
      system: compactedSystem,
      messages: compactedMessages,
      maxOutputTokens: Math.min(maxOutputTokens, 1536),
    },
  ];
  const canRetryCompacted = (
    attempts[1].system !== attempts[0].system
    || attempts[1].messages.some((msg, index) => {
      const original = attempts[0].messages[index];
      return !original || original.role !== msg.role || original.content !== msg.content;
    })
    || attempts[1].messages.length !== attempts[0].messages.length
    || attempts[1].maxOutputTokens !== attempts[0].maxOutputTokens
  );

  attemptLoop:
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const current = attempts[attempt];
    const modes = canDisableMcp ? [false, true] : [false];
    for (const disableMcp of modes) {
      const activeTools = disableMcp ? undefined : tools;
      const activeProviderOptions = disableMcp ? undefined : options?.providerOptions;
      try {
        if (options?.capabilities?.supportsStreaming === false) {
          const result = await generateText({
            model,
            system: current.system,
            messages: current.messages,
            tools: activeTools,
            providerOptions: activeProviderOptions,
            maxOutputTokens: current.maxOutputTokens,
          });
          if (onChunk) onChunk(result.text);
          return result.text;
        }

        const { textStream, text } = streamText({
          model,
          system: current.system,
          messages: current.messages,
          tools: activeTools,
          providerOptions: activeProviderOptions,
          maxOutputTokens: current.maxOutputTokens,
        });

        if (onChunk) {
          for await (const chunk of textStream) {
            onChunk(chunk);
          }
        }

        return await text;
      } catch (error: unknown) {
        if (!disableMcp && canDisableMcp && isMcpConnectorError(error)) {
          logger.warn(`Role ${roleName} hit MCP connector error. Retrying without MCP tools.`);
          continue;
        }
        const isFirstAttempt = attempt === 0;
        if (isFirstAttempt && canRetryCompacted && isTokenBudgetError(error)) {
          logger.warn(`Role ${roleName} hit token budget in conversation. Retrying with compacted context.`);
          continue attemptLoop;
        }
        throw new Error(formatRoleFailure(roleName, error));
      }
    }
  }

  throw new Error(`Role '${roleName}' failed`);
}
