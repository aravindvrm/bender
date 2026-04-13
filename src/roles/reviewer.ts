import type { LanguageModel } from "ai";
import { runRole } from "./base.js";
import type { FileOperation } from "./implementer.js";
import type { ProjectContext } from "../state/manager.js";
import { formatContextForPrompt } from "../state/manager.js";
import type { RoleExecutionOptions } from "./base.js";

export type ReviewStatus = "APPROVED" | "NEEDS_CHANGES" | "BLOCKED";

export interface ReviewResult {
  status: ReviewStatus;
  issues: ReviewIssue[];
  observations: string[];
  raw: string;
}

export interface ReviewIssue {
  severity: "critical" | "major" | "minor";
  file: string;
  description: string;
  fix: string;
}

/**
 * Review code changes produced by the Implementer.
 */
export async function reviewCode(
  model: LanguageModel,
  taskTitle: string,
  fileOperations: FileOperation[],
  existingContext: ProjectContext,
  options?: RoleExecutionOptions,
): Promise<ReviewResult> {
  const contextStr = formatContextForPrompt(existingContext);

  const changesStr = fileOperations
    .map(
      (op) =>
        `### ${op.path} (${op.action})\n\`\`\`\n${op.content}\n\`\`\``,
    )
    .join("\n\n");

  const result = await runRole(
    model,
    "reviewer",
    contextStr,
    `Review the following code changes for task: "${taskTitle}"\n\n${changesStr}\n\nFollow the exact output format specified in your instructions.`,
    options,
  );

  return parseReviewResult(result);
}

/**
 * Parse the reviewer's output into a structured result.
 */
function parseReviewResult(output: string): ReviewResult {
  const statusMatch = output.match(/###?\s*Status:\s*(APPROVED|NEEDS_CHANGES|BLOCKED)/i);
  const status: ReviewStatus = statusMatch
    ? (statusMatch[1].toUpperCase() as ReviewStatus)
    : "APPROVED";

  const issues: ReviewIssue[] = [];
  const issuePattern = /\*\*\[(critical|major|minor)\]\*\*\s*(?:\[([^\]]*)\])?\s*[—–-]\s*(.*?)(?:\n\s*\*\*Fix\*\*:\s*(.*?))?(?=\n\d+\.|$)/gs;
  let match: RegExpExecArray | null;
  while ((match = issuePattern.exec(output)) !== null) {
    issues.push({
      severity: match[1] as "critical" | "major" | "minor",
      file: match[2]?.trim() ?? "",
      description: match[3].trim(),
      fix: match[4]?.trim() ?? "",
    });
  }

  const observations: string[] = [];
  const obsSection = output.match(/###?\s*Observations\s*\n([\s\S]*?)(?=\n###|$)/);
  if (obsSection) {
    const obsLines = obsSection[1].match(/^- (.+)$/gm);
    if (obsLines) {
      observations.push(...obsLines.map((l) => l.replace(/^- /, "")));
    }
  }

  return { status, issues, observations, raw: output };
}
