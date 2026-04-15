import {
  getAllAgents,
  readCustomAgents,
  writeCustomAgents,
  readRoleSelections,
  writeRoleSelection,
  BUILTIN_AGENTS,
  MAX_MCP_SERVERS_PER_AGENT,
  MAX_PINNED_SKILLS_PER_AGENT,
  type AgentConfig,
  type BaseRole,
} from "../../state/agents.js";
import { normalizeCapabilityPolicy } from "../../state/capabilities.js";
import { loadPrompt } from "../../roles/base.js";

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS = ["fast", "default", "strong"] as const;
const MAX_AGENT_NAME_CHARS = 80;
const MAX_SYSTEM_PROMPT_ADDITION_CHARS = 4000;

export class AgentsServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isBaseRole(value: string): value is BaseRole {
  return BASE_ROLES.includes(value as BaseRole);
}

function isModelTier(value: string): value is (typeof MODEL_TIERS)[number] {
  return MODEL_TIERS.includes(value as (typeof MODEL_TIERS)[number]);
}

function normalizePinnedSkills(
  input: unknown,
): { value?: string[]; error?: string } {
  if (input === undefined) return { value: undefined };
  if (!Array.isArray(input)) return { error: "pinnedSkills must be an array of skill names" };
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const skill = item.trim();
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }
  if (skills.length > MAX_PINNED_SKILLS_PER_AGENT) {
    return { error: `pinnedSkills cannot exceed ${MAX_PINNED_SKILLS_PER_AGENT} items` };
  }
  return { value: skills };
}

function normalizeMcpServerIds(
  input: unknown,
): { value?: string[]; error?: string } {
  if (input === undefined) return { value: undefined };
  if (!Array.isArray(input)) return { error: "mcpServerIds must be an array of connector IDs" };
  const allowed = new Set(["github", "figma", "neon", "vercel"]);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_MCP_SERVERS_PER_AGENT) {
    return { error: `mcpServerIds cannot exceed ${MAX_MCP_SERVERS_PER_AGENT} items` };
  }
  return { value: ids };
}

function normalizeSystemPromptAddition(
  input: unknown,
): { value?: string; error?: string } {
  if (input === undefined || input === null) return { value: undefined };
  if (typeof input !== "string") {
    return { error: "systemPromptAddition must be a string" };
  }
  const trimmed = input.trim();
  if (!trimmed) return { value: undefined };
  if (trimmed.length > MAX_SYSTEM_PROMPT_ADDITION_CHARS) {
    return { error: `systemPromptAddition cannot exceed ${MAX_SYSTEM_PROMPT_ADDITION_CHARS} characters` };
  }
  return { value: trimmed };
}

function normalizeAgentCreatePayload(
  input: Partial<AgentConfig>,
): { value?: AgentConfig; error?: string } {
  const id = input.id?.trim();
  const name = input.name?.trim();
  const baseRole = input.baseRole;
  if (!id || !name || !baseRole) {
    return { error: "Missing required fields: id, name, baseRole" };
  }
  if (name.length > MAX_AGENT_NAME_CHARS) {
    return { error: `name cannot exceed ${MAX_AGENT_NAME_CHARS} characters` };
  }
  if (!isBaseRole(baseRole)) {
    return { error: `Invalid baseRole: ${baseRole}` };
  }
  const modelTierRaw = input.modelTier ?? "default";
  if (!isModelTier(modelTierRaw)) {
    return { error: `Invalid modelTier: ${String(modelTierRaw)}` };
  }
  const normalizedSkills = normalizePinnedSkills(input.pinnedSkills ?? []);
  if (normalizedSkills.error) return { error: normalizedSkills.error };
  const normalizedMcpServers = normalizeMcpServerIds(input.mcpServerIds ?? []);
  if (normalizedMcpServers.error) return { error: normalizedMcpServers.error };
  const normalizedPrompt = normalizeSystemPromptAddition(input.systemPromptAddition);
  if (normalizedPrompt.error) return { error: normalizedPrompt.error };
  const normalizedCapabilityPolicy = normalizeCapabilityPolicy(input.capabilityPolicy);

  return {
    value: {
      id,
      name,
      baseRole,
      modelTier: modelTierRaw,
      pinnedSkills: normalizedSkills.value ?? [],
      mcpServerIds: normalizedMcpServers.value ?? [],
      ...(normalizedCapabilityPolicy ? { capabilityPolicy: normalizedCapabilityPolicy } : {}),
      systemPromptAddition: normalizedPrompt.value,
      isBuiltin: false,
    },
  };
}

function normalizeAgentPatchPayload(
  current: AgentConfig,
  input: Partial<AgentConfig>,
): { value?: AgentConfig; error?: string } {
  const next: AgentConfig = { ...current, isBuiltin: false };

  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { error: "name must be a non-empty string" };
    }
    const trimmed = input.name.trim();
    if (trimmed.length > MAX_AGENT_NAME_CHARS) {
      return { error: `name cannot exceed ${MAX_AGENT_NAME_CHARS} characters` };
    }
    next.name = trimmed;
  }

  if (input.baseRole !== undefined) {
    if (!isBaseRole(input.baseRole)) {
      return { error: `Invalid baseRole: ${input.baseRole}` };
    }
    next.baseRole = input.baseRole;
  }

  if (input.modelTier !== undefined) {
    if (!isModelTier(input.modelTier)) {
      return { error: `Invalid modelTier: ${String(input.modelTier)}` };
    }
    next.modelTier = input.modelTier;
  }

  if (input.pinnedSkills !== undefined) {
    const normalizedSkills = normalizePinnedSkills(input.pinnedSkills);
    if (normalizedSkills.error) return { error: normalizedSkills.error };
    next.pinnedSkills = normalizedSkills.value ?? [];
  }

  if (input.mcpServerIds !== undefined) {
    const normalizedMcpServers = normalizeMcpServerIds(input.mcpServerIds);
    if (normalizedMcpServers.error) return { error: normalizedMcpServers.error };
    next.mcpServerIds = normalizedMcpServers.value ?? [];
  }

  if (input.systemPromptAddition !== undefined) {
    const normalizedPrompt = normalizeSystemPromptAddition(input.systemPromptAddition);
    if (normalizedPrompt.error) return { error: normalizedPrompt.error };
    next.systemPromptAddition = normalizedPrompt.value;
  }

  if (input.capabilityPolicy !== undefined) {
    next.capabilityPolicy = normalizeCapabilityPolicy(input.capabilityPolicy);
  }

  return { value: next };
}

function toPromptSnippet(prompt: string, maxChars = 220): string {
  const paragraphs = prompt
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const normalized = paragraphs
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const preferred =
    normalized.find((paragraph) => /^(your job is|your role is|you check|this role)/i.test(paragraph))
    ?? normalized.find((paragraph) => !/^you are the\b/i.test(paragraph))
    ?? normalized[0]
    ?? "";

  if (preferred.length <= maxChars) return preferred;
  return `${preferred.slice(0, Math.max(0, maxChars - 3))}...`;
}

export async function listAgents(): Promise<{ agents: AgentConfig[] }> {
  return { agents: await getAllAgents() };
}

export async function listRoleSelections(): Promise<{ selectedByRole: Partial<Record<BaseRole, string>> }> {
  return { selectedByRole: await readRoleSelections() };
}

export async function updateRoleSelection(role: string, agentId?: string | null): Promise<{ selectedByRole: Partial<Record<BaseRole, string>> }> {
  if (!isBaseRole(role)) {
    throw new AgentsServiceError(400, `Invalid role: ${role}`);
  }

  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (normalizedAgentId) {
    const allAgents = await getAllAgents();
    const agent = allAgents.find((item) => item.id === normalizedAgentId);
    if (!agent) {
      throw new AgentsServiceError(400, `Unknown agent: ${normalizedAgentId}`);
    }
    if (agent.baseRole !== role) {
      throw new AgentsServiceError(400, `Agent ${normalizedAgentId} cannot be assigned to role ${role}`);
    }
  }

  await writeRoleSelection(role, normalizedAgentId || null);
  return { selectedByRole: await readRoleSelections() };
}

export async function listPromptSnippets(): Promise<{ snippets: Partial<Record<BaseRole, string>> }> {
  const snippets: Partial<Record<BaseRole, string>> = {};
  for (const role of BASE_ROLES) {
    try {
      const prompt = await loadPrompt(role);
      snippets[role] = toPromptSnippet(prompt);
    } catch {
      // Skip missing prompt; frontend renders fallback.
    }
  }
  return { snippets };
}

export async function createAgent(payload: Partial<AgentConfig>): Promise<{ agent: AgentConfig }> {
  const normalized = normalizeAgentCreatePayload(payload);
  if (normalized.error || !normalized.value) {
    throw new AgentsServiceError(400, normalized.error ?? "Invalid agent payload");
  }

  const agent = normalized.value;
  if (BUILTIN_AGENTS.some((builtin) => builtin.id === agent.id)) {
    throw new AgentsServiceError(400, "Cannot override a builtin agent ID");
  }

  const custom = await readCustomAgents();
  const existingIndex = custom.findIndex((entry) => entry.id === agent.id);
  if (existingIndex >= 0) {
    custom[existingIndex] = agent;
  } else {
    custom.push(agent);
  }
  await writeCustomAgents(custom);
  return { agent };
}

export async function updateAgent(id: string, patch: Partial<AgentConfig>): Promise<{ agent: AgentConfig }> {
  if (BUILTIN_AGENTS.some((builtin) => builtin.id === id)) {
    throw new AgentsServiceError(400, "Cannot edit builtin agents");
  }

  const custom = await readCustomAgents();
  const index = custom.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new AgentsServiceError(404, "Agent not found");
  }

  const normalized = normalizeAgentPatchPayload(custom[index], patch);
  if (normalized.error || !normalized.value) {
    throw new AgentsServiceError(400, normalized.error ?? "Invalid agent payload");
  }

  custom[index] = { ...normalized.value, id, isBuiltin: false };
  await writeCustomAgents(custom);
  return { agent: custom[index] };
}

export async function deleteAgent(id: string): Promise<{ ok: true }> {
  if (BUILTIN_AGENTS.some((builtin) => builtin.id === id)) {
    throw new AgentsServiceError(400, "Cannot delete builtin agents");
  }

  const custom = await readCustomAgents();
  const filtered = custom.filter((entry) => entry.id !== id);
  if (filtered.length === custom.length) {
    throw new AgentsServiceError(404, "Agent not found");
  }

  await writeCustomAgents(filtered);

  const selectedByRole = await readRoleSelections();
  for (const role of BASE_ROLES) {
    if (selectedByRole[role] === id) {
      await writeRoleSelection(role, null);
    }
  }

  return { ok: true };
}
