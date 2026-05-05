/**
 * Secret storage abstraction layered on top of the OS keychain
 * (macOS Keychain / Windows Credential Manager / libsecret on Linux).
 *
 * Goals:
 * - Keep cleartext credentials out of `~/.bender/global-config.yaml`,
 *   `~/.bender/github-auth.json`, and the SQLite home DB.
 * - Allow YAML/JSON files to remain portable across machines: they
 *   carry only references like `secret:openai-apiKey`, never the
 *   credential itself.
 * - Degrade gracefully when the keychain is unavailable (CI, headless
 *   Linux without a session bus, etc.) — callers can still resolve
 *   plaintext or fall back to environment variables.
 *
 * The wrapper is intentionally synchronous because @napi-rs/keyring's
 * underlying calls are themselves synchronous; making it async would
 * just hide that with no benefit.
 */
import { Entry } from "@napi-rs/keyring";

/** Namespace under which all Bender keychain entries are stored. */
const SERVICE = "bender";

/** Reference prefix used in YAML/JSON to point at a keychain entry. */
const REF_PREFIX = "secret:";

/** Heuristic: characters allowed in account names we generate ourselves. */
const ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

let cachedAvailability: boolean | null = null;
let availabilityWarningEmitted = false;

/** True if the value is a `secret:<account>` reference. */
export function isSecretRef(value: string | undefined | null): value is string {
  return typeof value === "string" && value.startsWith(REF_PREFIX) && value.length > REF_PREFIX.length;
}

/** Build a `secret:<account>` reference string from an account name. */
export function buildSecretRef(account: string): string {
  if (!ACCOUNT_PATTERN.test(account)) {
    throw new Error(`Invalid secret account name '${account}': must match ${ACCOUNT_PATTERN}`);
  }
  return `${REF_PREFIX}${account}`;
}

/** Extract the account name from a `secret:<account>` reference. */
export function parseSecretRef(ref: string): string {
  if (!isSecretRef(ref)) {
    throw new Error(`Not a secret reference: '${ref}'`);
  }
  return ref.slice(REF_PREFIX.length);
}

/**
 * Probe whether the keychain is reachable on this machine. Cached after
 * first probe — calling repeatedly is cheap. We probe by attempting a
 * `getPassword()` against a sentinel account; that is a no-op read on
 * macOS (no permission prompt) and reliably surfaces missing libsecret
 * on Linux.
 */
export function isKeychainAvailable(): boolean {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    const probe = new Entry(SERVICE, "__bender_keychain_probe__");
    probe.getPassword();
    cachedAvailability = true;
  } catch (err) {
    cachedAvailability = false;
    if (!availabilityWarningEmitted) {
      availabilityWarningEmitted = true;
      const message = err instanceof Error ? err.message : String(err);
      // We log to stderr rather than throwing — callers fall back to
      // environment variables or plaintext, neither of which we want
      // to silently swallow.
      process.stderr.write(
        `[bender] OS keychain unavailable; falling back to plaintext config. (${message})\n`,
      );
    }
  }
  return cachedAvailability;
}

/** Reset cached probe state. Test-only. */
export function __resetKeychainAvailabilityCache(): void {
  cachedAvailability = null;
  availabilityWarningEmitted = false;
}

/**
 * Read a secret. Returns `null` if no entry exists, the entry is empty,
 * or the keychain is unavailable. Never throws.
 */
export function getSecret(account: string): string | null {
  if (!ACCOUNT_PATTERN.test(account)) return null;
  if (!isKeychainAvailable()) return null;
  try {
    const entry = new Entry(SERVICE, account);
    const value = entry.getPassword();
    if (typeof value !== "string" || value.length === 0) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Write a secret. Returns true on success, false on failure (keychain
 * unavailable, permission denied, etc.). Never throws.
 *
 * On macOS, the first call after install triggers a permission prompt
 * — by design.
 */
export function setSecret(account: string, value: string): boolean {
  if (!ACCOUNT_PATTERN.test(account)) return false;
  if (!isKeychainAvailable()) return false;
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const entry = new Entry(SERVICE, account);
    entry.setPassword(value);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bender] Failed to write secret '${account}': ${message}\n`);
    return false;
  }
}

/** Delete a secret. No-op if it does not exist. Never throws. */
export function deleteSecret(account: string): boolean {
  if (!ACCOUNT_PATTERN.test(account)) return false;
  if (!isKeychainAvailable()) return false;
  try {
    const entry = new Entry(SERVICE, account);
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolution chain for a configured secret value (e.g. `apiKey`):
 *   1. If env var override is set, use it (highest priority — CI / headless wins)
 *   2. If value is a `secret:` ref, fetch from keychain
 *   3. Otherwise, return the raw value (legacy plaintext, with deprecation warning)
 *   4. Empty / undefined → null
 *
 * Callers pass the configured value plus the env var name they want to
 * honor (or undefined to skip env override). Returns the resolved
 * plaintext, or null if nothing resolved.
 */
export interface ResolveOptions {
  envVar?: string;
  /** Logical name used in deprecation warnings, e.g. "providers.openai.apiKey" */
  contextLabel?: string;
}

const plaintextWarnedFor = new Set<string>();

export function resolveSecret(
  configured: string | undefined | null,
  options: ResolveOptions = {},
): string | null {
  const { envVar, contextLabel } = options;

  if (envVar) {
    const fromEnv = process.env[envVar];
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
      return fromEnv;
    }
  }

  if (typeof configured !== "string" || configured.length === 0) return null;

  if (isSecretRef(configured)) {
    return getSecret(parseSecretRef(configured));
  }

  // Legacy plaintext value. Warn once per context so users notice.
  const warnKey = contextLabel ?? "<unlabeled>";
  if (!plaintextWarnedFor.has(warnKey)) {
    plaintextWarnedFor.add(warnKey);
    process.stderr.write(
      `[bender] Found plaintext secret in config (${warnKey}). It will be migrated to the OS keychain on next save.\n`,
    );
  }
  return configured;
}
