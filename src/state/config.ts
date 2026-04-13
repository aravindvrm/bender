import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ModelTier = "fast" | "default" | "strong";

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
}

export interface McpServerConfig {
  /** Curated server ID (e.g. "github", "figma"). Used for known servers. */
  id?: string;
  name: string;
  url: string;
  enabled?: boolean;
  description?: string;
  authorizationToken?: string;
  allowedTools?: string[];
  headers?: Record<string, string>;
}

export interface BenderConfig {
  llm: {
    provider: string;
    apiKey?: string;
    models: {
      fast: string | ModelConfig;
      default: string | ModelConfig;
      strong: string | ModelConfig;
    };
  };
  /** Per-provider API keys. Key wins over llm.apiKey for the matching provider. */
  providers?: {
    [name: string]: { apiKey?: string };
  };
  mcp?: {
    enabled?: boolean;
    servers?: McpServerConfig[];
  };
  skills?: {
    enabled?: boolean;
    /** Registry-based skills: list of skill names from openai/skills. */
    enabledSkills?: string[];
    /** Legacy: local file/directory paths (still supported). */
    paths?: string[];
    maxChars?: number;
  };
  stack: {
    template: string;
    framework: string;
    database: string;
    orm: string;
    auth: string;
    styling: string;
    language: string;
  };
  deploy: {
    target?: string;
  };
  test: {
    command?: string;
  };
  reanalyze?: {
    /** Automatically re-run the analyzer after major task completions. Default: true */
    enabled?: boolean;
    /** Number of major tasks to complete before triggering re-analysis. Default: 3 */
    threshold?: number;
  };
}

export const DEFAULT_CONFIG: BenderConfig = {
  llm: {
    provider: "anthropic",
    models: {
      fast: "claude-haiku-4-5-20251001",
      default: "claude-sonnet-4-6-20250514",
      strong: "claude-sonnet-4-6-20250514",
    },
  },
  mcp: {
    enabled: false,
    servers: [],
  },
  skills: {
    enabled: false,
    enabledSkills: [],
    paths: [],
    maxChars: 12000,
  },
  stack: {
    template: "nextjs-saas",
    framework: "next.js",
    database: "postgres",
    orm: "drizzle",
    auth: "next-auth",
    styling: "tailwind",
    language: "typescript",
  },
  deploy: {},
  test: {},
  reanalyze: {
    enabled: true,
    threshold: 3,
  },
};

export function getBenderDir(projectRoot: string): string {
  return join(projectRoot, ".bender");
}

export function getConfigPath(projectRoot: string): string {
  return join(getBenderDir(projectRoot), "config.yaml");
}

export async function readConfig(projectRoot: string): Promise<BenderConfig> {
  const configPath = getConfigPath(projectRoot);
  return readConfigAtPath(configPath);
}

export async function writeConfig(projectRoot: string, config: BenderConfig): Promise<void> {
  const configPath = getConfigPath(projectRoot);
  await writeConfigAtPath(configPath, config);
}

export function getGlobalConfigPath(): string {
  return join(homedir(), ".bender", "global-config.yaml");
}

export async function readGlobalConfig(): Promise<BenderConfig> {
  return readConfigAtPath(getGlobalConfigPath());
}

export async function writeGlobalConfig(config: BenderConfig): Promise<void> {
  await writeConfigAtPath(getGlobalConfigPath(), config);
}

export async function readEffectiveConfig(projectRoot?: string | null): Promise<BenderConfig> {
  const globalConfig = await readGlobalConfig();
  if (!projectRoot) return globalConfig;
  const projectConfigPath = getConfigPath(projectRoot);
  if (!existsSync(projectConfigPath)) {
    return globalConfig;
  }
  const projectConfig = await readConfig(projectRoot);
  return mergeConfig(globalConfig, projectConfig);
}

async function readConfigAtPath(configPath: string): Promise<BenderConfig> {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = await readFile(configPath, "utf-8");
  const parsed = parseYaml(raw) as Partial<BenderConfig>;
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

async function writeConfigAtPath(configPath: string, config: BenderConfig): Promise<void> {
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
  }
  await writeFile(configPath, stringifyYaml(config), "utf-8");
}

function mergeConfig(defaults: BenderConfig, overrides: Partial<BenderConfig>): BenderConfig {
  const defaultProviders = defaults.providers ?? {};
  const overrideProviders = overrides.providers ?? {};
  const providerNames = new Set([
    ...Object.keys(defaultProviders),
    ...Object.keys(overrideProviders),
  ]);
  const mergedProviders = Object.fromEntries(
    [...providerNames].map((name) => {
      const defaultKey = defaultProviders[name]?.apiKey;
      const overrideKey = overrideProviders[name]?.apiKey;
      const resolved = typeof overrideKey === "string" && overrideKey.trim().length > 0
        ? overrideKey
        : defaultKey;
      return [name, resolved ? { apiKey: resolved } : {}];
    }),
  ) as { [name: string]: { apiKey?: string } };

  return {
    llm: {
      ...defaults.llm,
      ...overrides.llm,
      models: {
        ...defaults.llm.models,
        ...overrides.llm?.models,
      },
    },
    providers: mergedProviders,
    mcp: {
      ...defaults.mcp,
      ...overrides.mcp,
      servers: overrides.mcp?.servers ?? defaults.mcp?.servers ?? [],
    },
    skills: {
      ...defaults.skills,
      ...overrides.skills,
      enabledSkills: overrides.skills?.enabledSkills ?? defaults.skills?.enabledSkills ?? [],
      paths: overrides.skills?.paths ?? defaults.skills?.paths ?? [],
      maxChars: overrides.skills?.maxChars ?? defaults.skills?.maxChars ?? 12000,
    },
    stack: { ...defaults.stack, ...overrides.stack },
    deploy: { ...defaults.deploy, ...overrides.deploy },
    test: { ...defaults.test, ...overrides.test },
    reanalyze: { ...defaults.reanalyze, ...overrides.reanalyze },
  };
}
