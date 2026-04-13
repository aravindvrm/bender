import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { generateText, streamText, type LanguageModel, type ToolSet } from "ai";

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
  additionalSystemContext?: string;
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
  const systemPrompt = await loadPrompt(roleName);

  const { textStream, text } = streamText({
    model,
    system: buildSystemPrompt(systemPrompt, systemContext, options),
    prompt: userMessage,
    tools: options?.tools,
    providerOptions: options?.providerOptions,
    maxOutputTokens: 16384,
  });

  if (onChunk) {
    for await (const chunk of textStream) {
      onChunk(chunk);
    }
  }

  return await text;
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
  const systemPrompt = await loadPrompt(roleName);

  const result = await generateText({
    model,
    system: buildSystemPrompt(systemPrompt, systemContext, options),
    prompt: userMessage,
    tools: options?.tools,
    providerOptions: options?.providerOptions,
    maxOutputTokens: 16384,
  });

  return result.text;
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

  const { textStream, text } = streamText({
    model,
    system: buildSystemPrompt(systemPrompt, systemContext, options),
    messages,
    tools: options?.tools,
    providerOptions: options?.providerOptions,
    maxOutputTokens: 8192,
  });

  if (onChunk) {
    for await (const chunk of textStream) {
      onChunk(chunk);
    }
  }

  return await text;
}
