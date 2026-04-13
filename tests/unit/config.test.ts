import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  readConfig,
  readEffectiveConfig,
  readGlobalConfig,
  writeConfig,
  writeGlobalConfig,
  type BenderConfig,
} from "../../src/state/config.js";
import { createTempDir, withTempHome, type TempHomeContext } from "../helpers/temp-env.js";

describe("state/config", () => {
  let tempHome: TempHomeContext;
  let projectRoot: string;

  beforeEach(async () => {
    tempHome = await withTempHome();
    projectRoot = await createTempDir("bender-project-");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await tempHome.restore();
  });

  it("returns defaults when config is missing", async () => {
    const config = await readConfig(projectRoot);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("writes and reads project config values", async () => {
    const next = structuredClone(DEFAULT_CONFIG);
    next.llm.provider = "openai";
    next.llm.models.fast = "gpt-4o-mini";
    next.providers = { openai: { apiKey: "sk-openai-test" } };
    next.skills = {
      enabled: true,
      enabledSkills: ["security-best-practices"],
      paths: ["./docs/skills"],
      maxChars: 9000,
    };

    await writeConfig(projectRoot, next);
    const readBack = await readConfig(projectRoot);

    expect(readBack.llm.provider).toBe("openai");
    expect(readBack.providers?.openai?.apiKey).toBe("sk-openai-test");
    expect(readBack.skills?.enabled).toBe(true);
    expect(readBack.skills?.enabledSkills).toEqual(["security-best-practices"]);
    expect(readBack.skills?.paths).toEqual(["./docs/skills"]);
    expect(readBack.skills?.maxChars).toBe(9000);
  });

  it("merges global config with project overrides for effective config", async () => {
    const globalConfig = structuredClone(DEFAULT_CONFIG);
    globalConfig.llm.provider = "openai";
    globalConfig.llm.models.strong = "gpt-4o";
    globalConfig.providers = {
      openai: { apiKey: "sk-global-openai" },
      anthropic: { apiKey: "sk-global-anthropic" },
    };
    await writeGlobalConfig(globalConfig);

    const projectConfig: BenderConfig = structuredClone(DEFAULT_CONFIG);
    projectConfig.llm.provider = "anthropic";
    projectConfig.llm.models.default = "claude-sonnet";
    projectConfig.stack.framework = "next.js";
    projectConfig.providers = {
      anthropic: { apiKey: "sk-project-anthropic" },
    };
    await mkdir(join(projectRoot, ".bender"), { recursive: true });
    await writeConfig(projectRoot, projectConfig);

    const effective = await readEffectiveConfig(projectRoot);
    expect(effective.llm.provider).toBe("anthropic");
    expect(effective.llm.models.strong).toBe("claude-sonnet-4-6-20250514");
    expect(effective.providers?.openai?.apiKey).toBe("sk-global-openai");
    expect(effective.providers?.anthropic?.apiKey).toBe("sk-project-anthropic");
  });

  it("reads and writes global config using temp HOME", async () => {
    const globalConfig = structuredClone(DEFAULT_CONFIG);
    globalConfig.llm.provider = "groq";
    globalConfig.providers = { groq: { apiKey: "gsk-test" } };

    await writeGlobalConfig(globalConfig);
    const readBack = await readGlobalConfig();

    expect(readBack.llm.provider).toBe("groq");
    expect(readBack.providers?.groq?.apiKey).toBe("gsk-test");
  });
});
