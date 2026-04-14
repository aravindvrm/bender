import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../state/manager.js";
import { formatContextForPrompt } from "../state/manager.js";
import type { RoleExecutionOptions } from "./base.js";

export interface TaskDescription {
  id: number;
  title: string;
  description: string;
  files: string[];
  acceptanceCriteria: string;
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

  // Read existing files that will be modified
  const existingFileContents: string[] = [];
  for (const filePath of task.files) {
    const fullPath = join(projectRoot, filePath);
    if (existsSync(fullPath)) {
      const content = await readFile(fullPath, "utf-8");
      existingFileContents.push(`### Existing file: ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  const existingFilesSection = existingFileContents.length > 0
    ? `\n\n## Existing Files (to be modified)\n\n${existingFileContents.join("\n\n")}`
    : "";

  const result = await runRoleStreaming(
    model,
    "implementer",
    `${contextStr}${existingFilesSection}`,
    `Implement the following task:\n\n**Task ${task.id}: ${task.title}**\n\n${task.description}\n\n**Files to create/modify:**\n${task.files.map((f) => `- \`${f}\``).join("\n")}\n\n**Acceptance criteria:** ${task.acceptanceCriteria}\n\nProduce complete file contents for every file listed above, following the exact output format specified in your instructions.`,
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
