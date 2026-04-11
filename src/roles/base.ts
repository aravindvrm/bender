import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { generateText, streamText, type LanguageModel } from "ai";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Look for prompts in both dist/ (production) and src/ (development)
function getPromptsDir(): string {
  const distPrompts = join(__dirname, "..", "llm", "prompts");
  if (existsSync(distPrompts)) return distPrompts;
  // Fall back to source directory (for development)
  const srcPrompts = join(__dirname, "..", "..", "src", "llm", "prompts");
  if (existsSync(srcPrompts)) return srcPrompts;
  return distPrompts; // will error on read, which is a clear signal
}

const PROMPTS_DIR = getPromptsDir();

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

/**
 * Load a role's system prompt from its markdown file.
 */
export async function loadPrompt(roleName: string): Promise<string> {
  const promptPath = join(PROMPTS_DIR, `${roleName}.md`);
  return readFile(promptPath, "utf-8");
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
): Promise<string> {
  const systemPrompt = await loadPrompt(roleName);

  const { textStream, text } = streamText({
    model,
    system: `${systemPrompt}\n\n---\n\n${systemContext}`,
    prompt: userMessage,
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
): Promise<string> {
  const systemPrompt = await loadPrompt(roleName);

  const result = await generateText({
    model,
    system: `${systemPrompt}\n\n---\n\n${systemContext}`,
    prompt: userMessage,
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
): Promise<string> {
  const systemPrompt = await loadPrompt(roleName);

  const { textStream, text } = streamText({
    model,
    system: `${systemPrompt}\n\n---\n\n${systemContext}`,
    messages,
    maxOutputTokens: 8192,
  });

  if (onChunk) {
    for await (const chunk of textStream) {
      onChunk(chunk);
    }
  }

  return await text;
}
