import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBenderHomePath } from "../../state/paths.js";
import {
  buildSecretRef,
  deleteSecret,
  isSecretRef,
  parseSecretRef,
  getSecret,
  setSecret,
} from "../../state/secrets.js";

const GITHUB_CLIENT_SECRET_ACCOUNT = "github-clientSecret";
const GITHUB_ACCESS_TOKEN_ACCOUNT = "github-accessToken";

/**
 * If the stored value is a `secret:` ref, return the keychain value.
 * If it's plaintext, migrate it to keychain (best-effort) and return
 * the plaintext. Returns undefined for empty/missing values.
 */
function hydrateOrMigrate(stored: string | undefined, account: string): string | undefined {
  if (!stored || stored.length === 0) return undefined;
  if (isSecretRef(stored)) {
    const fetched = getSecret(parseSecretRef(stored));
    return fetched ?? undefined;
  }
  // Legacy plaintext — migrate it on next write. We can't rewrite the file
  // here because the writer is the source of truth; instead the writer
  // function detects plaintext and converts it on save.
  return stored;
}

export interface GitHubSession {
  accessToken: string;
  tokenType?: string;
  scope?: string;
}

export interface StoredGitHubAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface GitHubDeviceSession {
  id: string;
  deviceCode: string;
  intervalSec: number;
  expiresAt: number;
}

const githubAuthStates = new Map<string, number>();
const githubDeviceSessions = new Map<string, GitHubDeviceSession>();
const GITHUB_SESSION_FILE = getBenderHomePath("github-session.json");
const GITHUB_AUTH_CONFIG_FILE = getBenderHomePath("github-auth.json");

export function createGitHubAuthState(): string {
  const state = randomUUID();
  githubAuthStates.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}

export function consumeGitHubAuthState(state: string): boolean {
  const expiresAt = githubAuthStates.get(state);
  githubAuthStates.delete(state);
  return !!state && !!expiresAt && Date.now() <= expiresAt;
}

export async function readStoredGitHubAuthConfig(): Promise<StoredGitHubAuthConfig> {
  if (!existsSync(GITHUB_AUTH_CONFIG_FILE)) return {};
  try {
    const raw = await readFile(GITHUB_AUTH_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoredGitHubAuthConfig;
    return {
      clientId: parsed.clientId?.trim() || undefined,
      // clientSecret may be a `secret:` ref → resolve via keychain.
      // Plaintext values are returned as-is and will be migrated on the
      // next call to writeStoredGitHubAuthConfig.
      clientSecret: hydrateOrMigrate(parsed.clientSecret?.trim(), GITHUB_CLIENT_SECRET_ACCOUNT),
      redirectUri: parsed.redirectUri?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export async function writeStoredGitHubAuthConfig(config: StoredGitHubAuthConfig): Promise<void> {
  const dir = dirname(GITHUB_AUTH_CONFIG_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Redact clientSecret before persisting. Plaintext value → keychain;
  // store the ref in the JSON. Empty value → drop both keychain entry
  // and the field. Already-ref values pass through unchanged.
  let storedClientSecret: string | undefined = config.clientSecret;
  if (storedClientSecret && !isSecretRef(storedClientSecret)) {
    if (setSecret(GITHUB_CLIENT_SECRET_ACCOUNT, storedClientSecret)) {
      storedClientSecret = buildSecretRef(GITHUB_CLIENT_SECRET_ACCOUNT);
    }
    // If keychain unavailable, fall through and write plaintext (better
    // than losing the user's value).
  } else if (!storedClientSecret) {
    deleteSecret(GITHUB_CLIENT_SECRET_ACCOUNT);
  }

  const onDisk: StoredGitHubAuthConfig = {
    clientId: config.clientId,
    clientSecret: storedClientSecret,
    redirectUri: config.redirectUri,
  };
  await writeFile(GITHUB_AUTH_CONFIG_FILE, JSON.stringify(onDisk, null, 2), "utf-8");
}

export async function getGithubAuthConfig(port: number): Promise<{ clientId?: string; clientSecret?: string; redirectUri: string }> {
  const stored = await readStoredGitHubAuthConfig();
  return {
    clientId: process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID ?? stored.clientId,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET ?? stored.clientSecret,
    redirectUri: process.env.GITHUB_APP_REDIRECT_URI ?? stored.redirectUri ?? `http://localhost:${port}/api/github/auth/callback`,
  };
}

export async function startGitHubDeviceFlow(port: number): Promise<{
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}> {
  const cfg = await getGithubAuthConfig(port);
  if (!cfg.clientId) {
    throw new Error("Missing GITHUB_APP_CLIENT_ID");
  }

  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      scope: "repo read:org",
    }),
  });

  const body = await response.json() as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.device_code || !body.user_code || !body.verification_uri || !body.expires_in) {
    const message = body.error_description ?? body.error ?? "Failed to start GitHub device flow";
    throw new Error(message);
  }

  const sessionId = randomUUID();
  const intervalSec = Math.max(2, body.interval ?? 5);
  const expiresAt = Date.now() + body.expires_in * 1000;

  githubDeviceSessions.set(sessionId, {
    id: sessionId,
    deviceCode: body.device_code,
    intervalSec,
    expiresAt,
  });

  return {
    sessionId,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    intervalSec,
    expiresAt,
  };
}

export async function pollGitHubDeviceFlow(sessionId: string, port: number): Promise<
  | { status: "pending"; intervalSec: number }
  | { status: "expired" | "denied" }
  | { status: "connected"; login?: string }
> {
  const cfg = await getGithubAuthConfig(port);
  if (!cfg.clientId) throw new Error("Missing GITHUB_APP_CLIENT_ID");

  const session = githubDeviceSessions.get(sessionId);
  if (!session) return { status: "expired" };
  if (Date.now() > session.expiresAt) {
    githubDeviceSessions.delete(sessionId);
    return { status: "expired" };
  }

  const payload = new URLSearchParams({
    client_id: cfg.clientId,
    device_code: session.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (cfg.clientSecret) {
    payload.set("client_secret", cfg.clientSecret);
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload,
  });

  const body = await response.json() as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  if (body.access_token) {
    await writeGitHubSession({
      accessToken: body.access_token,
      tokenType: body.token_type,
      scope: body.scope,
    });
    githubDeviceSessions.delete(sessionId);
    let login: string | undefined;
    try {
      const user = await githubApi<{ login: string }>("/user", body.access_token);
      login = user.login;
    } catch {
      // session may still be valid even if user lookup fails
    }
    return { status: "connected", login };
  }

  if (body.error === "authorization_pending") {
    return { status: "pending", intervalSec: session.intervalSec };
  }
  if (body.error === "slow_down") {
    const nextInterval = Math.max(session.intervalSec + 5, body.interval ?? session.intervalSec + 5);
    githubDeviceSessions.set(sessionId, {
      ...session,
      intervalSec: nextInterval,
    });
    return { status: "pending", intervalSec: nextInterval };
  }
  if (body.error === "access_denied") {
    githubDeviceSessions.delete(sessionId);
    return { status: "denied" };
  }
  if (body.error === "expired_token") {
    githubDeviceSessions.delete(sessionId);
    return { status: "expired" };
  }

  const message = body.error_description ?? body.error ?? `GitHub device flow failed (${response.status})`;
  throw new Error(message);
}

export async function readGitHubSession(): Promise<GitHubSession | null> {
  if (!existsSync(GITHUB_SESSION_FILE)) return null;
  try {
    const raw = await readFile(GITHUB_SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GitHubSession>;
    if (!parsed.accessToken) return null;
    const accessToken = hydrateOrMigrate(parsed.accessToken, GITHUB_ACCESS_TOKEN_ACCOUNT);
    if (!accessToken) return null;
    return {
      accessToken,
      tokenType: parsed.tokenType,
      scope: parsed.scope,
    };
  } catch {
    return null;
  }
}

export async function writeGitHubSession(session: GitHubSession): Promise<void> {
  const dir = dirname(GITHUB_SESSION_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Redact accessToken before persisting (same scheme as clientSecret).
  let storedToken: string = session.accessToken;
  if (!isSecretRef(storedToken)) {
    if (setSecret(GITHUB_ACCESS_TOKEN_ACCOUNT, storedToken)) {
      storedToken = buildSecretRef(GITHUB_ACCESS_TOKEN_ACCOUNT);
    }
    // Else keychain unavailable — write plaintext fallback.
  }

  const onDisk: GitHubSession = {
    ...session,
    accessToken: storedToken,
  };
  await writeFile(GITHUB_SESSION_FILE, JSON.stringify(onDisk, null, 2), "utf-8");
}

export async function clearGitHubSession(): Promise<void> {
  try {
    if (existsSync(GITHUB_SESSION_FILE)) {
      await unlink(GITHUB_SESSION_FILE);
    }
  } catch {
    // ignore cleanup failure
  }
  // Also drop the keychain entry — leaving a stale token there would be
  // a footgun for anyone who clears their session.
  deleteSecret(GITHUB_ACCESS_TOKEN_ACCOUNT);
}

export async function githubApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const extraHeaders = new Headers(init?.headers ?? {});
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bender-local",
  });
  for (const [key, value] of extraHeaders.entries()) {
    headers.set(key, value);
  }
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

export function authCloneUrl(cloneUrl: string, token: string): string {
  if (!cloneUrl.startsWith("https://")) return cloneUrl;
  return cloneUrl.replace("https://", `https://x-access-token:${encodeURIComponent(token)}@`);
}
