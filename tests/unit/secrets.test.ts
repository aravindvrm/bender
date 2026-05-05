import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSecretRef,
  deleteSecret,
  getSecret,
  isKeychainAvailable,
  isSecretRef,
  parseSecretRef,
  resolveSecret,
  setSecret,
  __resetKeychainAvailabilityCache,
  __resetCredentialsCache,
} from "../../src/state/secrets.js";

// Tests run against the real OS keychain. They use a unique per-suite
// account prefix so they cannot collide with real bender entries, and the
// afterEach cleanup deletes any accounts touched. If the keychain is not
// available (CI sandbox, headless Linux without libsecret), the tests
// still verify the pure helpers — keychain-dependent ones are skipped.
const TEST_ACCOUNT_PREFIX = `__test-${Date.now()}-${Math.random().toString(36).slice(2)}__`;
const touchedAccounts = new Set<string>();

function tAcc(suffix: string): string {
  const account = `${TEST_ACCOUNT_PREFIX}${suffix}`;
  touchedAccounts.add(account);
  return account;
}

afterEach(() => {
  for (const account of touchedAccounts) {
    deleteSecret(account);
  }
  touchedAccounts.clear();
});

describe("isSecretRef / buildSecretRef / parseSecretRef", () => {
  it("recognizes `secret:<account>` references", () => {
    expect(isSecretRef("secret:openai-apiKey")).toBe(true);
    expect(isSecretRef("secret:foo")).toBe(true);
  });

  it("rejects non-references", () => {
    expect(isSecretRef("")).toBe(false);
    expect(isSecretRef("secret:")).toBe(false);
    expect(isSecretRef("sk-proj-abc123")).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it("round-trips build → parse", () => {
    const ref = buildSecretRef("providers-openai-apiKey");
    expect(ref).toBe("secret:providers-openai-apiKey");
    expect(parseSecretRef(ref)).toBe("providers-openai-apiKey");
  });

  it("rejects invalid account names in buildSecretRef", () => {
    expect(() => buildSecretRef("has spaces")).toThrow();
    expect(() => buildSecretRef("has/slash")).toThrow();
    expect(() => buildSecretRef("")).toThrow();
  });

  it("parseSecretRef throws on non-references", () => {
    expect(() => parseSecretRef("not-a-ref")).toThrow();
  });
});

describe("get/set/deleteSecret (against real keychain)", () => {
  beforeEach(() => {
    __resetKeychainAvailabilityCache();
    __resetCredentialsCache();
  });

  it.skipIf(!isKeychainAvailable())("round-trips a secret value", () => {
    const account = tAcc("roundtrip");
    expect(setSecret(account, "my-secret-value")).toBe(true);
    expect(getSecret(account)).toBe("my-secret-value");
    expect(deleteSecret(account)).toBe(true);
    expect(getSecret(account)).toBe(null);
  });

  it.skipIf(!isKeychainAvailable())("returns null for missing accounts", () => {
    const account = tAcc("never-set");
    expect(getSecret(account)).toBe(null);
  });

  it.skipIf(!isKeychainAvailable())("rejects empty values on set", () => {
    const account = tAcc("empty");
    expect(setSecret(account, "")).toBe(false);
  });

  it("rejects invalid account names without touching keychain", () => {
    expect(setSecret("has spaces", "x")).toBe(false);
    expect(getSecret("has spaces")).toBe(null);
    expect(deleteSecret("has spaces")).toBe(false);
  });
});

describe("resolveSecret", () => {
  const ENV_VAR = "BENDER_TEST_RESOLVE_SECRET";

  beforeEach(() => {
    delete process.env[ENV_VAR];
    __resetKeychainAvailabilityCache();
    __resetCredentialsCache();
  });

  it("returns null for empty / undefined / null", () => {
    expect(resolveSecret(undefined)).toBe(null);
    expect(resolveSecret(null)).toBe(null);
    expect(resolveSecret("")).toBe(null);
  });

  it("env var override beats everything", () => {
    process.env[ENV_VAR] = "from-env";
    expect(resolveSecret("plaintext-value", { envVar: ENV_VAR })).toBe("from-env");
    expect(resolveSecret("secret:non-existent", { envVar: ENV_VAR })).toBe("from-env");
  });

  it("returns plaintext value when no ref and no env", () => {
    expect(resolveSecret("plaintext-key")).toBe("plaintext-key");
  });

  it.skipIf(!isKeychainAvailable())("resolves a `secret:` ref via keychain", () => {
    const account = tAcc("resolve");
    setSecret(account, "fetched-from-keychain");
    expect(resolveSecret(buildSecretRef(account))).toBe("fetched-from-keychain");
  });

  it.skipIf(!isKeychainAvailable())("returns null for refs to missing entries", () => {
    expect(resolveSecret("secret:does-not-exist-account")).toBe(null);
  });
});
