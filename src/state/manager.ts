import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBenderDir } from "./config.js";

/**
 * Central state manager for the .bender/ directory.
 * Reads and writes all persistent project state.
 */
export class StateManager {
  private benderDir: string;

  constructor(private projectRoot: string) {
    this.benderDir = getBenderDir(projectRoot);
  }

  get root(): string {
    return this.projectRoot;
  }

  async init(): Promise<void> {
    const dirs = [
      this.benderDir,
      join(this.benderDir, "decisions"),
      join(this.benderDir, "tasks"),
      join(this.benderDir, "tasks", "completed"),
      join(this.benderDir, "api-contracts"),
      join(this.benderDir, "sessions"),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
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
    const dir = join(this.benderDir, "decisions");
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const decisions: { name: string; content: string }[] = [];
    for (const file of files.filter((f: string) => f.endsWith(".md")).sort()) {
      const content = await readFile(join(dir, file), "utf-8");
      decisions.push({ name: file, content });
    }
    return decisions;
  }

  async writeDecision(name: string, content: string): Promise<void> {
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
    return this.readFileOrNull("tasks/current.md");
  }

  async writeCurrentTasks(content: string): Promise<void> {
    await this.writeStateFile("tasks/current.md", content);
  }

  async completeTask(taskId: string, content: string): Promise<void> {
    const dir = join(this.benderDir, "tasks", "completed");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(dir, `${timestamp}-${taskId}.md`), content, "utf-8");
  }

  async readCompletedTasks(): Promise<{ name: string; content: string }[]> {
    const dir = join(this.benderDir, "tasks", "completed");
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const tasks: { name: string; content: string }[] = [];
    for (const file of files.filter((f: string) => f.endsWith(".md")).sort()) {
      const content = await readFile(join(dir, file), "utf-8");
      tasks.push({ name: file, content });
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

  // --- Sessions ---

  async writeSession(operation: string, content: string): Promise<void> {
    const dir = join(this.benderDir, "sessions");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    await writeFile(join(dir, `${timestamp}-${operation}.md`), content, "utf-8");
  }

  async readSessions(): Promise<{ name: string; operation: string; date: string; content: string }[]> {
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
    return sessions;
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
    const fullPath = join(this.benderDir, relativePath);
    if (!existsSync(fullPath)) return null;
    return readFile(fullPath, "utf-8");
  }

  private async writeStateFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.benderDir, relativePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");
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
