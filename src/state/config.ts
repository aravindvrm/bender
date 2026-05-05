import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LogLevel, SinkLevel } from "../logger.js";
import { getBenderHomePath } from "./paths.js";
import { LocalProjectDb } from "./local-db.js";
import { HomeDb } from "./home-db.js";
import { DEFAULT_THEME_ID } from "../themes/defaults.js";
import {
  buildSecretRef,
  deleteSecret,
  isSecretRef,
  resolveSecret,
  setSecret,
} from "./secrets.js";

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
  const merged = mergeConfig(DEFAULT_CONFIG, config ?? {});
  // One-shot migration: if anything plaintext slipped in, redact and
  // persist refs back to disk + DB before returning. Idempotent.
  if (hasPlaintextSecrets(merged)) {
    await writeConfig(projectRoot, merged);
    return hydrateConfigSecrets(await rereadConfig(projectRoot));
  }
  return hydrateConfigSecrets(merged);
}

async function rereadConfig(projectRoot: string): Promise<BenderConfig> {
  const { config } = await readProjectConfigRaw(projectRoot);
  return mergeConfig(DEFAULT_CONFIG, config ?? {});
}

export async function writeConfig(projectRoot: string, config: BenderConfig): Promise<void> {
  const redacted = redactConfigSecrets(config);
  const db = LocalProjectDb.forProject(projectRoot);
  await db.init();
  db.setKv(PROJECT_CONFIG_DB_KEY, JSON.stringify(redacted));
  const configPath = getConfigPath(projectRoot);
  await writeConfigAtPath(configPath, redacted);
}

export function getGlobalConfigPath(): string {
  return getBenderHomePath("global-config.yaml");
}

export async function readGlobalConfig(): Promise<BenderConfig> {
  const { config } = await readGlobalConfigRaw();
  const merged = mergeConfig(DEFAULT_CONFIG, config ?? {});
  if (hasPlaintextSecrets(merged)) {
    await writeGlobalConfig(merged);
    const { config: refreshed } = await readGlobalConfigRaw();
    return hydrateConfigSecrets(mergeConfig(DEFAULT_CONFIG, refreshed ?? {}));
  }
  return hydrateConfigSecrets(merged);
}

export async function writeGlobalConfig(config: BenderConfig): Promise<void> {
  const redacted = redactConfigSecrets(config);
  const db = HomeDb.current();
  await db.init();
  db.setJson(GLOBAL_CONFIG_DB_KEY, redacted);
  await writeConfigAtPath(getGlobalConfigPath(), redacted);
}

export async function readEffectiveConfig(projectRoot?: string | null): Promise<BenderConfig> {
  const globalConfig = await readGlobalConfig();
  if (!projectRoot) return globalConfig;
  // readConfig runs the project-level migration + hydration before
  // returning, so we can merge two already-hydrated configs and
  // get the right shape without re-resolving (which would falsely
  // flag the plaintext values as un-migrated).
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

// ── Secret redaction ──────────────────────────────────────────────────────────
//
// All secret-bearing fields in BenderConfig are stored as either:
//   - empty string / undefined (no value),
//   - a `secret:<account>` reference (preferred, value lives in OS keychain), or
//   - a raw plaintext value (legacy; auto-migrated to keychain on next save).
//
// `redactConfigSecrets` walks the config and migrates any plaintext values it
// finds, returning a copy whose secret fields are all refs (or empty). It is
// idempotent: running on an already-redacted config is a no-op. Called from
// every write path so cleartext credentials never reach the YAML or DB layer.

interface SecretSlot {
  /** Stable account name used as the keychain key. */
  account: string;
  /** Logical label for warnings / migration logs. */
  label: string;
  /** Current configured value (plaintext or ref or empty). */
  value: string | undefined;
}

/** Walk a config, yielding every secret-bearing slot with a setter. */
function forEachSecretSlot(
  config: BenderConfig,
  visit: (slot: SecretSlot, set: (next: string | undefined) => void) => void,
): void {
  // Top-level llm.apiKey
  visit(
    { account: "llm-apiKey", label: "llm.apiKey", value: config.llm.apiKey },
    (next) => { config.llm.apiKey = next; },
  );

  // llm.models.<tier>.apiKey (only when the tier is a ModelConfig object,
  // not a bare string)
  for (const tier of ["fast", "default", "strong"] as const) {
    const model = config.llm.models[tier];
    if (typeof model === "string") continue;
    visit(
      {
        account: `llm-models-${tier}-apiKey`,
        label: `llm.models.${tier}.apiKey`,
        value: model.apiKey,
      },
      (next) => { (config.llm.models[tier] as ModelConfig).apiKey = next; },
    );
  }

  // providers.<name>.apiKey
  if (config.providers) {
    for (const [name, provider] of Object.entries(config.providers)) {
      visit(
        {
          account: `providers-${name}-apiKey`,
          label: `providers.${name}.apiKey`,
          value: provider.apiKey,
        },
        (next) => { provider.apiKey = next; },
      );
    }
  }

  // mcp.servers[*].authorizationToken — keyed by the server's stable id,
  // falling back to a slug of the name. Skip if neither is usable as an
  // account name (would lose isolation).
  if (config.mcp?.servers) {
    for (const server of config.mcp.servers) {
      const idCandidate = server.id ?? server.name ?? "";
      const slug = idCandidate.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) continue;
      visit(
        {
          account: `mcp-${slug}-authorizationToken`,
          label: `mcp.servers[${idCandidate}].authorizationToken`,
          value: server.authorizationToken,
        },
        (next) => { server.authorizationToken = next; },
      );
    }
  }
}

/**
 * Migrate plaintext secrets in the config to the OS keychain, returning a
 * deep-cloned copy whose secret fields are all refs (or undefined).
 * Idempotent. Pure plaintext → ref. Existing refs are preserved as-is.
 *
 * If the keychain is unavailable, plaintext values are left in place and a
 * warning is logged (already by setSecret). The returned config is then
 * still safe to persist — it just won't be more secure than before.
 */
export function redactConfigSecrets(config: BenderConfig): BenderConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as BenderConfig;

  forEachSecretSlot(cloned, (slot, set) => {
    const { account, value } = slot;
    if (value === undefined || value === "") {
      // Empty: ensure the keychain entry is removed too so we don't keep
      // a stale value around after the user clears the field.
      deleteSecret(account);
      set(undefined);
      return;
    }
    if (isSecretRef(value)) {
      // Already a ref. Leave as-is.
      return;
    }
    // Plaintext: try to move it to the keychain. On success, replace
    // with the ref. On failure, keep the plaintext (writing the ref
    // would lose the value).
    if (setSecret(account, value)) {
      set(buildSecretRef(account));
    }
  });

  return cloned;
}

/**
 * True if the config contains any plaintext secret value (i.e. a non-empty
 * string that is not a `secret:` ref). Used to decide whether to run the
 * one-shot migration on read.
 */
export function hasPlaintextSecrets(config: BenderConfig): boolean {
  let found = false;
  forEachSecretSlot(config, (slot) => {
    if (found) return;
    if (slot.value && !isSecretRef(slot.value)) found = true;
  });
  return found;
}

/**
 * Per-provider env-var override map. When the env var is set, it wins over
 * both keychain entries and stored plaintext — useful for CI / scripted runs.
 */
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
};

/**
 * Resolve all secret references in a config to their actual plaintext
 * values, returning a deep-cloned copy. Used at read boundaries so callers
 * (LLM SDK setup, etc.) can keep accessing `config.providers.openai.apiKey`
 * and get a usable string back.
 *
 * The clone is intentional — never mutate the persisted in-memory shape,
 * because that shape is what gets compared in mergeConfig and may be
 * re-serialized back through writeConfig.
 */
export function hydrateConfigSecrets(config: BenderConfig): BenderConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as BenderConfig;

  forEachSecretSlot(cloned, (slot, set) => {
    // Determine env var override: top-level llm.apiKey + per-provider keys
    // honor the matching env var.
    let envVar: string | undefined;
    if (slot.account === "llm-apiKey") {
      envVar = PROVIDER_ENV_VARS[config.llm.provider];
    } else if (slot.account.startsWith("providers-")) {
      const providerName = slot.account.replace(/^providers-/, "").replace(/-apiKey$/, "");
      envVar = PROVIDER_ENV_VARS[providerName];
    }

    const resolved = resolveSecret(slot.value, { envVar, contextLabel: slot.label });
    set(resolved ?? undefined);
  });

  return cloned;
}
