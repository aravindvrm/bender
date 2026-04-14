export interface AppendTaskOptions {
  title: string;
  description?: string;
}

export interface AppendTaskResult {
  taskId: number;
  updatedMarkdown: string;
}

export function parseTaskIds(markdown: string): number[] {
  const matches = [...markdown.matchAll(/###\s*Task\s*(\d+)\s*:/gi)];
  return matches
    .map((m) => Number.parseInt(m[1], 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function nextTaskId(markdown: string): number {
  const ids = parseTaskIds(markdown);
  if (ids.length === 0) return 1;
  return Math.max(...ids) + 1;
}

export function buildTaskBlock(taskId: number, title: string, description?: string): string {
  const safeTitle = title.trim();
  const safeDescription = (description ?? "").trim() || "No description provided.";
  return [
    `### Task ${taskId}: ${safeTitle}`,
    `- **Description**: ${safeDescription}`,
    "- **Files to create/modify**:",
    "  - (to be determined)",
    "- **Dependencies**: None",
    "- **Acceptance criteria**: Issue is addressed and verified.",
  ].join("\n");
}

export function appendTaskToPlan(existingMarkdown: string | null, options: AppendTaskOptions): AppendTaskResult {
  const existing = (existingMarkdown ?? "").trim();
  const taskId = nextTaskId(existing);
  const block = buildTaskBlock(taskId, options.title, options.description);
  return {
    taskId,
    updatedMarkdown: existing ? `${existing}\n\n${block}` : block,
  };
}
