/**
 * Secret storage abstraction layered on top of the OS keychain
 * (macOS Keychain / Windows Credential Manager / libsecret on Linux).
 *
 * All secrets are stored as a single JSON blob under:
 *   service = "bender", account = "credentials"
 *
 * Bundling into one item means macOS only needs to prompt once per
 * binary (re-)authorization, regardless of how many keys are stored.
 * Individual-entry storage prompted once per key, which was confusing
 * and alarming on every new unsigned build.
 *
 * Lazy migration: if a key is missing from the blob, the old
 * individual Entry is checked and, if found, absorbed into the blob and
 * the individual entry deleted. Existing installs migrate transparently
 * on first use of each key.
 */
import { Entry } from "@napi-rs/keyring";

const SERVICE = "bender";
const CREDENTIALS_ACCOUNT = "credentials";
const REF_PREFIX = "secret:";
const ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

interface Cache {
  loaded: boolean;
  map: Map<string, string>;
}

const _cache: Cache = { loaded: false, map: new Map() };

let _available: boolean | null = null;
let _availabilityWarned = false;

// ---------------------------------------------------------------------------
// Public: availability probe
// ---------------------------------------------------------------------------

/**
 * Probe whether the keychain is reachable. Uses a read-only check
 * against a sentinel account we never write to — macOS returns null
 * for non-existent items without raising a permission dialog.
 * Cached after first call.
 */
export function isKeychainAvailable(): boolean {
  if (_available !== null) return _available;
  try {
    new Entry(SERVICE, "__probe__").getPassword();
    _available = true;
  } catch (err) {
    _available = false;
    if (!_availabilityWarned) {
      _availabilityWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[bender] OS keychain unavailable; falling back to plaintext config. (${msg})\n`,
      );
    }
  }
  return _available;
}

// ---------------------------------------------------------------------------
// Internal: blob load / save
// ---------------------------------------------------------------------------

function _loadBlob(): Map<string, string> {
  if (_cache.loaded) return _cache.map;
  _cache.loaded = true;
  try {
    const raw = new Entry(SERVICE, CREDENTIALS_ACCOUNT).getPassword();
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") _cache.map.set(k, v);
      }
    }
  } catch {
    // corrupt blob or keychain error — start empty, will overwrite on next write
  }
  return _cache.map;
}

function _saveBlob(map: Map<string, string>): boolean {
  try {
    const entry = new Entry(SERVICE, CREDENTIALS_ACCOUNT);
    if (map.size === 0) {
      try { entry.deletePassword(); } catch { /* already gone */ }
    } else {
      entry.setPassword(JSON.stringify(Object.fromEntries(map)));
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bender] Failed to save credentials blob: ${msg}\n`);
    return false;
  }
}

/**
 * Lazy migration: try reading an old individual Entry. If found, absorb
 * it into the blob and delete the individual entry so it's a one-time op.
 */
function _migrateOldEntry(account: string, map: Map<string, string>): string | null {
  try {
    const old = new Entry(SERVICE, account);
    const value = old.getPassword();
    if (typeof value === "string" && value.length > 0) {
      map.set(account, value);
      _saveBlob(map);
      try { old.deletePassword(); } catch { /* best-effort */ }
      return value;
    }
  } catch { /* no old entry */ }
  return null;
}

// ---------------------------------------------------------------------------
// Public: secret CRUD
// ---------------------------------------------------------------------------

export function getSecret(account: string): string | null {
  if (!ACCOUNT_PATTERN.test(account)) return null;
  if (!isKeychainAvailable()) return null;
  const map = _loadBlob();
  const value = map.get(account);
  if (value !== undefined) return value;
  return _migrateOldEntry(account, map);
}

/**
 * Write a secret into the credentials blob.
 * On macOS the first write after install / after a new binary is installed
 * triggers a single permission prompt — by design.
 */
export function setSecret(account: string, value: string): boolean {
  if (!ACCOUNT_PATTERN.test(account)) return false;
  if (!isKeychainAvailable()) return false;
  if (typeof value !== "string" || value.length === 0) return false;
  const map = _loadBlob();
  map.set(account, value);
  return _saveBlob(map);
}

/** Remove a secret from the blob. No-op if absent. Never throws. */
export function deleteSecret(account: string): boolean {
  if (!ACCOUNT_PATTERN.test(account)) return false;
  if (!isKeychainAvailable()) return false;
  const map = _loadBlob();
  if (!map.has(account)) return true;
  map.delete(account);
  return _saveBlob(map);
}

// ---------------------------------------------------------------------------
// Public: ref helpers (unchanged)
// ---------------------------------------------------------------------------

export function isSecretRef(value: string | undefined | null): value is string {
  return typeof value === "string" && value.startsWith(REF_PREFIX) && value.length > REF_PREFIX.length;
}

export function buildSecretRef(account: string): string {
  if (!ACCOUNT_PATTERN.test(account)) {
    throw new Error(`Invalid secret account name '${account}': must match ${ACCOUNT_PATTERN}`);
  }
  return `${REF_PREFIX}${account}`;
}

export function parseSecretRef(ref: string): string {
  if (!isSecretRef(ref)) throw new Error(`Not a secret reference: '${ref}'`);
  return ref.slice(REF_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Public: resolution chain (unchanged)
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  envVar?: string;
  contextLabel?: string;
}

const _plaintextWarnedFor = new Set<string>();

export function resolveSecret(
  configured: string | undefined | null,
  options: ResolveOptions = {},
): string | null {
  const { envVar, contextLabel } = options;
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv;
  }
  if (typeof configured !== "string" || configured.length === 0) return null;
  if (isSecretRef(configured)) return getSecret(parseSecretRef(configured));
  const warnKey = contextLabel ?? "<unlabeled>";
  if (!_plaintextWarnedFor.has(warnKey)) {
    _plaintextWarnedFor.add(warnKey);
    process.stderr.write(
      `[bender] Found plaintext secret in config (${warnKey}). It will be migrated to the OS keychain on next save.\n`,
    );
  }
  return configured;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __resetKeychainAvailabilityCache(): void {
  _available = null;
  _availabilityWarned = false;
}

/** Reset the in-process blob cache. Test-only. */
export function __resetCredentialsCache(): void {
  _cache.loaded = false;
  _cache.map = new Map();
}
