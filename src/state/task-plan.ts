export type TaskStatus = "todo" | "in_progress" | "done";

export interface AppendTaskOptions {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  implementerAgentId?: string;
  status?: TaskStatus;
}

export interface AppendTaskResult {
  taskId: string;
  updatedMarkdown: string;
}

export interface AppendTaskPlanResult {
  taskId: string;
  plan: CanonicalTaskPlanDocument;
}

export interface CanonicalTaskPlanTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  implementerAgentId: string;
  status: TaskStatus;
}

export interface CanonicalTaskPlanDocument {
  version: 1;
  generatedAt: string;
  tasks: CanonicalTaskPlanTask[];
}

const DEFAULT_ACCEPTANCE_CRITERIA = "Task implemented and tests pass";
const DEFAULT_IMPLEMENTER_AGENT_ID = "implementer";
const DEFAULT_TASK_STATUS: TaskStatus = "todo";

function normalizeTaskStatus(value: unknown): TaskStatus {
  if (value === "todo" || value === "in_progress" || value === "done") return value;
  return DEFAULT_TASK_STATUS;
}

function normalizeTaskTitle(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTaskDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_IMPLEMENTER_AGENT_ID;
  const trimmed = value.trim();
  return trimmed || DEFAULT_IMPLEMENTER_AGENT_ID;
}

function parseCriteriaFromString(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const bulletLines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);

  if (bulletLines.length > 0) {
    return bulletLines;
  }

  const semicolonSplit = trimmed
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (semicolonSplit.length > 1) {
    return semicolonSplit;
  }

  return [trimmed];
}

export function normalizeAcceptanceCriteria(value: unknown): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (normalized.length > 0) return [...new Set(normalized)];
  } else if (typeof value === "string") {
    const parsed = parseCriteriaFromString(value);
    if (parsed.length > 0) return [...new Set(parsed)];
  }
  return [DEFAULT_ACCEPTANCE_CRITERIA];
}

export function taskIdToOrdinal(taskId: string): number {
  const match = taskId.match(/^task-(\d+)$/i);
  if (!match) return Number.NaN;
  return Number.parseInt(match[1], 10);
}

export function normalizeTaskId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return `task-${Math.floor(value)}`;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const canonicalMatch = trimmed.match(/^task-(\d+)$/i);
  if (canonicalMatch) {
    const n = Number.parseInt(canonicalMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return `task-${n}`;
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0) return `task-${n}`;
  }

  return null;
}

export function parseTaskIds(markdown: string): string[] {
  const matches = [...markdown.matchAll(/###\s*Task\s+([^:\n]+)\s*:/gi)];
  return matches
    .map((m) => normalizeTaskId(m[1]))
    .filter((id): id is string => Boolean(id));
}

export function nextTaskId(markdown: string): string {
  const ids = parseTaskIds(markdown);
  if (ids.length === 0) return "task-1";
  const max = ids.reduce((acc, id) => {
    const n = taskIdToOrdinal(id);
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  return `task-${max + 1}`;
}

function renderAcceptanceCriteria(criteria: string[]): string[] {
  const normalized = normalizeAcceptanceCriteria(criteria);
  return normalized.map((entry) => `  - ${entry}`);
}

export function buildTaskBlock(
  taskId: string,
  title: string,
  description?: string,
  acceptanceCriteria?: string[],
  implementerAgentId?: string,
  status?: TaskStatus,
): string {
  const safeTitle = title.trim();
  const safeDescription = (description ?? "").trim() || "No description provided.";
  const safeStatus = normalizeTaskStatus(status);
  const safeAgentId = normalizeAgentId(implementerAgentId);

  return [
    `### Task ${taskId}: ${safeTitle}`,
    `- **Description**: ${safeDescription}`,
    `- **Status**: ${safeStatus}`,
    `- **Implementer Agent**: ${safeAgentId}`,
    "- **Acceptance criteria**:",
    ...renderAcceptanceCriteria(acceptanceCriteria ?? [DEFAULT_ACCEPTANCE_CRITERIA]),
  ].join("\n");
}

function extractField(body: string, label: string): string | null {
  const pattern = new RegExp(`\\*\\*${label}\\*\\*:\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n###|$)`, "i");
  const match = body.match(pattern);
  return match ? match[1].trim() : null;
}

function extractAcceptanceCriteria(body: string): string[] {
  const sectionMatch = body.match(/\*\*Acceptance criteria\*\*:\s*\n([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/i);
  if (sectionMatch) {
    return normalizeAcceptanceCriteria(sectionMatch[1]);
  }

  const singleLine = extractField(body, "Acceptance criteria");
  if (singleLine) {
    return normalizeAcceptanceCriteria(singleLine);
  }

  return [DEFAULT_ACCEPTANCE_CRITERIA];
}

export function parseTaskPlanMarkdown(markdown: string): CanonicalTaskPlanTask[] {
  const tasks: CanonicalTaskPlanTask[] = [];
  const taskPattern = /###\s*Task\s+([^:\n]+)\s*:\s*(.+?)(?:\n([\s\S]*?))?(?=\n###\s*Task|\n##\s|$)/gi;

  let match: RegExpExecArray | null;
  while ((match = taskPattern.exec(markdown)) !== null) {
    const id = normalizeTaskId(match[1]);
    if (!id) continue;

    const title = normalizeTaskTitle(match[2]);
    if (!title) continue;

    const body = match[3] ?? "";
    const description = extractField(body, "Description")
      ?? body.split("\n")[0]?.trim()
      ?? "No description provided.";

    const status = normalizeTaskStatus(extractField(body, "Status"));
    const implementerAgentId = normalizeAgentId(
      extractField(body, "Implementer Agent")
      ?? extractField(body, "Agent"),
    );

    tasks.push({
      id,
      title,
      description: description.trim() || "No description provided.",
      acceptanceCriteria: extractAcceptanceCriteria(body),
      implementerAgentId,
      status,
    });
  }

  return tasks.sort((a, b) => taskIdToOrdinal(a.id) - taskIdToOrdinal(b.id));
}

export function renderTaskPlanMarkdown(tasks: CanonicalTaskPlanTask[]): string {
  const ordered = [...tasks].sort((a, b) => taskIdToOrdinal(a.id) - taskIdToOrdinal(b.id));
  const blocks = ordered.map((task) => {
    return [
      `### Task ${task.id}: ${task.title.trim()}`,
      `- **Description**: ${(task.description ?? "").trim() || "No description provided."}`,
      `- **Status**: ${normalizeTaskStatus(task.status)}`,
      `- **Implementer Agent**: ${normalizeAgentId(task.implementerAgentId)}`,
      "- **Acceptance criteria**:",
      ...renderAcceptanceCriteria(task.acceptanceCriteria),
    ].join("\n");
  });
  return blocks.join("\n\n").trim();
}

export function toCanonicalTaskPlan(markdown: string): CanonicalTaskPlanDocument {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    tasks: parseTaskPlanMarkdown(markdown),
  };
}

export function normalizeCanonicalTaskPlan(input: unknown): CanonicalTaskPlanDocument | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Partial<CanonicalTaskPlanDocument> & { tasks?: unknown[] };
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const normalizedTasks: CanonicalTaskPlanTask[] = [];

  for (const maybeTask of tasks) {
    if (!maybeTask || typeof maybeTask !== "object") continue;
    const task = maybeTask as unknown as Record<string, unknown>;
    const id = normalizeTaskId(task.id);
    if (!id) continue;

    const title = normalizeTaskTitle(task.title);
    if (!title) continue;

    const description = normalizeTaskDescription(task.description) || "No description provided.";
    const acceptanceCriteria = normalizeAcceptanceCriteria(task.acceptanceCriteria);
    const implementerAgentId = normalizeAgentId(
      task.implementerAgentId
      ?? task.agentId,
    );

    let status = normalizeTaskStatus(task.status);
    if (status === DEFAULT_TASK_STATUS) {
      if (task.completed === true) status = "done";
      if (task.completed === false && task.status === undefined) status = DEFAULT_TASK_STATUS;
    }

    normalizedTasks.push({
      id,
      title,
      description,
      acceptanceCriteria,
      implementerAgentId,
      status,
    });
  }

  return {
    version: 1,
    generatedAt: typeof raw.generatedAt === "string" && raw.generatedAt.trim()
      ? raw.generatedAt
      : new Date().toISOString(),
    tasks: normalizedTasks.sort((a, b) => taskIdToOrdinal(a.id) - taskIdToOrdinal(b.id)),
  };
}

export function appendTaskToPlan(existingMarkdown: string | null, options: AppendTaskOptions): AppendTaskResult {
  const existing = (existingMarkdown ?? "").trim();
  const taskId = nextTaskId(existing);
  const block = buildTaskBlock(
    taskId,
    options.title,
    options.description,
    options.acceptanceCriteria,
    options.implementerAgentId,
    options.status,
  );
  return {
    taskId,
    updatedMarkdown: existing ? `${existing}\n\n${block}` : block,
  };
}

export function appendTaskToCanonicalPlan(
  existingPlan: CanonicalTaskPlanDocument | null,
  options: AppendTaskOptions,
): AppendTaskPlanResult {
  const normalizedExisting = normalizeCanonicalTaskPlan(existingPlan) ?? {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    tasks: [],
  };

  const maxTaskNumber = normalizedExisting.tasks.reduce((max, task) => {
    const ordinal = taskIdToOrdinal(task.id);
    return Number.isFinite(ordinal) ? Math.max(max, ordinal) : max;
  }, 0);
  const taskId = `task-${maxTaskNumber + 1}`;

  const nextTask: CanonicalTaskPlanTask = {
    id: taskId,
    title: options.title.trim(),
    description: (options.description ?? "").trim() || "No description provided.",
    acceptanceCriteria: normalizeAcceptanceCriteria(options.acceptanceCriteria),
    implementerAgentId: normalizeAgentId(options.implementerAgentId),
    status: normalizeTaskStatus(options.status),
  };

  return {
    taskId,
    plan: {
      version: 1,
      generatedAt: new Date().toISOString(),
      tasks: [...normalizedExisting.tasks, nextTask].sort((a, b) => taskIdToOrdinal(a.id) - taskIdToOrdinal(b.id)),
    },
  };
}
