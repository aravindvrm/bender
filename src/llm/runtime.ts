import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { BenderConfig, McpServerConfig } from "../state/config.js";
import type { RoleExecutionOptions } from "../roles/base.js";
import type { BaseRole } from "../state/agents.js";
import { BUILTIN_AGENTS } from "../state/agents.js";
import type { CapabilityPolicy } from "../state/capabilities.js";
import { resolveConnectorAccess } from "../state/capabilities.js";
import {
  buildProjectContextQuery,
  TIER2_MAX_BYTES,
} from "../state/skills.js";
import {
  fetchSkillPackages,
  fetchSkillPackageContent,
  selectSkillPackagesHybrid,
  type SkillPackageMeta,
} from "../state/skill-packages.js";

interface RoleSkillBudget {
  maxTier1PinnedSkills: number;
  maxTier2ContextSkills: number;
  maxTier3TaskSkills: number;
  maxTotalRegistrySkills: number;
  maxCharsPerSkill: number;
  maxTotalChars: number;
}

const DEFAULT_ROLE_SKILL_BUDGET: RoleSkillBudget = {
  maxTier1PinnedSkills: 3,
  maxTier2ContextSkills: 2,
  maxTier3TaskSkills: 2,
  maxTotalRegistrySkills: 5,
  maxCharsPerSkill: 2800,
  maxTotalChars: 9000,
};

const ROLE_SKILL_BUDGETS: Record<BaseRole, RoleSkillBudget> = {
  analyzer: {
    maxTier1PinnedSkills: 4,
    maxTier2ContextSkills: 2,
    maxTier3TaskSkills: 2,
    maxTotalRegistrySkills: 6,
    maxCharsPerSkill: 3200,
    maxTotalChars: 11000,
  },
  architect: {
    maxTier1PinnedSkills: 3,
    maxTier2ContextSkills: 3,
    maxTier3TaskSkills: 2,
    maxTotalRegistrySkills: 6,
    maxCharsPerSkill: 3000,
    maxTotalChars: 10500,
  },
  planner: {
    maxTier1PinnedSkills: 2,
    maxTier2ContextSkills: 2,
    maxTier3TaskSkills: 2,
    maxTotalRegistrySkills: 5,
    maxCharsPerSkill: 2400,
    maxTotalChars: 8000,
  },
  implementer: {
    maxTier1PinnedSkills: 2,
    maxTier2ContextSkills: 1,
    maxTier3TaskSkills: 3,
    maxTotalRegistrySkills: 5,
    maxCharsPerSkill: 2600,
    maxTotalChars: 8500,
  },
  reviewer: {
    maxTier1PinnedSkills: 4,
    maxTier2ContextSkills: 1,
    maxTier3TaskSkills: 3,
    maxTotalRegistrySkills: 6,
    maxCharsPerSkill: 3200,
    maxTotalChars: 11000,
  },
};

function getRoleSkillBudget(role: BaseRole): RoleSkillBudget {
  return ROLE_SKILL_BUDGETS[role] ?? DEFAULT_ROLE_SKILL_BUDGET;
}

export interface RuntimeLogAdapter {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function isRoleLogger(value: unknown): value is NonNullable<RoleExecutionOptions["logger"]> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.debug === "function"
    && typeof v.info === "function"
    && typeof v.warn === "function"
    && typeof v.error === "function"
  );
}

export interface RoleRuntime extends RoleExecutionOptions {
  close: () => Promise<void>;
  summary: {
    mcpEnabled: boolean;
    skillsEnabled: boolean;
    mcpTools: number;
    skillFiles: number;
  };
}

/** Options for building a runtime for a specific role + task. */
export interface RuntimeOptions {
  role: BaseRole;
  taskDescription?: string;
  /** Override pinned skills (from agent config). Falls back to builtin agent defaults. */
  pinnedSkills?: string[];
  /** Restrict MCP to the connectors assigned to this agent (server IDs). */
  mcpServerIds?: string[];
  /** Capability policy is the preferred access-control surface. */
  capabilityPolicy?: CapabilityPolicy;
  /** Override model tier (from agent config). */
  modelTier?: string;
  /** Agent-level prompt augmentation injected above project context. */
  systemPromptAddition?: string;
}

// ── Provider helpers ──────────────────────────────────────────────────────────

function getProviderApiKey(config: BenderConfig, provider: string): string | undefined {
  return config.providers?.[provider]?.apiKey ?? config.llm.apiKey;
}

function hasEnvApiKey(provider: string): boolean {
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "google") return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY || !!process.env.GOOGLE_API_KEY;
  if (provider === "groq") return !!process.env.GROQ_API_KEY;
  return false;
}

// ── Legacy local skills (path-based) ─────────────────────────────────────────

function normalizePath(input: string, projectRoot: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("/")) return trimmed;
  return resolve(projectRoot, trimmed);
}

function listMarkdownFilesSyncSafe(target: string): string[] {
  if (!existsSync(target)) return [];
  return [target];
}

async function collectSkillFiles(targetPath: string): Promise<string[]> {
  const found: string[] = [];
  if (!existsSync(targetPath)) return found;

  let s;
  try {
    s = await stat(targetPath);
  } catch {
    return found;
  }

  if (s.isFile()) {
    const ext = extname(targetPath).toLowerCase();
    if (ext === ".md" || ext === ".txt") found.push(targetPath);
    return found;
  }

  if (!s.isDirectory()) return found;

  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const full = join(targetPath, entry.name);
    if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".md" || ext === ".txt") found.push(full);
    }
  }

  return found;
}

async function buildLegacySkillsContext(
  projectRoot: string,
  config: BenderConfig,
  logger?: RuntimeLogAdapter,
): Promise<{ text: string | null; fileCount: number }> {
  const configuredPaths = config.skills?.paths ?? [];
  if (configuredPaths.length === 0) return { text: null, fileCount: 0 };

  const resolvedTargets = configuredPaths
    .map((p) => normalizePath(p, projectRoot))
    .flatMap((p) => listMarkdownFilesSyncSafe(p));

  const fileSet = new Set<string>();
  for (const target of resolvedTargets) {
    try {
      const files = await collectSkillFiles(target);
      for (const file of files) fileSet.add(file);
    } catch {
      logger?.warn?.(`Could not inspect skill path: ${target}`);
    }
  }

  const files = [...fileSet].sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return { text: null, fileCount: 0 };

  const maxChars = Math.max(1000, config.skills?.maxChars ?? 12000);
  let usedChars = 0;
  const sections: string[] = [];

  for (const file of files) {
    if (usedChars >= maxChars) break;
    try {
      const raw = await readFile(file, "utf-8");
      const remaining = maxChars - usedChars;
      const body = raw.slice(0, remaining);
      if (!body.trim()) continue;
      sections.push(`### ${basename(file)}\n${body}`);
      usedChars += body.length;
    } catch {
      logger?.warn?.(`Could not read skill file: ${file}`);
    }
  }

  if (sections.length === 0) return { text: null, fileCount: 0 };

  return {
    text: ["## Skills Context", "Use the following project-specific skills only when directly relevant:", ...sections].join("\n\n"),
    fileCount: sections.length,
  };
}

// ── Registry-based skills (three-tier) ───────────────────────────────────────

async function buildRegistrySkillsContext(
  projectRoot: string,
  config: BenderConfig,
  roleOpts: RuntimeOptions,
  architectureText?: string,
  logger?: RuntimeLogAdapter,
): Promise<{ text: string | null; fileCount: number }> {
  const builtinPinned = BUILTIN_AGENTS.find((a) => a.baseRole === roleOpts.role)?.pinnedSkills ?? [];
  const pinnedSkills = roleOpts.pinnedSkills ?? builtinPinned;
  const hasPinnedSkills = pinnedSkills.length > 0;

  if (!config.skills?.enabled && !hasPinnedSkills) return { text: null, fileCount: 0 };

  const registry = await fetchSkillPackages({ projectRoot });
  const configuredSkillNames = new Set(config.skills?.enabledSkills ?? []);
  const pinnedSet = new Set(pinnedSkills);
  const enabledPkgs = registry.packages.filter((pkg) => (
    pinnedSet.has(pkg.name)
    || pinnedSet.has(pkg.id)
    || configuredSkillNames.has(pkg.name)
    || configuredSkillNames.has(pkg.id)
  ));
  if (enabledPkgs.length === 0) return { text: null, fileCount: 0 };
  const enabledByName = new Map<string, SkillPackageMeta>();
  const enabledById = new Map<string, SkillPackageMeta>();
  for (const pkg of enabledPkgs) {
    enabledByName.set(pkg.name, pkg);
    enabledById.set(pkg.id, pkg);
  }
  const budget = getRoleSkillBudget(roleOpts.role);

  const selectedNames = new Set<string>();
  const selectedInOrder: SkillPackageMeta[] = [];
  const tier1Selected: SkillPackageMeta[] = [];
  const tier2Selected: SkillPackageMeta[] = [];
  const tier3Selected: SkillPackageMeta[] = [];

  const addSelectedSkill = (pkg: SkillPackageMeta): boolean => {
    if (selectedNames.has(pkg.id)) return true;
    if (selectedInOrder.length >= budget.maxTotalRegistrySkills) return false;
    selectedNames.add(pkg.id);
    selectedInOrder.push(pkg);
    return true;
  };

  // ── Tier 1: Role-pinned skills (from agent config or builtin defaults) ──────
  for (const nameOrId of pinnedSkills) {
    if (tier1Selected.length >= budget.maxTier1PinnedSkills) break;
    const pkg = enabledById.get(nameOrId) ?? enabledByName.get(nameOrId);
    if (!pkg) continue;
    if (!addSelectedSkill(pkg)) break;
    tier1Selected.push(pkg);
  }
  if (pinnedSkills.length > budget.maxTier1PinnedSkills) {
    logger?.warn?.(
      `Role '${roleOpts.role}' has ${pinnedSkills.length} pinned skills; only first ${budget.maxTier1PinnedSkills} are considered.`,
    );
  }

  // ── Tier 2: Project context skills (small skills only, < TIER2_MAX_BYTES) ──
  const projectQuery = buildProjectContextQuery(config, architectureText);
  const smallPkgs = enabledPkgs.filter((s) => s.size <= TIER2_MAX_BYTES);
  const tier2Candidates = selectSkillPackagesHybrid(smallPkgs, projectQuery, budget.maxTier2ContextSkills * 4);
  for (const pkg of tier2Candidates) {
    if (tier2Selected.length >= budget.maxTier2ContextSkills) break;
    if (selectedNames.has(pkg.id)) continue;
    if (!addSelectedSkill(pkg)) break;
    tier2Selected.push(pkg);
  }

  // ── Tier 3: Task-specific skills (any size, top 3 by relevance) ─────────────
  if (roleOpts.taskDescription) {
    const tier3Candidates = selectSkillPackagesHybrid(enabledPkgs, roleOpts.taskDescription, budget.maxTier3TaskSkills * 4);
    for (const pkg of tier3Candidates) {
      if (tier3Selected.length >= budget.maxTier3TaskSkills) break;
      if (selectedNames.has(pkg.id)) continue;
      if (!addSelectedSkill(pkg)) break;
      tier3Selected.push(pkg);
    }
  }

  if (selectedInOrder.length === 0) return { text: null, fileCount: 0 };

  // Fetch content for selected skills
  const configMaxChars = Math.max(1000, config.skills?.maxChars ?? 12000);
  const maxChars = Math.min(configMaxChars, budget.maxTotalChars);
  let usedChars = 0;
  const sections: string[] = [];

  for (const pkg of selectedInOrder) {
    if (usedChars >= maxChars) break;
    try {
      const content = await fetchSkillPackageContent(pkg);
      if (!content) continue;
      const remaining = maxChars - usedChars;
      const body = content.slice(0, Math.min(remaining, budget.maxCharsPerSkill));
      if (!body.trim()) continue;
      sections.push(`### ${pkg.name} [${pkg.source}]\n${body}`);
      usedChars += body.length;
    } catch {
      logger?.warn?.(`Could not load skill package: ${pkg.id}`);
    }
  }

  if (sections.length === 0) return { text: null, fileCount: 0 };

  logger?.info?.(
    `Loaded ${sections.length} skill(s) for ${roleOpts.role} [tier1:${tier1Selected.length}/${budget.maxTier1PinnedSkills} tier2:${tier2Selected.length}/${budget.maxTier2ContextSkills} tier3:${tier3Selected.length}/${budget.maxTier3TaskSkills} total:${selectedInOrder.length}/${budget.maxTotalRegistrySkills} chars:${usedChars}/${maxChars}]`,
  );

  return {
    text: ["## Skills Context", "Use the following skills only when directly relevant:", ...sections].join("\n\n"),
    fileCount: sections.length,
  };
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

function toOpenAiMcpTool(
  server: McpServerConfig,
  providerApiKey: string | undefined,
): ToolSet[string] {
  const openai = createOpenAI({ apiKey: providerApiKey });
  return openai.tools.mcp({
    serverLabel: server.name,
    serverUrl: server.url,
    serverDescription: server.description,
    authorization: server.authorizationToken,
    headers: server.headers,
    allowedTools: server.allowedTools,
  });
}

function toAnthropicMcpServer(server: McpServerConfig): {
  type: "url";
  name: string;
  url: string;
  authorizationToken?: string;
  toolConfiguration: { enabled: true; allowedTools?: string[] };
} {
  return {
    type: "url",
    name: server.name,
    url: server.url,
    authorizationToken: server.authorizationToken,
    toolConfiguration: { enabled: true, allowedTools: server.allowedTools },
  };
}

function validateServer(server: McpServerConfig, index: number, logger?: RuntimeLogAdapter): boolean {
  if (!server.name?.trim()) {
    logger?.warn?.(`Skipping MCP server #${index + 1}: missing name.`);
    return false;
  }
  if (!server.url?.trim()) {
    logger?.warn?.(`Skipping MCP server '${server.name}': missing url.`);
    return false;
  }
  return true;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function createRoleRuntime(
  projectRoot: string,
  config: BenderConfig,
  roleOpts: RuntimeOptions,
  architectureText?: string,
  logger?: RuntimeLogAdapter,
): Promise<RoleRuntime> {
  // Build skills context (registry-based takes priority, falls back to legacy paths)
  const hasRegistrySkills = config.skills?.enabled || (roleOpts.pinnedSkills?.length ?? 0) > 0;

  const skills = hasRegistrySkills
    ? await buildRegistrySkillsContext(projectRoot, config, roleOpts, architectureText, logger)
    : await buildLegacySkillsContext(projectRoot, config, logger);

  const runtime: RoleRuntime = {
    tools: undefined,
    providerOptions: undefined,
    additionalSystemContext: [
      roleOpts.systemPromptAddition?.trim()
        ? `## Agent-Specific Guidance\n${roleOpts.systemPromptAddition.trim()}`
        : null,
      skills.text ?? null,
    ].filter(Boolean).join("\n\n---\n\n") || undefined,
    logger: isRoleLogger(logger) ? logger : undefined,
    close: async () => {},
    summary: {
      mcpEnabled: false,
      skillsEnabled: !!skills.text,
      mcpTools: 0,
      skillFiles: skills.fileCount,
    },
  };

  if (!config.mcp?.enabled) return runtime;

  const allEnabledServers = (config.mcp.servers ?? []).filter((s) => s.enabled !== false);
  const { allowedConnectorIds } = resolveConnectorAccess(
    {
      capabilityPolicy: roleOpts.capabilityPolicy,
      mcpServerIds: roleOpts.mcpServerIds,
    },
    allEnabledServers,
  );
  const hasExplicitPolicyInput = !!roleOpts.capabilityPolicy || Array.isArray(roleOpts.mcpServerIds);
  if (hasExplicitPolicyInput && allowedConnectorIds.size === 0) {
    return runtime;
  }
  const enabledServers = hasExplicitPolicyInput
    ? allEnabledServers.filter((s) => !!s.id && allowedConnectorIds.has(s.id))
    : allEnabledServers;

  if (hasExplicitPolicyInput && enabledServers.length === 0) {
    logger?.warn?.(
      "No active MCP connectors matched agent capability policy.",
    );
  }

  if (enabledServers.length === 0) {
    logger?.warn?.("MCP is enabled but no active servers are configured.");
    return runtime;
  }

  const provider = config.llm.provider;

  if (provider === "openai") {
    const apiKey = getProviderApiKey(config, "openai");
    if (!apiKey && !hasEnvApiKey("openai")) {
      logger?.warn?.("MCP is enabled for OpenAI, but no OPENAI_API_KEY is configured. Skipping MCP tools.");
      return runtime;
    }
    const tools: ToolSet = {};
    for (const [index, server] of enabledServers.entries()) {
      if (!validateServer(server, index, logger)) continue;
      const slug = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `server-${index + 1}`;
      const baseToolName = `mcp_${slug}`;
      const toolName = tools[baseToolName] ? `${baseToolName}_${index + 1}` : baseToolName;
      tools[toolName] = toOpenAiMcpTool(server, apiKey);
    }
    const toolCount = Object.keys(tools).length;
    runtime.tools = toolCount > 0 ? tools : undefined;
    runtime.summary.mcpEnabled = toolCount > 0;
    runtime.summary.mcpTools = toolCount;
    if (toolCount > 0) {
      logger?.info?.(`MCP enabled (${toolCount} server tool${toolCount === 1 ? "" : "s"}) via OpenAI provider tools.`);
    }
    return runtime;
  }

  if (provider === "anthropic") {
    const servers = enabledServers
      .filter((server, index) => validateServer(server, index, logger))
      .map(toAnthropicMcpServer);
    if (servers.length > 0) {
      runtime.providerOptions = { anthropic: { mcpServers: servers } };
      runtime.summary.mcpEnabled = true;
      runtime.summary.mcpTools = servers.length;
      logger?.info?.(`MCP enabled (${servers.length} server${servers.length === 1 ? "" : "s"}) via Anthropic connector support.`);
    }
    return runtime;
  }

  logger?.warn?.(`MCP is configured, but provider '${provider}' does not support MCP in this runtime.`);
  return runtime;
}
