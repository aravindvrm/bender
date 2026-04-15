import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ModelTier } from "./config.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { normalizeCapabilityPolicy } from "./capabilities.js";
import { getBenderHomeDir, getBenderHomePath } from "./paths.js";
import { getRoleDefaultPinnedSkills } from "./role-skill-defaults.js";
import { HomeDb } from "./home-db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BaseRole = "analyzer" | "architect" | "planner" | "implementer" | "reviewer";

export interface AgentConfig {
  id: string;
  name: string;
  baseRole: BaseRole;
  modelTier: ModelTier;
  pinnedSkills: string[];
  /** Legacy connector assignment. Kept for backward compatibility. */
  mcpServerIds: string[];
  /** Capability policy used by runtime resolution and connector access controls. */
  capabilityPolicy?: CapabilityPolicy;
  systemPromptAddition?: string;
  isBuiltin?: boolean;
}

export interface AgentsStore {
  agents?: AgentConfig[];
  selectedByRole?: Partial<Record<BaseRole, string>>;
}

export const MAX_PINNED_SKILLS_PER_AGENT = 6;
export const MAX_MCP_SERVERS_PER_AGENT = 6;
const AGENTS_STORE_DB_KEY = "state.agents.store.v1";

// ── Built-in default agents ───────────────────────────────────────────────────

export const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: "default-analyzer",
    name: "Discovery",
    baseRole: "analyzer",
    modelTier: "strong",
    pinnedSkills: getRoleDefaultPinnedSkills("analyzer"),
    mcpServerIds: ["github", "neon"],
    capabilityPolicy: {
      allow: [
        "connector.github.use",
        "connector.neon.use",
        "github.repo.read",
        "github.issue.read",
        "github.pr.read",
      ],
    },
    isBuiltin: true,
  },
  {
    id: "default-architect",
    name: "Eng Review",
    baseRole: "architect",
    modelTier: "strong",
    pinnedSkills: getRoleDefaultPinnedSkills("architect"),
    mcpServerIds: ["github", "figma", "neon", "vercel"],
    capabilityPolicy: {
      allow: [
        "connector.github.use",
        "connector.figma.use",
        "connector.neon.use",
        "connector.vercel.use",
        "github.repo.read",
        "github.issue.read",
        "github.pr.read",
      ],
    },
    isBuiltin: true,
  },
  {
    id: "default-planner",
    name: "Execution Plan",
    baseRole: "planner",
    modelTier: "default",
    pinnedSkills: getRoleDefaultPinnedSkills("planner"),
    mcpServerIds: ["github"],
    capabilityPolicy: {
      allow: ["connector.github.use", "github.repo.read", "github.issue.read", "github.pr.read"],
    },
    isBuiltin: true,
  },
  {
    id: "default-office-hours",
    name: "Office Hours",
    baseRole: "planner",
    modelTier: "strong",
    pinnedSkills: [
      ...getRoleDefaultPinnedSkills("planner"),
      "notion-research-documentation",
    ],
    mcpServerIds: ["github"],
    capabilityPolicy: {
      allow: ["connector.github.use", "github.repo.read", "github.issue.read", "github.pr.read"],
    },
    systemPromptAddition: [
      "Act in office-hours mode for upstream feature pressure-testing.",
      "Force specificity on target user, status-quo workaround, and why this matters now.",
      "Prioritize MVP scope discipline; explicitly call out what to cut and hidden complexity traps.",
      "End recommendations with a clear verdict: ship now, simplify first, validate first, defer, or kill.",
    ].join("\n"),
    isBuiltin: true,
  },
  {
    id: "default-implementer",
    name: "Implement",
    baseRole: "implementer",
    modelTier: "default",
    pinnedSkills: getRoleDefaultPinnedSkills("implementer"),
    mcpServerIds: ["github", "neon", "vercel"],
    capabilityPolicy: {
      allow: [
        "connector.github.use",
        "connector.neon.use",
        "connector.vercel.use",
        "github.repo.read",
        "github.repo.write",
        "github.branch.manage",
        "github.clone",
      ],
    },
    isBuiltin: true,
  },
  {
    id: "default-reviewer",
    name: "Review",
    baseRole: "reviewer",
    modelTier: "default",
    pinnedSkills: getRoleDefaultPinnedSkills("reviewer"),
    mcpServerIds: ["github"],
    capabilityPolicy: {
      allow: [
        "connector.github.use",
        "github.repo.read",
        "github.issue.read",
        "github.pr.read",
        "github.pr.comment",
      ],
    },
    isBuiltin: true,
  },
];

// ── Storage ───────────────────────────────────────────────────────────────────

function getAgentsPath(): string {
  return getBenderHomePath("agents.yaml");
}

function getBenderGlobalDir(): string {
  return getBenderHomeDir();
}

function isBaseRole(value: string): value is BaseRole {
  return value === "analyzer"
    || value === "architect"
    || value === "planner"
    || value === "implementer"
    || value === "reviewer";
}

async function readAgentsStore(): Promise<AgentsStore> {
  const db = HomeDb.current();
  await db.init();
  const fromDb = db.getJson<AgentsStore>(AGENTS_STORE_DB_KEY);
  if (fromDb && typeof fromDb === "object") {
    return sanitizeAgentsStore(fromDb);
  }

  const path = getAgentsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = parseYaml(raw) as Partial<AgentsStore>;
    const sanitized = sanitizeAgentsStore(parsed);
    db.setJson(AGENTS_STORE_DB_KEY, sanitized);
    return sanitized;
  } catch {
    return {};
  }
}

async function writeAgentsStore(store: AgentsStore): Promise<void> {
  const db = HomeDb.current();
  await db.init();
  const sanitized = sanitizeAgentsStore(store);
  db.setJson(AGENTS_STORE_DB_KEY, sanitized);

  const dir = getBenderGlobalDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(getAgentsPath(), stringifyYaml(sanitized), "utf-8");
}

function sanitizeAgentsStore(input: Partial<AgentsStore>): AgentsStore {
  const selectedRaw = input.selectedByRole ?? {};
  const selectedByRole = Object.fromEntries(
    Object.entries(selectedRaw).filter(
      ([role, id]) => isBaseRole(role) && typeof id === "string" && id.trim().length > 0,
    ),
  ) as Partial<Record<BaseRole, string>>;
  return {
    agents: Array.isArray(input.agents) ? input.agents : [],
    selectedByRole,
  };
}

export async function readCustomAgents(): Promise<AgentConfig[]> {
  const store = await readAgentsStore();
  return (store.agents ?? [])
    .filter((a) => !a.isBuiltin)
    .map((a) => ({
      ...a,
      pinnedSkills: Array.isArray(a.pinnedSkills) ? a.pinnedSkills : [],
      mcpServerIds: Array.isArray(a.mcpServerIds) ? a.mcpServerIds : [],
      capabilityPolicy: normalizeCapabilityPolicy(a.capabilityPolicy),
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
