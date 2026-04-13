import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ModelTier } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BaseRole = "analyzer" | "architect" | "planner" | "implementer" | "reviewer";

export interface AgentConfig {
  id: string;
  name: string;
  baseRole: BaseRole;
  modelTier: ModelTier;
  pinnedSkills: string[];
  mcpServerIds: string[];
  systemPromptAddition?: string;
  isBuiltin?: boolean;
}

export interface AgentsStore {
  agents?: AgentConfig[];
  selectedByRole?: Partial<Record<BaseRole, string>>;
}

export const MAX_PINNED_SKILLS_PER_AGENT = 6;
export const MAX_MCP_SERVERS_PER_AGENT = 6;

// ── Built-in default agents ───────────────────────────────────────────────────

export const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: "default-analyzer",
    name: "Analyzer",
    baseRole: "analyzer",
    modelTier: "strong",
    pinnedSkills: ["security-best-practices", "security-threat-model"],
    mcpServerIds: ["github", "neon"],
    isBuiltin: true,
  },
  {
    id: "default-architect",
    name: "Architect",
    baseRole: "architect",
    modelTier: "strong",
    pinnedSkills: ["security-best-practices"],
    mcpServerIds: ["github", "figma", "neon", "vercel"],
    isBuiltin: true,
  },
  {
    id: "default-planner",
    name: "Planner",
    baseRole: "planner",
    modelTier: "default",
    pinnedSkills: [],
    mcpServerIds: ["github"],
    isBuiltin: true,
  },
  {
    id: "default-implementer",
    name: "Implementer",
    baseRole: "implementer",
    modelTier: "default",
    pinnedSkills: [],
    mcpServerIds: ["github", "neon", "vercel"],
    isBuiltin: true,
  },
  {
    id: "default-reviewer",
    name: "Reviewer",
    baseRole: "reviewer",
    modelTier: "default",
    pinnedSkills: ["security-best-practices", "security-ownership-map"],
    mcpServerIds: ["github"],
    isBuiltin: true,
  },
];

// ── Storage ───────────────────────────────────────────────────────────────────

function getAgentsPath(): string {
  return join(homedir(), ".bender", "agents.yaml");
}

function getBenderGlobalDir(): string {
  return join(homedir(), ".bender");
}

function isBaseRole(value: string): value is BaseRole {
  return value === "analyzer"
    || value === "architect"
    || value === "planner"
    || value === "implementer"
    || value === "reviewer";
}

async function readAgentsStore(): Promise<AgentsStore> {
  const path = getAgentsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = parseYaml(raw) as Partial<AgentsStore>;
    const selectedRaw = parsed.selectedByRole ?? {};
    const selectedByRole = Object.fromEntries(
      Object.entries(selectedRaw).filter(
        ([role, id]) => isBaseRole(role) && typeof id === "string" && id.trim().length > 0,
      ),
    ) as Partial<Record<BaseRole, string>>;
    return {
      agents: parsed.agents ?? [],
      selectedByRole,
    };
  } catch {
    return {};
  }
}

async function writeAgentsStore(store: AgentsStore): Promise<void> {
  const dir = getBenderGlobalDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(getAgentsPath(), stringifyYaml(store), "utf-8");
}

export async function readCustomAgents(): Promise<AgentConfig[]> {
  const store = await readAgentsStore();
  return (store.agents ?? [])
    .filter((a) => !a.isBuiltin)
    .map((a) => ({
      ...a,
      pinnedSkills: Array.isArray(a.pinnedSkills) ? a.pinnedSkills : [],
      mcpServerIds: Array.isArray(a.mcpServerIds) ? a.mcpServerIds : [],
      isBuiltin: false,
    }));
}

export async function writeCustomAgents(agents: AgentConfig[]): Promise<void> {
  const store = await readAgentsStore();
  await writeAgentsStore({ ...store, agents });
}

/** Returns all agents: builtins first, then custom. */
export async function getAllAgents(): Promise<AgentConfig[]> {
  const custom = await readCustomAgents();
  return [...BUILTIN_AGENTS, ...custom];
}

/** Get the default (builtin) agent for a role. */
export function getDefaultAgentForRole(role: BaseRole): AgentConfig {
  return BUILTIN_AGENTS.find((a) => a.baseRole === role) ?? BUILTIN_AGENTS[3];
}

/** Get agent by ID from the full list. */
export async function getAgentById(id: string): Promise<AgentConfig | null> {
  const all = await getAllAgents();
  return all.find((a) => a.id === id) ?? null;
}

/** Read selected default agent id per role. */
export async function readRoleSelections(): Promise<Partial<Record<BaseRole, string>>> {
  const store = await readAgentsStore();
  return store.selectedByRole ?? {};
}

/** Persist selected default agent for a role (or clear when null). */
export async function writeRoleSelection(role: BaseRole, agentId: string | null): Promise<void> {
  const store = await readAgentsStore();
  const selectedByRole = { ...(store.selectedByRole ?? {}) };
  if (!agentId) {
    delete selectedByRole[role];
  } else {
    selectedByRole[role] = agentId;
  }
  await writeAgentsStore({ ...store, selectedByRole });
}

/**
 * Resolve an effective agent for a role.
 * Priority:
 * 1) preferredAgentId (if provided and valid for role)
 * 2) selected default for role from agents.yaml
 * 3) builtin default agent for role
 */
export async function getEffectiveAgentForRole(
  role: BaseRole,
  preferredAgentId?: string | null,
): Promise<AgentConfig> {
  const all = await getAllAgents();

  if (preferredAgentId) {
    const preferred = all.find((a) => a.id === preferredAgentId && a.baseRole === role);
    if (preferred) return preferred;
  }

  const selected = await readRoleSelections();
  const selectedId = selected[role];
  if (selectedId) {
    const selectedAgent = all.find((a) => a.id === selectedId && a.baseRole === role);
    if (selectedAgent) return selectedAgent;
  }

  return getDefaultAgentForRole(role);
}
