export interface AppendTaskOptions {
  title: string;
  description?: string;
  files?: string[];
}

export interface AppendTaskResult {
  taskId: number;
  updatedMarkdown: string;
}

export interface AppendTaskPlanResult {
  taskId: number;
  plan: CanonicalTaskPlanDocument;
}

export interface CanonicalTaskPlanTask {
  id: number;
  title: string;
  description: string;
  files: string[];
  dependencies: string;
  acceptanceCriteria: string;
}

export interface CanonicalTaskPlanDocument {
  version: 1;
  generatedAt: string;
  tasks: CanonicalTaskPlanTask[];
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

function normalizeFiles(files?: string[]): string[] {
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const raw of files) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return [...new Set(out)];
}

export function buildTaskBlock(taskId: number, title: string, description?: string, files?: string[]): string {
  const safeTitle = title.trim();
  const safeDescription = (description ?? "").trim() || "No description provided.";
  const safeFiles = normalizeFiles(files);
  const fileLines = safeFiles.length > 0
    ? safeFiles.map((f) => `  - \`${f}\``)
    : ["  - (to be determined)"];
  return [
    `### Task ${taskId}: ${safeTitle}`,
    `- **Description**: ${safeDescription}`,
    "- **Files to create/modify**:",
    ...fileLines,
    "- **Dependencies**: None",
    "- **Acceptance criteria**: Issue is addressed and verified.",
  ].join("\n");
}

function extractField(body: string, label: string): string | null {
  const pattern = new RegExp(`\\*\\*${label}\\*\\*:\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n###|$)`);
  const match = body.match(pattern);
  return match ? match[1].trim() : null;
}

function extractFiles(body: string): string[] {
  const filesSection = body.match(/\*\*Files to create\/modify\*\*:\s*\n([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
  if (!filesSection) return [];

  const section = filesSection[1];
  const files: string[] = [];
  const codeMatches = section.match(/`([^`]+)`/g);
  if (codeMatches) {
    files.push(...codeMatches.map((f) => f.replace(/`/g, "").split(" — ")[0].trim()));
  } else {
    const bullets = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^-\s+/.test(line))
      .map((line) => line.replace(/^-\s+/, "").trim())
      .filter((line) => line.length > 0);
    for (const bullet of bullets) {
      const normalized = bullet.replace(/^[`'"]|[`'"]$/g, "").trim();
      if (
        normalized.toLowerCase() === "(to be determined)"
        || normalized.toLowerCase() === "tbd"
        || normalized.toLowerCase() === "none"
      ) {
        continue;
      }
      files.push(normalized.split(" — ")[0].trim());
    }
  }
  return normalizeFiles(files);
}

export function parseTaskPlanMarkdown(markdown: string): CanonicalTaskPlanTask[] {
  const tasks: CanonicalTaskPlanTask[] = [];
  const taskPattern = /###\s*Task\s*(\d+):\s*(.+?)(?:\n([\s\S]*?))?(?=\n###\s*Task|\n##\s|$)/g;

  let match: RegExpExecArray | null;
  while ((match = taskPattern.exec(markdown)) !== null) {
    const id = Number.parseInt(match[1], 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    const title = match[2].trim();
    const body = match[3] ?? "";
    const description = extractField(body, "Description")
      ?? body.split("\n")[0]?.trim()
      ?? "No description provided.";
    const dependencies = extractField(body, "Dependencies") ?? "None";
    const acceptanceCriteria = extractField(body, "Acceptance criteria") ?? "Task implemented and tests pass";
    const files = extractFiles(body);

    tasks.push({
      id,
      title,
      description,
      files,
      dependencies: dependencies.trim() || "None",
      acceptanceCriteria: acceptanceCriteria.trim() || "Task implemented and tests pass",
    });
  }

  return tasks.sort((a, b) => a.id - b.id);
}

export function renderTaskPlanMarkdown(tasks: CanonicalTaskPlanTask[]): string {
  const ordered = [...tasks].sort((a, b) => a.id - b.id);
  const blocks = ordered.map((task) => {
    const safeFiles = normalizeFiles(task.files);
    const fileLines = safeFiles.length > 0
      ? safeFiles.map((f) => `  - \`${f}\``)
      : ["  - (to be determined)"];
    return [
      `### Task ${task.id}: ${task.title.trim()}`,
      `- **Description**: ${(task.description ?? "").trim() || "No description provided."}`,
      "- **Files to create/modify**:",
      ...fileLines,
      `- **Dependencies**: ${(task.dependencies ?? "").trim() || "None"}`,
      `- **Acceptance criteria**: ${(task.acceptanceCriteria ?? "").trim() || "Task implemented and tests pass"}`,
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
  const raw = input as Partial<CanonicalTaskPlanDocument>;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const normalizedTasks: CanonicalTaskPlanTask[] = [];

  for (const maybeTask of tasks) {
    if (!maybeTask || typeof maybeTask !== "object") continue;
    const task = maybeTask as Partial<CanonicalTaskPlanTask>;
    const id = Number(task.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const title = typeof task.title === "string" ? task.title.trim() : "";
    if (!title) continue;
    normalizedTasks.push({
      id,
      title,
      description: typeof task.description === "string" ? task.description.trim() : "",
      files: normalizeFiles(task.files),
      dependencies: typeof task.dependencies === "string" ? task.dependencies.trim() || "None" : "None",
      acceptanceCriteria: typeof task.acceptanceCriteria === "string"
        ? task.acceptanceCriteria.trim() || "Task implemented and tests pass"
        : "Task implemented and tests pass",
    });
  }

  return {
    version: 1,
    generatedAt: typeof raw.generatedAt === "string" && raw.generatedAt.trim()
      ? raw.generatedAt
      : new Date().toISOString(),
    tasks: normalizedTasks.sort((a, b) => a.id - b.id),
  };
}

export function appendTaskToPlan(existingMarkdown: string | null, options: AppendTaskOptions): AppendTaskResult {
  const existing = (existingMarkdown ?? "").trim();
  const taskId = nextTaskId(existing);
  const block = buildTaskBlock(taskId, options.title, options.description, options.files);
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
  const maxTaskId = normalizedExisting.tasks.reduce((max, task) => Math.max(max, task.id), 0);
  const taskId = maxTaskId + 1;

  const nextTask: CanonicalTaskPlanTask = {
    id: taskId,
    title: options.title.trim(),
    description: (options.description ?? "").trim() || "No description provided.",
    files: normalizeFiles(options.files),
    dependencies: "None",
    acceptanceCriteria: "Issue is addressed and verified.",
  };

  return {
    taskId,
    plan: {
      version: 1,
      generatedAt: new Date().toISOString(),
      tasks: [...normalizedExisting.tasks, nextTask].sort((a, b) => a.id - b.id),
    },
  };
}
