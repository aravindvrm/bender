import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LogLevel, SinkLevel } from "../logger.js";
import { getBenderHomePath } from "./paths.js";
import { LocalProjectDb } from "./local-db.js";
import { HomeDb } from "./home-db.js";
import { DEFAULT_THEME_ID } from "../themes/defaults.js";

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

export interface ProviderConfig {
  apiKey?: string;
  /** Override base URL for OpenAI-compatible providers. */
  baseUrl?: string;
  /** Optional default model hint for provider-specific flows. */
  model?: string;
  /** Capability flags used for graceful feature gating. */
  supportsTools?: boolean;
  supportsJson?: boolean;
  supportsStreaming?: boolean;
  /** Optional capability overrides keyed by model id (for mixed-model local setups). */
  modelCapabilities?: Record<string, {
    supportsTools?: boolean;
    supportsJson?: boolean;
    supportsStreaming?: boolean;
    endpoint?: string;
    apiStyle?: "chat" | "responses" | "auto";
    errors?: string[];
  }>;
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
    [name: string]: ProviderConfig;
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
  ui?: {
    themeId?: string;
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
  logging?: {
    /** Enable structured logging to .bender/bender.log. Token usage is always recorded. */
    enabled?: boolean;
    /** Minimum level persisted in log file (debug|info|warn|error). */
    level?: LogLevel;
    /** Minimum level mirrored into the live console stream, or "none". */
    consoleLevel?: SinkLevel;
  };
  security?: {
    terminalExec?: {
      /** Allow terminal execution from the dashboard terminal panel. */
      enabled?: boolean;
      /** Require explicit confirmation when commands match dangerous patterns. */
      requireDangerousConfirmation?: boolean;
    };
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
  ui: {
    themeId: DEFAULT_THEME_ID,
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
  logging: {
    enabled: true,
    level: "info",
    consoleLevel: "warn",
  },
  security: {
    terminalExec: {
      enabled: true,
      requireDangerousConfirmation: true,
    },
  },
};

const PROJECT_CONFIG_DB_KEY = "state.config.project.v1";
const GLOBAL_CONFIG_DB_KEY = "state.config.global.v1";

export function getBenderDir(projectRoot: string): string {
  return join(projectRoot, ".bender");
}

export function getConfigPath(projectRoot: string): string {
  return join(getBenderDir(projectRoot), "config.yaml");
}

export async function readConfig(projectRoot: string): Promise<BenderConfig> {
  const { config } = await readProjectConfigRaw(projectRoot);
  return mergeConfig(DEFAULT_CONFIG, config ?? {});
}

export async function writeConfig(projectRoot: string, config: BenderConfig): Promise<void> {
  const db = LocalProjectDb.forProject(projectRoot);
  await db.init();
  db.setKv(PROJECT_CONFIG_DB_KEY, JSON.stringify(config));
  const configPath = getConfigPath(projectRoot);
  await writeConfigAtPath(configPath, config);
}

export function getGlobalConfigPath(): string {
  return getBenderHomePath("global-config.yaml");
}

export async function readGlobalConfig(): Promise<BenderConfig> {
  const { config } = await readGlobalConfigRaw();
  return mergeConfig(DEFAULT_CONFIG, config ?? {});
}

export async function writeGlobalConfig(config: BenderConfig): Promise<void> {
  const db = HomeDb.current();
  await db.init();
  db.setJson(GLOBAL_CONFIG_DB_KEY, config);
  await writeConfigAtPath(getGlobalConfigPath(), config);
}

export async function readEffectiveConfig(projectRoot?: string | null): Promise<BenderConfig> {
  const globalConfig = await readGlobalConfig();
  if (!projectRoot) return globalConfig;
  const project = await readProjectConfigRaw(projectRoot);
  if (!project.exists) {
    return globalConfig;
  }
  return mergeConfig(globalConfig, project.config ?? {});
}

async function readConfigAtPath(configPath: string): Promise<BenderConfig> {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = await readFile(configPath, "utf-8");
  const parsed = parseYaml(raw) as Partial<BenderConfig>;
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

async function readConfigFilePartial(configPath: string): Promise<{ exists: boolean; config: Partial<BenderConfig> | null }> {
  if (!existsSync(configPath)) return { exists: false, config: null };
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<BenderConfig>;
    return { exists: true, config: parsed };
  } catch {
    return { exists: true, config: null };
  }
}

async function readProjectConfigRaw(projectRoot: string): Promise<{ exists: boolean; config: Partial<BenderConfig> | null }> {
  const db = LocalProjectDb.forProject(projectRoot);
  await db.init();
  const fromDbRaw = db.getKv(PROJECT_CONFIG_DB_KEY);
  if (fromDbRaw) {
    try {
      const parsed = JSON.parse(fromDbRaw) as Partial<BenderConfig>;
      return { exists: true, config: parsed };
    } catch {
      // Fall through to legacy file import.
    }
  }

  const file = await readConfigFilePartial(getConfigPath(projectRoot));
  if (file.exists && file.config) {
    db.setKv(PROJECT_CONFIG_DB_KEY, JSON.stringify(file.config));
  }
  return file;
}

async function readGlobalConfigRaw(): Promise<{ exists: boolean; config: Partial<BenderConfig> | null }> {
  const db = HomeDb.current();
  await db.init();
  const fromDb = db.getJson<Partial<BenderConfig>>(GLOBAL_CONFIG_DB_KEY);
  if (fromDb) {
    return { exists: true, config: fromDb };
  }

  const file = await readConfigFilePartial(getGlobalConfigPath());
  if (file.exists && file.config) {
    db.setJson(GLOBAL_CONFIG_DB_KEY, file.config);
  }
  return file;
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
      const defaultEntry = defaultProviders[name] ?? {};
      const overrideEntry = overrideProviders[name] ?? {};
      const mergeString = (overrideValue?: string, defaultValue?: string): string | undefined => {
        if (typeof overrideValue === "string" && overrideValue.trim().length > 0) return overrideValue;
        if (typeof defaultValue === "string" && defaultValue.trim().length > 0) return defaultValue;
        return undefined;
      };
      return [
        name,
        {
          apiKey: mergeString(overrideEntry.apiKey, defaultEntry.apiKey),
          baseUrl: mergeString(overrideEntry.baseUrl, defaultEntry.baseUrl),
          model: mergeString(overrideEntry.model, defaultEntry.model),
          supportsTools: overrideEntry.supportsTools ?? defaultEntry.supportsTools,
          supportsJson: overrideEntry.supportsJson ?? defaultEntry.supportsJson,
          supportsStreaming: overrideEntry.supportsStreaming ?? defaultEntry.supportsStreaming,
          modelCapabilities: {
            ...(defaultEntry.modelCapabilities ?? {}),
            ...(overrideEntry.modelCapabilities ?? {}),
          },
        },
      ];
    }),
  ) as { [name: string]: ProviderConfig };
  const providers = providerNames.size > 0 ? mergedProviders : undefined;

  return {
    llm: {
      ...defaults.llm,
      ...overrides.llm,
      models: {
        ...defaults.llm.models,
        ...overrides.llm?.models,
      },
    },
    ...(providers ? { providers } : {}),
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
    ui: {
      ...defaults.ui,
      ...overrides.ui,
    },
    stack: { ...defaults.stack, ...overrides.stack },
    deploy: { ...defaults.deploy, ...overrides.deploy },
    test: { ...defaults.test, ...overrides.test },
    reanalyze: { ...defaults.reanalyze, ...overrides.reanalyze },
    logging: { ...defaults.logging, ...overrides.logging },
    security: {
      ...defaults.security,
      ...overrides.security,
      terminalExec: {
        ...defaults.security?.terminalExec,
        ...overrides.security?.terminalExec,
      },
    },
  };
}
