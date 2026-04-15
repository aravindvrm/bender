import { createHash } from "node:crypto";
import { readEffectiveConfig } from "../../state/config.js";
import { StateManager, formatContextForPrompt } from "../../state/manager.js";
import { parseTaskPlanMarkdown, type CanonicalTaskPlanTask } from "../../state/task-plan.js";
import { createModelSet, getModelForTier } from "../../llm/provider.js";
import { createRoleRuntime } from "../../llm/runtime.js";
import { runRole } from "../../roles/base.js";
import { getEffectiveAgentForRole } from "../../state/agents.js";
import { GitOperations } from "../../git/operations.js";
import { parseGitHubRepoFullName } from "./github-utils.js";
import { appendTask, patchTask, setTaskLink } from "./tasks.js";

interface GitHubSession {
  accessToken: string;
}

interface GitHubIssueApiResponse {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  labels?: Array<{ name?: string } | string>;
  assignee?: { login?: string } | null;
  assignees?: Array<{ login?: string }>;
  milestone?: { title?: string } | null;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
}

interface GitHubIssueSearchResponse {
  items?: GitHubIssueApiResponse[];
}

export interface GitHubWorkItem {
  sourceType: "issue";
  repoFullName: string;
  issueNumber: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  milestone?: string;
  createdAt?: string;
  updatedAt?: string;
  alreadyLinkedTaskIds: number[];
}

export interface ListGitHubWorkItemsInput {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  milestone?: string;
  q?: string;
  unlinkedOnly?: boolean;
  limit?: number;
}

export interface ExtractionCandidate {
  id: string;
  sourceType: "issue";
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  sourceTitle: string;
  repoFullName: string;
  title: string;
  description: string;
  dependencies: string;
  acceptanceCriteria: string;
  suggestedFiles: string[];
  rationale?: string;
  notes?: string;
  warnings: string[];
}

export interface ExtractGitHubWorkItemsInput {
  workItems?: Array<Partial<GitHubWorkItem>>;
}

export interface ImportGitHubWorkItemsInput {
  candidates?: unknown[];
}

interface RuntimeRoleInputs {
  analyzer: string;
  architect: string;
  planner: string;
}

interface SimilarTaskMatch {
  taskId: number;
  title: string;
  score: number;
}

interface ListLinkedIssueMapResult {
  byIssueNumber: Map<number, number[]>;
  taskTitlePool: CanonicalTaskPlanTask[];
}

interface GitHubWorkItemDeps {
  readGitHubSession: () => Promise<GitHubSession | null>;
  githubApi: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

const MAX_STORED_ISSUE_BODY_CHARS = 40_000;
const MAX_PROMPT_ISSUE_BODY_CHARS = 12_000;
const MAX_RUNTIME_TASK_DESCRIPTION_CHARS = 4_000;

export class GitHubWorkItemsServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeListInput(input: ListGitHubWorkItemsInput): Required<ListGitHubWorkItemsInput> {
  const state = input.state === "closed" || input.state === "all" ? input.state : "open";
  const labels = (input.labels ?? []).map((value) => value.trim()).filter(Boolean);
  const assignee = (input.assignee ?? "").trim();
  const milestone = (input.milestone ?? "").trim();
  const q = (input.q ?? "").trim();
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, Number(input.limit))) : 50;
  return {
    state,
    labels,
    assignee,
    milestone,
    q,
    unlinkedOnly: Boolean(input.unlinkedOnly),
    limit,
  };
}

function normalizeIssueLabels(labels: GitHubIssueApiResponse["labels"]): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label.trim();
      return (label.name ?? "").trim();
    })
    .filter(Boolean);
}

function normalizeIssueAssignees(issue: GitHubIssueApiResponse): string[] {
  const fromPlural = (issue.assignees ?? [])
    .map((entry) => (entry.login ?? "").trim())
    .filter(Boolean);
  if (fromPlural.length > 0) return fromPlural;
  const fromSingle = (issue.assignee?.login ?? "").trim();
  return fromSingle ? [fromSingle] : [];
}

function normalizeGitHubIssue(
  issue: GitHubIssueApiResponse,
  repoFullName: string,
  alreadyLinkedTaskIds: number[],
): GitHubWorkItem | null {
  if (!issue || issue.pull_request) return null;
  const issueNumber = Number(issue.number);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return null;

  const title = (issue.title ?? "").trim();
  if (!title) return null;

  return {
    sourceType: "issue",
    repoFullName,
    issueNumber,
    title,
    body: trimForBudget(issue.body ?? "", MAX_STORED_ISSUE_BODY_CHARS),
    state: (issue.state ?? "open").trim() || "open",
    url: (issue.html_url ?? "").trim(),
    labels: normalizeIssueLabels(issue.labels),
    assignees: normalizeIssueAssignees(issue),
    milestone: (issue.milestone?.title ?? "").trim() || undefined,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    alreadyLinkedTaskIds,
  };
}

function tokenizeTitle(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function titleSimilarityScore(a: string, b: string): number {
  const setA = new Set(tokenizeTitle(a));
  const setB = new Set(tokenizeTitle(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }

  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? overlap / union : 0;
}

function findSimilarTaskTitle(title: string, existingTasks: CanonicalTaskPlanTask[]): SimilarTaskMatch | null {
  const normalizedInput = title.trim().toLowerCase();
  if (!normalizedInput) return null;

  let best: SimilarTaskMatch | null = null;
  for (const task of existingTasks) {
    const normalizedTaskTitle = task.title.trim().toLowerCase();
    if (!normalizedTaskTitle) continue;

    let score = titleSimilarityScore(normalizedInput, normalizedTaskTitle);
    if (normalizedInput === normalizedTaskTitle) {
      score = 1;
    } else if (
      normalizedInput.includes(normalizedTaskTitle)
      || normalizedTaskTitle.includes(normalizedInput)
    ) {
      score = Math.max(score, 0.92);
    }

    if (!best || score > best.score) {
      best = { taskId: task.id, title: task.title, score };
    }
  }

  if (!best) return null;
  return best.score >= 0.72 ? best : null;
}

function stableCandidateId(repoFullName: string, issueNumber: number, index: number): string {
  const digest = createHash("sha1")
    .update(`${repoFullName}#${issueNumber}#${index}`, "utf-8")
    .digest("hex")
    .slice(0, 12);
  return `issue-${issueNumber}-${digest}`;
}

function truncateForNotes(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function trimForBudget(input: string, maxChars: number): string {
  const normalized = input.trim();
  if (normalized.length <= maxChars) return normalized;
  const marker = "\n\n[... trimmed for token budget ...]\n\n";
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.75);
  const tail = Math.max(0, budget - head);
  return `${normalized.slice(0, head)}${marker}${normalized.slice(normalized.length - tail)}`;
}

async function resolveProjectRepoFullName(projectRoot: string, state: StateManager): Promise<string> {
  const gitOps = new GitOperations(projectRoot);
  if (await gitOps.isRepo()) {
    const remotes = await gitOps.getRemotes();
    const origin = remotes.find((remote) => remote.name === "origin");
    const fromOrigin = origin?.fetch ? parseGitHubRepoFullName(origin.fetch) : null;
    if (fromOrigin) return fromOrigin;
  }

  const links = await state.readTaskGitHubLinks();
  const linkedRepos = [...new Set(Object.values(links)
    .map((link) => (link.repoFullName ?? "").trim())
    .filter(Boolean))];

  if (linkedRepos.length === 1) {
    return linkedRepos[0];
  }

  if (linkedRepos.length > 1) {
    throw new GitHubWorkItemsServiceError(
      400,
      "Multiple linked repos detected in task links. Keep task links on one repo or set origin remote.",
    );
  }

  throw new GitHubWorkItemsServiceError(
    400,
    "Set linked repo first (task link repoFullName or origin remote).",
  );
}

async function listLinkedIssues(state: StateManager, repoFullName: string): Promise<ListLinkedIssueMapResult> {
  const links = await state.readTaskGitHubLinks();
  const byIssueNumber = new Map<number, number[]>();

  for (const [taskId, link] of Object.entries(links)) {
    if ((link.repoFullName ?? "").trim() !== repoFullName) continue;
    const issueNumber = Number(link.issueNumber);
    if (!Number.isFinite(issueNumber)) continue;
    const numericTaskId = Number(taskId);
    if (!Number.isFinite(numericTaskId)) continue;

    const existing = byIssueNumber.get(issueNumber) ?? [];
    existing.push(numericTaskId);
    byIssueNumber.set(issueNumber, existing);
  }

  const taskTitlePool = (await state.readCurrentTaskPlan())?.tasks ?? [];
  return { byIssueNumber, taskTitlePool };
}

function buildSearchQuery(repoFullName: string, filters: Required<ListGitHubWorkItemsInput>): string {
  const clauses = ["is:issue", `repo:${repoFullName}`];

  if (filters.state !== "all") {
    clauses.push(`state:${filters.state}`);
  }

  for (const label of filters.labels) {
    clauses.push(`label:${JSON.stringify(label)}`);
  }

  if (filters.assignee) {
    clauses.push(`assignee:${filters.assignee}`);
  }

  if (filters.milestone) {
    clauses.push(`milestone:${JSON.stringify(filters.milestone)}`);
  }

  clauses.push(filters.q);
  return clauses.join(" ").trim();
}

function parseSelectedWorkItems(input: ExtractGitHubWorkItemsInput): GitHubWorkItem[] {
  if (!Array.isArray(input.workItems) || input.workItems.length === 0) {
    throw new GitHubWorkItemsServiceError(400, "workItems must contain at least one selected item");
  }

  const normalized: GitHubWorkItem[] = [];
  for (const raw of input.workItems) {
    if (!raw || raw.sourceType !== "issue") {
      throw new GitHubWorkItemsServiceError(400, "Only sourceType=issue is supported in v1");
    }

    const issueNumber = Number(raw.issueNumber);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      throw new GitHubWorkItemsServiceError(400, "Each selected item must include a numeric issueNumber");
    }

    const repoFullName = (raw.repoFullName ?? "").trim();
    const title = (raw.title ?? "").trim();

    normalized.push({
      sourceType: "issue",
      repoFullName,
      issueNumber,
      title,
      body: trimForBudget(String(raw.body ?? ""), MAX_STORED_ISSUE_BODY_CHARS),
      state: (raw.state ?? "open").trim() || "open",
      url: (raw.url ?? "").trim(),
      labels: Array.isArray(raw.labels) ? raw.labels.map((value) => value.trim()).filter(Boolean) : [],
      assignees: Array.isArray(raw.assignees) ? raw.assignees.map((value) => value.trim()).filter(Boolean) : [],
      milestone: (raw.milestone ?? "").trim() || undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      alreadyLinkedTaskIds: Array.isArray(raw.alreadyLinkedTaskIds)
        ? raw.alreadyLinkedTaskIds.filter((value) => Number.isFinite(value)).map((value) => Number(value))
        : [],
    });
  }

  return normalized;
}

function parseImportCandidates(input: ImportGitHubWorkItemsInput): ExtractionCandidate[] {
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new GitHubWorkItemsServiceError(400, "candidates must contain at least one accepted item");
  }

  const normalized: ExtractionCandidate[] = [];
  for (const raw of input.candidates) {
    if (!raw || typeof raw !== "object") {
      throw new GitHubWorkItemsServiceError(400, "Invalid candidate payload");
    }
    const item = raw as Record<string, unknown>;

    if (item.sourceType !== "issue") {
      throw new GitHubWorkItemsServiceError(400, "Only sourceType=issue candidates are supported in v1");
    }

    const issueNumber = Number(item.sourceIssueNumber);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      throw new GitHubWorkItemsServiceError(400, "Each candidate must include sourceIssueNumber");
    }

    const title = String(item.title ?? "").trim();
    if (!title) {
      throw new GitHubWorkItemsServiceError(400, "Each candidate must include a task title");
    }

    normalized.push({
      id: String(item.id ?? "").trim() || stableCandidateId(String(item.repoFullName ?? ""), issueNumber, normalized.length + 1),
      sourceType: "issue",
      sourceIssueNumber: issueNumber,
      sourceIssueUrl: String(item.sourceIssueUrl ?? "").trim(),
      sourceTitle: String(item.sourceTitle ?? "").trim() || `Issue #${issueNumber}`,
      repoFullName: String(item.repoFullName ?? "").trim(),
      title,
      description: String(item.description ?? "").trim(),
      dependencies: String(item.dependencies ?? "").trim() || "None",
      acceptanceCriteria: String(item.acceptanceCriteria ?? "").trim() || "Task implemented and tests pass",
      suggestedFiles: Array.isArray(item.suggestedFiles)
        ? item.suggestedFiles.map((value) => String(value).trim()).filter(Boolean)
        : [],
      rationale: String(item.rationale ?? "").trim() || undefined,
      notes: String(item.notes ?? "").trim() || undefined,
      warnings: Array.isArray(item.warnings)
        ? item.warnings.map((value) => String(value).trim()).filter(Boolean)
        : [],
    });
  }

  return normalized;
}

function fallbackCandidateFromIssue(workItem: GitHubWorkItem): ExtractionCandidate {
  return {
    id: stableCandidateId(workItem.repoFullName, workItem.issueNumber, 1),
    sourceType: "issue",
    sourceIssueNumber: workItem.issueNumber,
    sourceIssueUrl: workItem.url,
    sourceTitle: workItem.title,
    repoFullName: workItem.repoFullName,
    title: `Address GitHub issue #${workItem.issueNumber}: ${workItem.title}`,
    description: workItem.body || "Implement the request described in the linked GitHub issue.",
    dependencies: "None",
    acceptanceCriteria: "Issue intent is implemented and verified.",
    suggestedFiles: [],
    warnings: [],
  };
}

async function resolveWorkItemWithFallback(
  item: GitHubWorkItem,
  repoFullName: string,
  deps: GitHubWorkItemDeps,
  accessToken: string,
): Promise<GitHubWorkItem> {
  if (item.title && item.url) {
    return { ...item, repoFullName };
  }

  const issue = await deps.githubApi<GitHubIssueApiResponse>(
    `/repos/${repoFullName}/issues/${item.issueNumber}`,
    accessToken,
  );
  const normalized = normalizeGitHubIssue(issue, repoFullName, item.alreadyLinkedTaskIds);
  if (!normalized) {
    throw new GitHubWorkItemsServiceError(404, `Issue #${item.issueNumber} not found in ${repoFullName}`);
  }
  return normalized;
}

function buildRolePrompts(workItem: GitHubWorkItem): RuntimeRoleInputs {
  const issueBody = trimForBudget(workItem.body || "(no body provided)", MAX_PROMPT_ISSUE_BODY_CHARS);
  const issueHeader = [
    `GitHub Issue #${workItem.issueNumber}: ${workItem.title}`,
    `Repo: ${workItem.repoFullName}`,
    `URL: ${workItem.url || "(not provided)"}`,
    `Labels: ${workItem.labels.length > 0 ? workItem.labels.join(", ") : "none"}`,
    `Assignees: ${workItem.assignees.length > 0 ? workItem.assignees.join(", ") : "none"}`,
    `Milestone: ${workItem.milestone ?? "none"}`,
    "",
    "Issue body:",
    issueBody,
  ].join("\n");

  return {
    analyzer: [
      "Analyze this issue as an implementation intake.",
      "Return concise sections:",
      "1. Problem statement",
      "2. What success looks like",
      "3. Ambiguities / questions",
      "4. Constraints and non-goals",
      "",
      issueHeader,
    ].join("\n"),
    architect: [
      "Architectural triage for this issue.",
      "Return concise sections:",
      "1. Scope boundaries",
      "2. Dependencies and sequencing",
      "3. Risk / complexity",
      "4. Gate line in exact format: GATE: PASS | SIMPLIFY | VALIDATE | BLOCKED",
      "",
      issueHeader,
    ].join("\n"),
    planner: [
      "Convert this issue into implementation-ready tasks.",
      "Return ONLY task blocks with the exact format:",
      "### Task <number>: <title>",
      "- **Description**: ...",
      "- **Files to create/modify**:",
      "  - `path/to/file`",
      "- **Dependencies**: None or task numbers",
      "- **Acceptance criteria**: ...",
      "",
      "Create between 1 and 3 tasks.",
      "Avoid extra sections and avoid markdown outside the task blocks.",
      "",
      issueHeader,
    ].join("\n"),
  };
}

async function runRolePipelineForWorkItem(
  projectRoot: string,
  workItem: GitHubWorkItem,
): Promise<{ analyzer: string; architect: string; planner: string }> {
  const config = await readEffectiveConfig(projectRoot);
  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();
  const systemContext = formatContextForPrompt(context);

  let models;
  try {
    models = createModelSet(config);
  } catch (err) {
    throw new GitHubWorkItemsServiceError(
      400,
      `Failed to initialize LLM provider: ${(err as Error).message}`,
    );
  }

  const analyzerAgent = await getEffectiveAgentForRole("analyzer");
  const architectAgent = await getEffectiveAgentForRole("architect");
  const plannerAgent = await getEffectiveAgentForRole("planner");

  const prompts = buildRolePrompts(workItem);

  const runWithRole = async (
    role: "analyzer" | "architect" | "planner",
    prompt: string,
  ): Promise<string> => {
    const agent = role === "analyzer"
      ? analyzerAgent
      : role === "architect"
        ? architectAgent
        : plannerAgent;

    const runtime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role,
        taskDescription: trimForBudget(
          `${workItem.title}\n${workItem.body || ""}`,
          MAX_RUNTIME_TASK_DESCRIPTION_CHARS,
        ),
        pinnedSkills: agent.pinnedSkills,
        mcpServerIds: agent.mcpServerIds,
        capabilityPolicy: agent.capabilityPolicy,
        modelTier: agent.modelTier,
        systemPromptAddition: agent.systemPromptAddition,
      },
      context.architecture ?? undefined,
    );

    try {
      return await runRole(
        getModelForTier(models, agent.modelTier),
        role,
        systemContext,
        prompt,
        runtime,
      );
    } finally {
      await runtime.close();
    }
  };

  const analyzer = await runWithRole("analyzer", prompts.analyzer);
  const architectPrompt = `${prompts.architect}\n\nAnalyzer notes:\n${analyzer}`;
  const architect = await runWithRole("architect", architectPrompt);
  const plannerPrompt = `${prompts.planner}\n\nAnalyzer notes:\n${analyzer}\n\nArchitect notes:\n${architect}`;
  const planner = await runWithRole("planner", plannerPrompt);

  return { analyzer, architect, planner };
}

export async function listGitHubWorkItems(
  projectRoot: string,
  input: ListGitHubWorkItemsInput,
  deps: GitHubWorkItemDeps,
): Promise<{ repoFullName: string; workItems: GitHubWorkItem[] }> {
  const session = await deps.readGitHubSession();
  if (!session?.accessToken) {
    throw new GitHubWorkItemsServiceError(401, "Not connected to GitHub");
  }

  const state = new StateManager(projectRoot);
  const repoFullName = await resolveProjectRepoFullName(projectRoot, state);
  const filters = normalizeListInput(input);
  const linked = await listLinkedIssues(state, repoFullName);

  let issues: GitHubIssueApiResponse[] = [];
  if (filters.q) {
    const query = buildSearchQuery(repoFullName, filters);
    const path = `/search/issues?q=${encodeURIComponent(query)}&per_page=${filters.limit}`;
    const response = await deps.githubApi<GitHubIssueSearchResponse>(path, session.accessToken);
    issues = response.items ?? [];
  } else {
    const params = new URLSearchParams();
    params.set("state", filters.state);
    params.set("per_page", String(filters.limit));
    if (filters.labels.length > 0) params.set("labels", filters.labels.join(","));
    if (filters.assignee) params.set("assignee", filters.assignee);
    if (filters.milestone) params.set("milestone", filters.milestone);

    const path = `/repos/${repoFullName}/issues?${params.toString()}`;
    issues = await deps.githubApi<GitHubIssueApiResponse[]>(path, session.accessToken);
  }

  const normalized = issues
    .map((issue) => {
      const issueNumber = Number(issue.number);
      const linkedTasks = linked.byIssueNumber.get(issueNumber) ?? [];
      return normalizeGitHubIssue(issue, repoFullName, linkedTasks);
    })
    .filter((issue): issue is GitHubWorkItem => !!issue);

  const workItems = filters.unlinkedOnly
    ? normalized.filter((issue) => issue.alreadyLinkedTaskIds.length === 0)
    : normalized;

  return { repoFullName, workItems };
}

export async function extractGitHubWorkItems(
  projectRoot: string,
  input: ExtractGitHubWorkItemsInput,
  deps: GitHubWorkItemDeps,
): Promise<{ repoFullName: string; candidates: ExtractionCandidate[] }> {
  const session = await deps.readGitHubSession();
  if (!session?.accessToken) {
    throw new GitHubWorkItemsServiceError(401, "Not connected to GitHub");
  }

  const state = new StateManager(projectRoot);
  const repoFullName = await resolveProjectRepoFullName(projectRoot, state);
  const { byIssueNumber, taskTitlePool } = await listLinkedIssues(state, repoFullName);
  const selected = parseSelectedWorkItems(input);
  if (selected.length > 25) {
    throw new GitHubWorkItemsServiceError(400, "Select at most 25 work items per extraction run");
  }

  const candidates: ExtractionCandidate[] = [];
  for (const selectedItem of selected) {
    const workItem = await resolveWorkItemWithFallback(selectedItem, repoFullName, deps, session.accessToken);
    const roleOutput = await runRolePipelineForWorkItem(projectRoot, workItem);

    const parsedTasks = parseTaskPlanMarkdown(roleOutput.planner);
    const fallback = fallbackCandidateFromIssue(workItem);
    const usableTasks = parsedTasks.length > 0
      ? parsedTasks.map((task) => ({
        title: task.title,
        description: task.description,
        dependencies: task.dependencies,
        acceptanceCriteria: task.acceptanceCriteria,
        files: task.files,
      }))
      : [{
        title: fallback.title,
        description: fallback.description,
        dependencies: fallback.dependencies,
        acceptanceCriteria: fallback.acceptanceCriteria,
        files: fallback.suggestedFiles,
      }];

    for (let index = 0; index < usableTasks.length; index += 1) {
      const parsed = usableTasks[index];
      const title = parsed.title;
      const description = parsed.description;
      const dependencies = parsed.dependencies;
      const acceptanceCriteria = parsed.acceptanceCriteria;
      const files = parsed.files;

      const warnings: string[] = [];
      const linkedTaskIds = byIssueNumber.get(workItem.issueNumber) ?? workItem.alreadyLinkedTaskIds;
      if (linkedTaskIds.length > 0) {
        warnings.push(`Issue #${workItem.issueNumber} is already linked to task(s): ${linkedTaskIds.join(", ")}`);
      }

      const similar = findSimilarTaskTitle(title, taskTitlePool);
      if (similar) {
        warnings.push(`Similar existing task #${similar.taskId}: ${similar.title}`);
      }

      candidates.push({
        id: stableCandidateId(repoFullName, workItem.issueNumber, index + 1),
        sourceType: "issue",
        sourceIssueNumber: workItem.issueNumber,
        sourceIssueUrl: workItem.url,
        sourceTitle: workItem.title,
        repoFullName,
        title,
        description,
        dependencies,
        acceptanceCriteria,
        suggestedFiles: files,
        rationale: truncateForNotes(roleOutput.analyzer, 1400),
        notes: truncateForNotes(roleOutput.architect, 1400),
        warnings,
      });
    }
  }

  return { repoFullName, candidates };
}

export async function importGitHubWorkItems(
  projectRoot: string,
  input: ImportGitHubWorkItemsInput,
): Promise<{ repoFullName: string; imported: Array<{ candidateId: string; taskId: number; issueNumber: number }> }> {
  const state = new StateManager(projectRoot);
  const repoFullName = await resolveProjectRepoFullName(projectRoot, state);
  const candidates = parseImportCandidates(input);

  const imported: Array<{ candidateId: string; taskId: number; issueNumber: number }> = [];

  for (const candidate of candidates) {
    if (candidate.repoFullName && candidate.repoFullName !== repoFullName) {
      throw new GitHubWorkItemsServiceError(
        400,
        `Candidate ${candidate.id} targets '${candidate.repoFullName}', but current project is linked to '${repoFullName}'`,
      );
    }

    const created = await appendTask(projectRoot, {
      title: candidate.title,
      description: candidate.description,
      files: candidate.suggestedFiles,
    });

    if (candidate.dependencies !== "None" || candidate.acceptanceCriteria !== "Task implemented and tests pass") {
      await patchTask(projectRoot, String(created.taskId), {
        dependencies: candidate.dependencies,
        criteria: candidate.acceptanceCriteria,
      });
    }

    await setTaskLink(projectRoot, String(created.taskId), {
      repoFullName,
      issueNumber: candidate.sourceIssueNumber,
      issueUrl: candidate.sourceIssueUrl,
    });

    imported.push({
      candidateId: candidate.id,
      taskId: created.taskId,
      issueNumber: candidate.sourceIssueNumber,
    });
  }

  return { repoFullName, imported };
}
