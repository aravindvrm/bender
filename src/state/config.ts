import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type ModelTier = "fast" | "default" | "strong";

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
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
};

export function getBenderDir(projectRoot: string): string {
  return join(projectRoot, ".bender");
}

export function getConfigPath(projectRoot: string): string {
  return join(getBenderDir(projectRoot), "config.yaml");
}

export async function readConfig(projectRoot: string): Promise<BenderConfig> {
  const configPath = getConfigPath(projectRoot);
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = await readFile(configPath, "utf-8");
  const parsed = parseYaml(raw) as Partial<BenderConfig>;
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

export async function writeConfig(projectRoot: string, config: BenderConfig): Promise<void> {
  const benderDir = getBenderDir(projectRoot);
  if (!existsSync(benderDir)) {
    await mkdir(benderDir, { recursive: true });
  }
  await writeFile(getConfigPath(projectRoot), stringifyYaml(config), "utf-8");
}

function mergeConfig(defaults: BenderConfig, overrides: Partial<BenderConfig>): BenderConfig {
  return {
    llm: {
      ...defaults.llm,
      ...overrides.llm,
      models: {
        ...defaults.llm.models,
        ...overrides.llm?.models,
      },
    },
    stack: { ...defaults.stack, ...overrides.stack },
    deploy: { ...defaults.deploy, ...overrides.deploy },
    test: { ...defaults.test, ...overrides.test },
  };
}
