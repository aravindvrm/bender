import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBenderDir } from "./config.js";
import { ensureBenderGitignored } from "./gitignore.js";
import { LocalProjectDb } from "./local-db.js";
import {
  normalizeCanonicalTaskPlan,
  renderTaskPlanMarkdown,
  toCanonicalTaskPlan,
  type CanonicalTaskPlanDocument,
} from "./task-plan.js";
import type { WorkflowDefinition, WorkflowRun } from "../workflows/types.js";

function nowTs(): number {
  return Date.now();
}

/**
 * Central state manager for the .bender/ directory.
 * Reads and writes all persistent project state.
 */
export class StateManager {
  private benderDir: string;
  private db: LocalProjectDb;

  private static readonly DECISION_NS = "state.decision";
  private static readonly COMPLETED_TASK_NS = "state.completed_task";
  private static readonly SESSION_NS = "state.session";

  constructor(private projectRoot: string) {
    this.benderDir = getBenderDir(projectRoot);
    this.db = LocalProjectDb.forProject(projectRoot);
  }

  get root(): string {
    return this.projectRoot;
  }

  async init(): Promise<void> {
    await this.db.init();
    const dirs = [
      this.benderDir,
      join(this.benderDir, "decisions"),
      join(this.benderDir, "tasks"),
      join(this.benderDir, "tasks", "completed"),
      join(this.benderDir, "api-contracts"),
      join(this.benderDir, "sessions"),
      join(this.benderDir, "workflows"),
      join(this.benderDir, "workflow-runs"),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
    await ensureBenderGitignored(this.projectRoot);
  }

  isInitialized(): boolean {
    return existsSync(this.benderDir);
  }

  // --- Brief ---

  async readBrief(): Promise<string | null> {
    return this.readFileOrNull("brief.md");
  }

  async writeBrief(content: string): Promise<void> {
    await this.writeStateFile("brief.md", content);
  }

  // --- Architecture ---

  async readArchitecture(): Promise<string | null> {
    return this.readFileOrNull("architecture.md");
  }

  async writeArchitecture(content: string): Promise<void> {
    await this.writeStateFile("architecture.md", content);
  }

  // --- Conventions ---

  async readConventions(): Promise<string | null> {
    return this.readFileOrNull("conventions.md");
  }

  async writeConventions(content: string): Promise<void> {
    await this.writeStateFile("conventions.md", content);
  }

  // --- Schema ---

  async readSchema(): Promise<string | null> {
    return this.readFileOrNull("schema.sql");
  }

  async writeSchema(content: string): Promise<void> {
    await this.writeStateFile("schema.sql", content);
  }

  // --- Decisions (ADRs) ---

  async readDecisions(): Promise<{ name: string; content: string }[]> {
    await this.db.init();
    const fromDb = this.db.listRecords<{ name?: string; content?: string }>(
      StateManager.DECISION_NS,
      { limit: 10_000, orderBy: "updated_at", desc: false },
    );
    if (fromDb.length > 0) {
      return fromDb
        .filter((d) => typeof d.name === "string" && typeof d.content === "string")
        .map((d) => ({ name: String(d.name), content: String(d.content) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    const dir = join(this.benderDir, "decisions");
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const decisions: { name: string; content: string }[] = [];
    for (const file of files.filter((f: string) => f.endsWith(".md")).sort()) {
      const content = await readFile(join(dir, file), "utf-8");
      decisions.push({ name: file, content });
    }
    if (decisions.length > 0) {
      this.db.transaction(() => {
        for (const decision of decisions) {
          this.db.upsertRecord(StateManager.DECISION_NS, decision.name, decision, {
            updatedAt: nowTs(),
          });
        }
      });
    }
    return decisions;
  }

  async writeDecision(name: string, content: string): Promise<void> {
    await this.db.init();
    this.db.upsertRecord(StateManager.DECISION_NS, name, { name, content }, {
      updatedAt: nowTs(),
    });
    const dir = join(this.benderDir, "decisions");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content, "utf-8");
  }

  async nextDecisionNumber(): Promise<number> {
    const decisions = await this.readDecisions();
    if (decisions.length === 0) return 1;
    const numbers = decisions.map((d) => {
      const match = d.name.match(/^(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    });
    return Math.max(...numbers) + 1;
  }

  // --- Tasks ---

  async readCurrentTasks(): Promise<string | null> {
    const jsonRaw = await this.readFileOrNull("tasks/current.json");
    if (jsonRaw) {
      try {
        const parsed = normalizeCanonicalTaskPlan(JSON.parse(jsonRaw));
        if (parsed) {
          const markdown = renderTaskPlanMarkdown(parsed.tasks);
          return markdown.length > 0 ? markdown : null;
        }
      } catch {
        // fall back to markdown migration path
      }
    }

    const markdown = await this.readFileOrNull("tasks/current.md");
    if (!markdown) return null;

    // Migration path: current.md -> current.json (canonical)
    const canonical = toCanonicalTaskPlan(markdown);
    await this.writeCurrentTaskPlan(canonical);
    return markdown;
  }

  async writeCurrentTasks(content: string): Promise<void> {
    const canonical = toCanonicalTaskPlan(content ?? "");
    await this.writeCurrentTaskPlan(canonical);
  }

  async readCurrentTaskPlan(): Promise<CanonicalTaskPlanDocument | null> {
    const jsonRaw = await this.readFileOrNull("tasks/current.json");
    if (jsonRaw) {
      try {
        const parsed = normalizeCanonicalTaskPlan(JSON.parse(jsonRaw));
        if (parsed) return parsed;
      } catch {
        // fall back to markdown migration path
      }
    }

    const markdown = await this.readFileOrNull("tasks/current.md");
    if (!markdown) return null;
    const canonical = toCanonicalTaskPlan(markdown);
    await this.writeCurrentTaskPlan(canonical);
    return canonical;
  }

  async writeCurrentTaskPlan(plan: CanonicalTaskPlanDocument): Promise<void> {
    const normalized = normalizeCanonicalTaskPlan(plan) ?? { version: 1 as const, generatedAt: new Date().toISOString(), tasks: [] };
    await this.writeStateFile("tasks/current.json", JSON.stringify(normalized, null, 2));
    await this.writeStateFile("tasks/current.md", renderTaskPlanMarkdown(normalized.tasks));
  }

  async completeTask(taskId: string, content: string): Promise<void> {
    await this.db.init();
    const dir = join(this.benderDir, "tasks", "completed");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${timestamp}-${taskId}.md`;
    this.db.upsertRecord(StateManager.COMPLETED_TASK_NS, fileName, {
      name: fileName,
      content,
    }, {
      updatedAt: nowTs(),
    });
    await writeFile(join(dir, fileName), content, "utf-8");
  }

  async readCompletedTasks(): Promise<{ name: string; content: string }[]> {
    await this.db.init();
    const fromDb = this.db.listRecords<{ name?: string; content?: string }>(
      StateManager.COMPLETED_TASK_NS,
      { limit: 10_000, orderBy: "created_at", desc: false },
    );
    if (fromDb.length > 0) {
      return fromDb
        .filter((task) => typeof task.name === "string" && typeof task.content === "string")
        .map((task) => ({ name: String(task.name), content: String(task.content) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    const dir = join(this.benderDir, "tasks", "completed");
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const tasks: { name: string; content: string }[] = [];
    for (const file of files.filter((f: string) => f.endsWith(".md")).sort()) {
      const content = await readFile(join(dir, file), "utf-8");
      tasks.push({ name: file, content });
    }
    if (tasks.length > 0) {
      this.db.transaction(() => {
        for (const task of tasks) {
          this.db.upsertRecord(StateManager.COMPLETED_TASK_NS, task.name, task, {
            updatedAt: nowTs(),
          });
        }
      });
    }
    return tasks;
  }

  // --- Task Agent Assignments ---

  async readTaskAgents(): Promise<Record<string, string>> {
    const raw = await this.readFileOrNull("tasks/agents.json");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [taskId, agentId] of Object.entries(parsed)) {
        if (typeof taskId === "string" && typeof agentId === "string" && taskId.trim() && agentId.trim()) {
          result[taskId] = agentId;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  async writeTaskAgents(assignments: Record<string, string>): Promise<void> {
    await this.writeStateFile("tasks/agents.json", JSON.stringify(assignments, null, 2));
  }

  async setTaskAgent(taskId: string, agentId: string | null): Promise<void> {
    const current = await this.readTaskAgents();
    if (!agentId) {
      delete current[taskId];
    } else {
      current[taskId] = agentId;
    }
    await this.writeTaskAgents(current);
  }

  // --- Task GitHub Links ---

  async readTaskGitHubLinks(): Promise<Record<string, TaskGitHubLink>> {
    const raw = await this.readFileOrNull("tasks/github-links.json");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const result: Record<string, TaskGitHubLink> = {};
      for (const [taskId, value] of Object.entries(parsed)) {
        if (!taskId.trim() || typeof value !== "object" || !value) continue;
        const link = normalizeTaskGitHubLink(value);
        if (link) result[taskId] = link;
      }
      return result;
    } catch {
      return {};
    }
  }

  async writeTaskGitHubLinks(links: Record<string, TaskGitHubLink>): Promise<void> {
    await this.writeStateFile("tasks/github-links.json", JSON.stringify(links, null, 2));
  }

  async getTaskGitHubLink(taskId: string): Promise<TaskGitHubLink | null> {
    const links = await this.readTaskGitHubLinks();
    return links[taskId] ?? null;
  }

  async setTaskGitHubLink(taskId: string, link: Partial<TaskGitHubLink> | null): Promise<void> {
    const links = await this.readTaskGitHubLinks();
    if (!link) {
      delete links[taskId];
      await this.writeTaskGitHubLinks(links);
      return;
    }
    const current = links[taskId] ?? {};
    const next = normalizeTaskGitHubLink({
      ...current,
      ...link,
    });
    if (!next) {
      delete links[taskId];
    } else {
      links[taskId] = next;
    }
    await this.writeTaskGitHubLinks(links);
  }

  // --- Reanalyze counter ---

  async readReanalyzeCounter(): Promise<number> {
    const raw = await this.readFileOrNull("tasks/reanalyze-counter.json");
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw) as { count?: unknown };
      return typeof parsed.count === "number" ? parsed.count : 0;
    } catch {
      return 0;
    }
  }

  async incrementReanalyzeCounter(): Promise<number> {
    const current = await this.readReanalyzeCounter();
    const next = current + 1;
    await this.writeStateFile("tasks/reanalyze-counter.json", JSON.stringify({ count: next }));
    return next;
  }

  async resetReanalyzeCounter(): Promise<void> {
    await this.writeStateFile("tasks/reanalyze-counter.json", JSON.stringify({ count: 0 }));
  }

  // --- Sessions ---

  async writeSession(operation: string, content: string): Promise<void> {
    await this.db.init();
    const dir = join(this.benderDir, "sessions");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `${timestamp}-${operation}.md`;
    this.db.upsertRecord(StateManager.SESSION_NS, fileName, {
      name: fileName,
      operation,
      date: timestamp.slice(0, 10),
      content,
    }, {
      updatedAt: nowTs(),
    });
    await writeFile(join(dir, fileName), content, "utf-8");
  }

  async readSessions(): Promise<{ name: string; operation: string; date: string; content: string }[]> {
    await this.db.init();
    const fromDb = this.db.listRecords<{ name?: string; operation?: string; date?: string; content?: string }>(
      StateManager.SESSION_NS,
      { limit: 20_000, orderBy: "created_at", desc: true },
    );
    if (fromDb.length > 0) {
      return fromDb
        .filter((session) => typeof session.name === "string" && typeof session.content === "string")
        .map((session) => ({
          name: String(session.name),
          operation: typeof session.operation === "string" ? session.operation : "unknown",
          date: typeof session.date === "string" ? session.date : "",
          content: String(session.content),
        }))
        .sort((a, b) => b.name.localeCompare(a.name));
    }

    const dir = join(this.benderDir, "sessions");
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const sessions: { name: string; operation: string; date: string; content: string }[] = [];
    for (const file of files.filter((f: string) => f.endsWith(".md")).sort().reverse()) {
      const content = await readFile(join(dir, file), "utf-8");
      // filename format: 2026-04-12T10-30-00-init.md
      const parts = file.replace(".md", "").split("-");
      const operation = parts[parts.length - 1];
      const date = parts.slice(0, 3).join("-");
      sessions.push({ name: file, operation, date, content });
    }
    if (sessions.length > 0) {
      this.db.transaction(() => {
        for (const session of sessions) {
          this.db.upsertRecord(StateManager.SESSION_NS, session.name, session, {
            updatedAt: nowTs(),
          });
        }
      });
    }
    return sessions;
  }

  // --- Workflows ---

  async readWorkflows(): Promise<WorkflowDefinition[]> {
    const files = await this.listStateJsonFiles("workflows");
    const workflows: WorkflowDefinition[] = [];
    for (const file of files) {
      const id = file.replace(/\.json$/i, "");
      const item = await this.readWorkflow(id);
      if (item) workflows.push(item);
    }
    return workflows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  async readWorkflow(id: string): Promise<WorkflowDefinition | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const raw = await this.readFileOrNull(`workflows/${normalizedId}.json`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return normalizeWorkflowDefinition(parsed);
    } catch {
      return null;
    }
  }

  async writeWorkflow(def: WorkflowDefinition): Promise<void> {
    const normalized = normalizeWorkflowDefinition(def);
    if (!normalized) {
      throw new Error("Invalid workflow definition payload");
    }
    await this.writeStateFile(`workflows/${normalized.id}.json`, JSON.stringify(normalized, null, 2));
  }

  async deleteWorkflow(id: string): Promise<void> {
    const normalizedId = id.trim();
    if (!normalizedId) return;
    await this.deleteStateFile(`workflows/${normalizedId}.json`);
  }

  async readWorkflowRuns(workflowId?: string): Promise<WorkflowRun[]> {
    const files = await this.listStateJsonFiles("workflow-runs");
    const runs: WorkflowRun[] = [];
    const filterId = workflowId?.trim();
    for (const file of files) {
      const id = file.replace(/\.json$/i, "");
      const item = await this.readWorkflowRun(id);
      if (!item) continue;
      if (filterId && item.workflowId !== filterId) continue;
      runs.push(item);
    }
    return runs.sort((a, b) => {
      const aTs = a.finishedAt ?? a.startedAt;
      const bTs = b.finishedAt ?? b.startedAt;
      return bTs - aTs;
    });
  }

  async readWorkflowRun(runId: string): Promise<WorkflowRun | null> {
    const normalizedId = runId.trim();
    if (!normalizedId) return null;
    const raw = await this.readFileOrNull(`workflow-runs/${normalizedId}.json`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return normalizeWorkflowRun(parsed);
    } catch {
      return null;
    }
  }

  async writeWorkflowRun(run: WorkflowRun): Promise<void> {
    const normalized = normalizeWorkflowRun(run);
    if (!normalized) {
      throw new Error("Invalid workflow run payload");
    }
    await this.writeStateFile(`workflow-runs/${normalized.id}.json`, JSON.stringify(normalized, null, 2));
  }

  // --- Flows ---

  async readFlows(): Promise<string | null> {
    return this.readFileOrNull("flows.md");
  }

  async writeFlows(content: string): Promise<void> {
    await this.writeStateFile("flows.md", content);
  }

  // --- Audits ---

  async readAudit(type: "security" | "tests"): Promise<AuditResult | null> {
    const raw = await this.readFileOrNull(`audits/${type}.json`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuditResult;
    } catch {
      return null;
    }
  }

  async writeAudit(type: "security" | "tests", result: AuditResult): Promise<void> {
    await this.writeStateFile(`audits/${type}.json`, JSON.stringify(result, null, 2));
  }

  // --- API Contracts ---

  async readApiContracts(): Promise<string | null> {
    return this.readFileOrNull("api-contracts/routes.yaml");
  }

  async writeApiContracts(content: string): Promise<void> {
    await this.writeStateFile("api-contracts/routes.yaml", content);
  }

  // --- Gather all project context for LLM prompts ---

  async gatherContext(): Promise<ProjectContext> {
    const [brief, architecture, conventions, schema, decisions, currentTasks, apiContracts] = await Promise.all([
      this.readBrief(),
      this.readArchitecture(),
      this.readConventions(),
      this.readSchema(),
      this.readDecisions(),
      this.readCurrentTasks(),
      this.readApiContracts(),
    ]);

    return {
      brief,
      architecture,
      conventions,
      schema,
      decisions: decisions.map((d) => d.content),
      currentTasks,
      apiContracts,
    };
  }

  // --- Helpers ---

  private async readFileOrNull(relativePath: string): Promise<string | null> {
    await this.db.init();
    const key = this.stateFileKey(relativePath);
    const fromDb = this.db.getKv(key);
    if (fromDb !== null) return fromDb;

    const fullPath = join(this.benderDir, relativePath);
    if (!existsSync(fullPath)) return null;
    const fromFile = await readFile(fullPath, "utf-8");
    this.db.setKv(key, fromFile);
    return fromFile;
  }

  private async writeStateFile(relativePath: string, content: string): Promise<void> {
    await this.db.init();
    this.db.setKv(this.stateFileKey(relativePath), content);
    const fullPath = join(this.benderDir, relativePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  private async deleteStateFile(relativePath: string): Promise<void> {
    await this.db.init();
    this.db.deleteKv(this.stateFileKey(relativePath));
    const fullPath = join(this.benderDir, relativePath);
    if (!existsSync(fullPath)) return;
    const { rm } = await import("node:fs/promises");
    await rm(fullPath, { force: true });
  }

  private async listStateJsonFiles(relativeDir: string): Promise<string[]> {
    const fullDir = join(this.benderDir, relativeDir);
    if (!existsSync(fullDir)) return [];
    const entries = await readdir(fullDir);
    return entries
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  }

  private stateFileKey(relativePath: string): string {
    return `state-file:${relativePath}`;
  }
}

export interface AuditIssue {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  description: string;
  recommendation: string;
  files?: string[];
}

export interface AuditResult {
  type: "security" | "tests";
  runAt: number;
  summary: string;
  coverageEstimate?: string; // tests audit only
  issues: AuditIssue[];
}

export interface ProjectContext {
  brief: string | null;
  architecture: string | null;
  conventions: string | null;
  schema: string | null;
  decisions: string[];
  currentTasks: string | null;
  apiContracts: string | null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item);
    if (normalized) out.push(normalized);
  }
  return [...new Set(out)];
}

function normalizeWorkflowDefinition(input: unknown): WorkflowDefinition | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const id = normalizeString(obj.id);
  const name = normalizeString(obj.name);
  if (!id || !name) return null;
  if (!Array.isArray(obj.steps)) return null;

  const steps = obj.steps
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const step = value as Record<string, unknown>;
      const stepId = normalizeString(step.id);
      const stepName = normalizeString(step.name);
      const stepType = normalizeString(step.type);
      if (!stepId || !stepName) return null;
      if (
        stepType !== "prompt"
        && stepType !== "action"
        && stepType !== "condition"
        && stepType !== "extract"
        && stepType !== "response"
      ) {
        return null;
      }
      const config = step.config && typeof step.config === "object" && !Array.isArray(step.config)
        ? { ...(step.config as Record<string, unknown>) }
        : {};
      return {
        id: stepId,
        type: stepType,
        name: stepName,
        config,
      };
    })
    .filter((step): step is WorkflowDefinition["steps"][number] => !!step);

  if (steps.length === 0) return null;

  const createdAt = typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt)
    ? Math.floor(obj.createdAt)
    : nowTs();
  const updatedAt = typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt)
    ? Math.floor(obj.updatedAt)
    : createdAt;
  const version = typeof obj.version === "number" && Number.isFinite(obj.version) && obj.version > 0
    ? Math.floor(obj.version)
    : 1;
  const acceptanceCriteria = normalizeStringArray(obj.acceptanceCriteria);
  const description = normalizeString(obj.description);

  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    version,
    enabled: obj.enabled !== false,
    ...(obj.inputSchema && typeof obj.inputSchema === "object" && !Array.isArray(obj.inputSchema)
      ? { inputSchema: { ...(obj.inputSchema as Record<string, unknown>) } }
      : {}),
    ...(obj.outputSchema && typeof obj.outputSchema === "object" && !Array.isArray(obj.outputSchema)
      ? { outputSchema: { ...(obj.outputSchema as Record<string, unknown>) } }
      : {}),
    steps,
    createdAt,
    updatedAt,
  };
}

function normalizeWorkflowRun(input: unknown): WorkflowRun | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const id = normalizeString(obj.id);
  const workflowId = normalizeString(obj.workflowId);
  const status = normalizeString(obj.status);
  if (!id || !workflowId) return null;
  if (status !== "queued" && status !== "running" && status !== "completed" && status !== "failed") {
    return null;
  }

  const startedAt = typeof obj.startedAt === "number" && Number.isFinite(obj.startedAt)
    ? Math.floor(obj.startedAt)
    : nowTs();
  const finishedAt = typeof obj.finishedAt === "number" && Number.isFinite(obj.finishedAt)
    ? Math.floor(obj.finishedAt)
    : undefined;
  const inputPayload = obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)
    ? { ...(obj.input as Record<string, unknown>) }
    : {};
  const outputPayload = obj.output && typeof obj.output === "object" && !Array.isArray(obj.output)
    ? { ...(obj.output as Record<string, unknown>) }
    : undefined;
  const error = normalizeString(obj.error) || undefined;

  const stepsRaw = Array.isArray(obj.steps) ? obj.steps : [];
  const steps = stepsRaw
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const step = value as Record<string, unknown>;
      const stepId = normalizeString(step.stepId);
      const stepType = normalizeString(step.type);
      const stepStatus = normalizeString(step.status);
      if (!stepId) return null;
      if (
        stepType !== "prompt"
        && stepType !== "action"
        && stepType !== "condition"
        && stepType !== "extract"
        && stepType !== "response"
      ) {
        return null;
      }
      if (
        stepStatus !== "running"
        && stepStatus !== "completed"
        && stepStatus !== "failed"
        && stepStatus !== "skipped"
      ) {
        return null;
      }
      const stepStartedAt = typeof step.startedAt === "number" && Number.isFinite(step.startedAt)
        ? Math.floor(step.startedAt)
        : startedAt;
      const stepFinishedAt = typeof step.finishedAt === "number" && Number.isFinite(step.finishedAt)
        ? Math.floor(step.finishedAt)
        : undefined;
      const stepInput = step.input && typeof step.input === "object" && !Array.isArray(step.input)
        ? { ...(step.input as Record<string, unknown>) }
        : undefined;
      const stepOutput = step.output && typeof step.output === "object" && !Array.isArray(step.output)
        ? { ...(step.output as Record<string, unknown>) }
        : undefined;
      const stepError = normalizeString(step.error) || undefined;

      return {
        stepId,
        type: stepType,
        status: stepStatus,
        ...(stepInput ? { input: stepInput } : {}),
        ...(stepOutput ? { output: stepOutput } : {}),
        ...(stepError ? { error: stepError } : {}),
        startedAt: stepStartedAt,
        ...(stepFinishedAt !== undefined ? { finishedAt: stepFinishedAt } : {}),
      };
    })
    .filter((step): step is WorkflowRun["steps"][number] => !!step);

  return {
    id,
    workflowId,
    status,
    input: inputPayload,
    ...(outputPayload ? { output: outputPayload } : {}),
    ...(error ? { error } : {}),
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    steps,
  };
}

function normalizeTaskGitHubLink(input: unknown): TaskGitHubLink | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  const repoFullName = typeof obj.repoFullName === "string" && obj.repoFullName.trim() ? obj.repoFullName.trim() : undefined;
  const issueNumber = typeof obj.issueNumber === "number" && Number.isFinite(obj.issueNumber) ? obj.issueNumber : undefined;
  const issueUrl = typeof obj.issueUrl === "string" && obj.issueUrl.trim() ? obj.issueUrl.trim() : undefined;
  const branchName = typeof obj.branchName === "string" && obj.branchName.trim() ? obj.branchName.trim() : undefined;
  const prNumber = typeof obj.prNumber === "number" && Number.isFinite(obj.prNumber) ? obj.prNumber : undefined;
  const prUrl = typeof obj.prUrl === "string" && obj.prUrl.trim() ? obj.prUrl.trim() : undefined;
  const lastSyncedAt = typeof obj.lastSyncedAt === "number" && Number.isFinite(obj.lastSyncedAt) ? obj.lastSyncedAt : undefined;

  const out: TaskGitHubLink = {};
  if (repoFullName) out.repoFullName = repoFullName;
  if (issueNumber !== undefined) out.issueNumber = issueNumber;
  if (issueUrl) out.issueUrl = issueUrl;
  if (branchName) out.branchName = branchName;
  if (prNumber !== undefined) out.prNumber = prNumber;
  if (prUrl) out.prUrl = prUrl;
  if (lastSyncedAt !== undefined) out.lastSyncedAt = lastSyncedAt;

  return Object.keys(out).length > 0 ? out : null;
}

export interface TaskGitHubLink {
  repoFullName?: string;
  issueNumber?: number;
  issueUrl?: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  lastSyncedAt?: number;
}

/**
 * Format project context into a string suitable for LLM system prompts.
 */
export function formatContextForPrompt(ctx: ProjectContext): string {
  const sections: string[] = [];

  if (ctx.brief) {
    sections.push(`## Product Brief\n\n${ctx.brief}`);
  }
  if (ctx.architecture) {
    sections.push(`## Architecture\n\n${ctx.architecture}`);
  }
  if (ctx.conventions) {
    sections.push(`## Coding Conventions\n\n${ctx.conventions}`);
  }
  if (ctx.schema) {
    sections.push(`## Database Schema\n\n\`\`\`sql\n${ctx.schema}\n\`\`\``);
  }
  if (ctx.decisions.length > 0) {
    sections.push(`## Architecture Decisions\n\n${ctx.decisions.join("\n\n---\n\n")}`);
  }
  if (ctx.apiContracts) {
    sections.push(`## API Contracts\n\n\`\`\`yaml\n${ctx.apiContracts}\n\`\`\``);
  }
  if (ctx.currentTasks) {
    sections.push(`## Current Task Plan\n\n${ctx.currentTasks}`);
  }

  if (sections.length === 0) {
    return "No project context available. This is a new project.";
  }

  return `# Project Context\n\n${sections.join("\n\n---\n\n")}`;
}
