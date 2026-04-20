import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";
import type { ProjectContext } from "../state/manager.js";
import { formatContextForPrompt } from "../state/manager.js";
import type { RoleExecutionOptions } from "./base.js";

export interface TaskDescription {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface FileOperation {
  path: string;
  action: "create" | "modify";
  content: string;
}

function normalizePathCandidate(raw: string): string {
  return raw
    .replace(/\s*\n\s*/g, "")
    .replace(/\s+/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function renderAcceptanceCriteria(criteria: string[]): string {
  const normalized = criteria
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (normalized.length === 0) return "- Task implemented and tests pass";
  return normalized.map((item) => `- ${item}`).join("\n");
}

/**
 * Implement a single task: generate code for all files in the task.
 */
export async function implementTask(
  model: LanguageModel,
  task: TaskDescription,
  projectRoot: string,
  existingContext: ProjectContext,
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<FileOperation[]> {
  const contextStr = formatContextForPrompt(existingContext);
  const existingFilesSection = "";

  const result = await runRoleStreaming(
    model,
    "implementer",
    `${contextStr}${existingFilesSection}`,
    `Implement the following task:\n\n**Task ${task.id}: ${task.title}**\n\n${task.description}\n\n**Acceptance criteria:**\n${renderAcceptanceCriteria(task.acceptanceCriteria)}\n\nChoose the minimal set of files required to complete the task and produce complete file contents using the required output format.`,
    onChunk,
    options,
  );

  return parseFileOperations(result);
}

/**
 * Parse the implementer's output into file operations.
 */
export function parseFileOperations(output: string): FileOperation[] {
  const operations: FileOperation[] = [];
  // Match patterns like: ### FILE: path/to/file.ts\nACTION: create\n```typescript\n...\n```
  const filePattern = /###\s*FILE:\s*(.+?)\s*\nACTION:\s*(create|modify)\s*\n```(?:typescript|tsx|ts|javascript|js|json|sql|css|yaml|yml|md|prisma|env|toml|sh)?\n([\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(output)) !== null) {
    operations.push({
      path: match[1].trim(),
      action: match[2].trim() as "create" | "modify",
      content: match[3].trimEnd(),
    });
  }

  // Recovery parser for malformed/token-fragmented headers seen in streamed runs.
  // Examples:
  // ###\n FILE\n:\n path\nACTION\n:\n modify\n```\n...
  if (operations.length === 0) {
    const repaired = output
      .replace(/#\s*#\s*#/g, "###")
      .replace(/FILE\s*\n\s*:/gi, "FILE:")
      .replace(/ACTION\s*\n\s*:/gi, "ACTION:")
      .replace(/`\s*\n\s*`\s*\n\s*`/g, "```");

    const loosePattern = /###\s*FILE\s*:\s*([\s\S]*?)\s*ACTION\s*:\s*(create|modify)\s*```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)```/gi;
    while ((match = loosePattern.exec(repaired)) !== null) {
      const path = normalizePathCandidate(match[1]);
      if (!path) continue;
      operations.push({
        path,
        action: match[2].trim().toLowerCase() as "create" | "modify",
        content: match[3].trimEnd(),
      });
    }
  }

  // Fallback: try simpler pattern if the structured format wasn't followed exactly
  if (operations.length === 0) {
    const simplePattern = /(?:^|\n)(?:#+\s+)?`?([^\s`]+\.[a-z]+)`?\s*\n```(?:typescript|tsx|ts|javascript|js|json|sql|css|yaml|yml|md|prisma|env|toml|sh)?\n([\s\S]*?)```/g;
    while ((match = simplePattern.exec(output)) !== null) {
      const path = match[1].trim();
      // Skip paths that look like markdown headers or code examples
      if (path.includes("/") || path.match(/^[a-z]/)) {
        operations.push({
          path,
          action: "create",
          content: match[2].trimEnd(),
        });
      }
    }
  }

  return operations;
}
