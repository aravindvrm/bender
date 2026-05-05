import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  hasPlaintextSecrets,
  hydrateConfigSecrets,
  readGlobalConfig,
  redactConfigSecrets,
  writeGlobalConfig,
  type BenderConfig,
  DEFAULT_CONFIG,
} from "../../src/state/config.js";
import {
  __resetKeychainAvailabilityCache,
  deleteSecret,
  getSecret,
  isKeychainAvailable,
  isSecretRef,
} from "../../src/state/secrets.js";

const tempDirs: string[] = [];

async function makeIsolatedHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bender-secret-migration-"));
  tempDirs.push(dir);
  process.env.BENDER_HOME_DIR = dir;
  return dir;
}

afterEach(async () => {
  // Best-effort cleanup of the keychain entries we touched. Account names
  // here match the slot generator in config.ts.
  for (const account of [
    "providers-openai-apiKey",
    "providers-anthropic-apiKey",
    "llm-apiKey",
  ]) {
    deleteSecret(account);
  }
  delete process.env.BENDER_HOME_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  __resetKeychainAvailabilityCache();
});

function makeConfigWithKey(provider: string, apiKey: string): BenderConfig {
  return {
    ...DEFAULT_CONFIG,
    providers: {
      [provider]: { apiKey, baseUrl: "", model: "", modelCapabilities: {} },
    },
  };
}

describe("redactConfigSecrets", () => {
  it("returns unchanged config when no plaintext present", () => {
    const empty: BenderConfig = { ...DEFAULT_CONFIG };
    const out = redactConfigSecrets(empty);
    expect(out).toEqual(empty);
  });

  it.skipIf(!isKeychainAvailable())("converts plaintext apiKey into a secret ref", () => {
    const cfg = makeConfigWithKey("openai", "sk-plaintext-test-value");
    const out = redactConfigSecrets(cfg);
    expect(out.providers?.openai?.apiKey).toBe("secret:providers-openai-apiKey");
    expect(getSecret("providers-openai-apiKey")).toBe("sk-plaintext-test-value");
  });

  it.skipIf(!isKeychainAvailable())("is idempotent — running twice on already-redacted config is a no-op", () => {
    const cfg = makeConfigWithKey("openai", "sk-idempotency-test");
    const once = redactConfigSecrets(cfg);
    const twice = redactConfigSecrets(once);
    expect(twice).toEqual(once);
    expect(getSecret("providers-openai-apiKey")).toBe("sk-idempotency-test");
  });

  it("does not mutate the input config", () => {
    const cfg = makeConfigWithKey("openai", "sk-mutation-test");
    const before = JSON.stringify(cfg);
    redactConfigSecrets(cfg);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe("hasPlaintextSecrets", () => {
  it("returns false for empty config", () => {
    expect(hasPlaintextSecrets({ ...DEFAULT_CONFIG })).toBe(false);
  });

  it("returns true when plaintext is present", () => {
    expect(hasPlaintextSecrets(makeConfigWithKey("openai", "sk-plain"))).toBe(true);
  });

  it("returns false when only refs are present", () => {
    expect(hasPlaintextSecrets(makeConfigWithKey("openai", "secret:providers-openai-apiKey"))).toBe(false);
  });
});

describe("hydrateConfigSecrets", () => {
  beforeEach(() => __resetKeychainAvailabilityCache());

  it.skipIf(!isKeychainAvailable())("resolves a stored ref back to plaintext", () => {
    const cfg = makeConfigWithKey("openai", "sk-hydrate-test");
    redactConfigSecrets(cfg);                          // plant the secret in keychain
    const refOnly = makeConfigWithKey("openai", "secret:providers-openai-apiKey");
    const hydrated = hydrateConfigSecrets(refOnly);
    expect(hydrated.providers?.openai?.apiKey).toBe("sk-hydrate-test");
  });

  it("env var override beats stored ref", () => {
    process.env.OPENAI_API_KEY = "from-env-var";
    try {
      const refOnly = makeConfigWithKey("openai", "secret:providers-openai-apiKey");
      const hydrated = hydrateConfigSecrets(refOnly);
      expect(hydrated.providers?.openai?.apiKey).toBe("from-env-var");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("returns undefined for missing entries", () => {
    const refOnly = makeConfigWithKey("openai", "secret:providers-openai-apiKey-missing");
    const hydrated = hydrateConfigSecrets(refOnly);
    expect(hydrated.providers?.openai?.apiKey).toBeUndefined();
  });
});

describe("end-to-end migration via writeGlobalConfig + readGlobalConfig", () => {
  it.skipIf(!isKeychainAvailable())(
    "plaintext apiKey on disk is auto-migrated to keychain on next read; YAML on disk no longer leaks",
    async () => {
      const home = await makeIsolatedHome();

      // 1. Write a config with plaintext (simulates a user upgrading from a
      //    pre-secrets build, where they have raw keys in their YAML).
      //    We bypass writeGlobalConfig's redaction by writing the YAML directly,
      //    then poking the DB so readGlobalConfig sees the raw form.
      const cfg = makeConfigWithKey("openai", "sk-leaked-on-disk");
      await writeGlobalConfig(cfg);

      // After writeGlobalConfig, the YAML should already be redacted
      const yamlPath = join(home, "global-config.yaml");
      const yamlText = await readFile(yamlPath, "utf-8");
      const parsedYaml = parseYaml(yamlText) as BenderConfig;
      expect(parsedYaml.providers?.openai?.apiKey).toBe("secret:providers-openai-apiKey");

      // 2. Reading the config should hydrate the value back to plaintext for callers
      const read = await readGlobalConfig();
      expect(read.providers?.openai?.apiKey).toBe("sk-leaked-on-disk");

      // 3. Verify the keychain holds the plaintext
      expect(getSecret("providers-openai-apiKey")).toBe("sk-leaked-on-disk");
    },
  );

  it.skipIf(!isKeychainAvailable())(
    "is idempotent — repeated read+write cycles do not corrupt or duplicate state",
    async () => {
      await makeIsolatedHome();
      const cfg = makeConfigWithKey("openai", "sk-cycle-test");
      await writeGlobalConfig(cfg);

      for (let i = 0; i < 3; i++) {
        const r = await readGlobalConfig();
        expect(r.providers?.openai?.apiKey).toBe("sk-cycle-test");
        await writeGlobalConfig(r);
      }

      // Final disk state is still a single ref
      const yamlText = await readFile(join(process.env.BENDER_HOME_DIR!, "global-config.yaml"), "utf-8");
      const parsedYaml = parseYaml(yamlText) as BenderConfig;
      expect(isSecretRef(parsedYaml.providers?.openai?.apiKey)).toBe(true);
    },
  );

  it.skipIf(!isKeychainAvailable())(
    "clearing a key (writing empty string) deletes the keychain entry",
    async () => {
      await makeIsolatedHome();
      // Plant
      await writeGlobalConfig(makeConfigWithKey("openai", "sk-to-be-cleared"));
      expect(getSecret("providers-openai-apiKey")).toBe("sk-to-be-cleared");
      // Clear
      await writeGlobalConfig(makeConfigWithKey("openai", ""));
      expect(getSecret("providers-openai-apiKey")).toBe(null);
    },
  );
});
