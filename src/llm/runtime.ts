import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { BenderConfig, McpServerConfig } from "../state/config.js";
import type { RoleExecutionOptions } from "../roles/base.js";

export interface RuntimeLogAdapter {
  info?: (message: string) => void;
  warn?: (message: string) => void;
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

async function buildSkillsContext(
  projectRoot: string,
  config: BenderConfig,
  logger?: RuntimeLogAdapter,
): Promise<{ text: string | null; fileCount: number }> {
  if (!config.skills?.enabled) return { text: null, fileCount: 0 };

  const configuredPaths = config.skills.paths ?? [];
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
  if (files.length === 0) {
    logger?.warn?.("Skills are enabled but no readable .md/.txt skill files were found.");
    return { text: null, fileCount: 0 };
  }

  const maxChars = Math.max(1000, config.skills.maxChars ?? 12000);
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

  const text = [
    "## Skills Context",
    "Use the following project-specific skills only when directly relevant:",
    ...sections,
  ].join("\n\n");

  logger?.info?.(`Loaded ${sections.length} skill file(s) for role context.`);
  return { text, fileCount: sections.length };
}

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
  toolConfiguration: {
    enabled: true;
    allowedTools?: string[];
  };
} {
  return {
    type: "url",
    name: server.name,
    url: server.url,
    authorizationToken: server.authorizationToken,
    toolConfiguration: {
      enabled: true,
      allowedTools: server.allowedTools,
    },
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

export async function createRoleRuntime(
  projectRoot: string,
  config: BenderConfig,
  logger?: RuntimeLogAdapter,
): Promise<RoleRuntime> {
  const skills = await buildSkillsContext(projectRoot, config, logger);

  const runtime: RoleRuntime = {
    tools: undefined,
    providerOptions: undefined,
    additionalSystemContext: skills.text ?? undefined,
    close: async () => {},
    summary: {
      mcpEnabled: false,
      skillsEnabled: !!skills.text,
      mcpTools: 0,
      skillFiles: skills.fileCount,
    },
  };

  if (!config.mcp?.enabled) return runtime;

  const enabledServers = (config.mcp.servers ?? []).filter((s) => s.enabled !== false);
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
      runtime.providerOptions = {
        anthropic: {
          mcpServers: servers,
        },
      };
      runtime.summary.mcpEnabled = true;
      runtime.summary.mcpTools = servers.length;
      logger?.info?.(`MCP enabled (${servers.length} server${servers.length === 1 ? "" : "s"}) via Anthropic connector support.`);
    }

    return runtime;
  }

  logger?.warn?.(`MCP is configured, but provider '${provider}' does not support MCP in this runtime.`);
  return runtime;
}
