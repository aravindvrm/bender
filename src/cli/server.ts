import express, { type Response } from "express";
import cors from "cors";
import { join, dirname, resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, platform as osPlatform } from "node:os";
import { spawn } from "node:child_process";
import type { Server as HttpServer } from "node:http";
import { simpleGit } from "simple-git";
import { readEffectiveConfig, readGlobalConfig, writeConfig, writeGlobalConfig, type BenderConfig } from "../state/config.js";
import { createModelSet, getModelForTier } from "../llm/provider.js";
import { createRoleRuntime } from "../llm/runtime.js";
import { StateManager, type AuditResult, type AuditIssue } from "../state/manager.js";
import { GitOperations } from "../git/operations.js";
import { readRegistry, addToRegistry, removeFromRegistry } from "../state/registry.js";
import { fetchRegistry, readRegistry as readSkillsRegistry } from "../state/skills.js";
import {
  getAllAgents,
  readCustomAgents,
  writeCustomAgents,
  readRoleSelections,
  writeRoleSelection,
  getEffectiveAgentForRole,
  BUILTIN_AGENTS,
  MAX_MCP_SERVERS_PER_AGENT,
  MAX_PINNED_SKILLS_PER_AGENT,
  type AgentConfig,
  type BaseRole,
} from "../state/agents.js";
import { initCommand } from "./init.js";
import { planCommand } from "./plan.js";
import { implementCommand, implementSingleTask } from "./implement.js";
import { analyzeCommand } from "./analyze.js";
import { generateFlows } from "../roles/flowcharter.js";
import { loadPrompt, runRole } from "../roles/base.js";
import { createLogger, makeAdapterSink, toLoggerOptions, type LogEntry } from "../logger.js";
import type { UIAdapter, SpinnerAdapter } from "./adapter.js";

const API_PORT = 3142;
type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama";
const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS = ["fast", "default", "strong"] as const;
const MAX_AGENT_NAME_CHARS = 80;
const MAX_SYSTEM_PROMPT_ADDITION_CHARS = 4000;
const MASKED_VALUE = "••••••••";
const SERVER_SESSION_STARTED_AT = Date.now();

interface CuratedMcpServerDefinition {
  id: string;
  name: string;
  url: string;
  description: string;
}

const CURATED_MCP_CONNECTORS: CuratedMcpServerDefinition[] = [
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    description: "Repository management, file operations, pull requests, and issues.",
  },
  {
    id: "figma",
    name: "Figma",
    url: "https://mcp.figma.com/mcp",
    description: "Access Figma designs and design tokens.",
  },
  {
    id: "neon",
    name: "Neon (Postgres)",
    url: "https://mcp.neon.tech/mcp",
    description: "Query and manage Neon Postgres databases.",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://mcp.vercel.com",
    description: "Deploy projects, manage environments, inspect deployments.",
  },
];

function toPromptSnippet(prompt: string, maxChars = 220): string {
  const paragraphs = prompt
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const normalized = paragraphs
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const preferred =
    normalized.find((p) => /^(your job is|your role is|you check|this role)/i.test(p))
    ?? normalized.find((p) => !/^you are the\b/i.test(p))
    ?? normalized[0]
    ?? "";

  if (preferred.length <= maxChars) return preferred;
  return `${preferred.slice(0, Math.max(0, maxChars - 3))}...`;
}

// ── SSE event types ──────────────────────────────────────────────────────────

export type SSEEvent =
  | { type: "header"; text: string }
  | { type: "subheader"; text: string }
  | { type: "output"; text: string; level: "info" | "success" | "warn" | "error" }
  | { type: "stream"; chunk: string }
  | { type: "spinner"; text: string; state: "start" | "succeed" | "fail" | "stop" }
  | { type: "files"; ops: { path: string; action: string }[] }
  | { type: "confirm"; id: string; question: string; default: boolean }
  | { type: "prompt"; id: string; question: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };

// ── Mutable server state ─────────────────────────────────────────────────────

let currentProject: string | null = null;

function getProject(): string {
  if (!currentProject) throw new Error("No project selected. Open a project first.");
  return currentProject;
}

function normalizeUserPath(input?: string): string {
  const raw = (input ?? "").trim();
  let targetPath = raw;

  if (!targetPath || targetPath === "~") {
    targetPath = homedir();
  } else if (targetPath.startsWith("~/")) {
    targetPath = join(homedir(), targetPath.slice(2));
  }

  return resolve(targetPath);
}

function isLlmProvider(value: string): value is LlmProvider {
  return value === "anthropic"
    || value === "openai"
    || value === "google"
    || value === "groq"
    || value === "ollama";
}

function isBaseRole(value: string): value is BaseRole {
  return BASE_ROLES.includes(value as BaseRole);
}

function isModelTier(value: string): value is (typeof MODEL_TIERS)[number] {
  return MODEL_TIERS.includes(value as (typeof MODEL_TIERS)[number]);
}

function normalizePinnedSkills(
  input: unknown,
): { value?: string[]; error?: string } {
  if (input === undefined) return { value: undefined };
  if (!Array.isArray(input)) return { error: "pinnedSkills must be an array of skill names" };
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const skill = item.trim();
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }
  if (skills.length > MAX_PINNED_SKILLS_PER_AGENT) {
    return { error: `pinnedSkills cannot exceed ${MAX_PINNED_SKILLS_PER_AGENT} items` };
  }
  return { value: skills };
}

function normalizeMcpServerIds(
  input: unknown,
): { value?: string[]; error?: string } {
  if (input === undefined) return { value: undefined };
  if (!Array.isArray(input)) return { error: "mcpServerIds must be an array of connector IDs" };
  const allowed = new Set(CURATED_MCP_CONNECTORS.map((c) => c.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_MCP_SERVERS_PER_AGENT) {
    return { error: `mcpServerIds cannot exceed ${MAX_MCP_SERVERS_PER_AGENT} items` };
  }
  return { value: ids };
}

function normalizeSystemPromptAddition(
  input: unknown,
): { value?: string; error?: string } {
  if (input === undefined) return { value: undefined };
  if (input === null) return { value: undefined };
  if (typeof input !== "string") {
    return { error: "systemPromptAddition must be a string" };
  }
  const trimmed = input.trim();
  if (!trimmed) return { value: undefined };
  if (trimmed.length > MAX_SYSTEM_PROMPT_ADDITION_CHARS) {
    return { error: `systemPromptAddition cannot exceed ${MAX_SYSTEM_PROMPT_ADDITION_CHARS} characters` };
  }
  return { value: trimmed };
}

function normalizeAgentCreatePayload(
  input: Partial<AgentConfig>,
): { value?: AgentConfig; error?: string } {
  const id = input.id?.trim();
  const name = input.name?.trim();
  const baseRole = input.baseRole;
  if (!id || !name || !baseRole) {
    return { error: "Missing required fields: id, name, baseRole" };
  }
  if (name.length > MAX_AGENT_NAME_CHARS) {
    return { error: `name cannot exceed ${MAX_AGENT_NAME_CHARS} characters` };
  }
  if (!isBaseRole(baseRole)) {
    return { error: `Invalid baseRole: ${baseRole}` };
  }
  const modelTierRaw = input.modelTier ?? "default";
  if (!isModelTier(modelTierRaw)) {
    return { error: `Invalid modelTier: ${String(modelTierRaw)}` };
  }
  const normalizedSkills = normalizePinnedSkills(input.pinnedSkills ?? []);
  if (normalizedSkills.error) return { error: normalizedSkills.error };
  const normalizedMcpServers = normalizeMcpServerIds(input.mcpServerIds ?? []);
  if (normalizedMcpServers.error) return { error: normalizedMcpServers.error };
  const normalizedPrompt = normalizeSystemPromptAddition(input.systemPromptAddition);
  if (normalizedPrompt.error) return { error: normalizedPrompt.error };

  return {
    value: {
      id,
      name,
      baseRole,
      modelTier: modelTierRaw,
      pinnedSkills: normalizedSkills.value ?? [],
      mcpServerIds: normalizedMcpServers.value ?? [],
      systemPromptAddition: normalizedPrompt.value,
      isBuiltin: false,
    },
  };
}

function normalizeAgentPatchPayload(
  current: AgentConfig,
  input: Partial<AgentConfig>,
): { value?: AgentConfig; error?: string } {
  const next: AgentConfig = { ...current, isBuiltin: false };

  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim()) {
      return { error: "name must be a non-empty string" };
    }
    const trimmed = input.name.trim();
    if (trimmed.length > MAX_AGENT_NAME_CHARS) {
      return { error: `name cannot exceed ${MAX_AGENT_NAME_CHARS} characters` };
    }
    next.name = trimmed;
  }

  if (input.baseRole !== undefined) {
    if (!isBaseRole(input.baseRole)) {
      return { error: `Invalid baseRole: ${input.baseRole}` };
    }
    next.baseRole = input.baseRole;
  }

  if (input.modelTier !== undefined) {
    if (!isModelTier(input.modelTier)) {
      return { error: `Invalid modelTier: ${String(input.modelTier)}` };
    }
    next.modelTier = input.modelTier;
  }

  if (input.pinnedSkills !== undefined) {
    const normalizedSkills = normalizePinnedSkills(input.pinnedSkills);
    if (normalizedSkills.error) return { error: normalizedSkills.error };
    next.pinnedSkills = normalizedSkills.value ?? [];
  }

  if (input.mcpServerIds !== undefined) {
    const normalizedMcpServers = normalizeMcpServerIds(input.mcpServerIds);
    if (normalizedMcpServers.error) return { error: normalizedMcpServers.error };
    next.mcpServerIds = normalizedMcpServers.value ?? [];
  }

  if (input.systemPromptAddition !== undefined) {
    const normalizedPrompt = normalizeSystemPromptAddition(input.systemPromptAddition);
    if (normalizedPrompt.error) return { error: normalizedPrompt.error };
    next.systemPromptAddition = normalizedPrompt.value;
  }

  return { value: next };
}

function resolveProviderApiKey(provider: LlmProvider, config: BenderConfig | null): string | undefined {
  if (provider === "anthropic") {
    return config?.providers?.anthropic?.apiKey
      ?? (config?.llm.provider === "anthropic" ? config.llm.apiKey : undefined)
      ?? process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "openai") {
    return config?.providers?.openai?.apiKey
      ?? (config?.llm.provider === "openai" ? config.llm.apiKey : undefined)
      ?? process.env.OPENAI_API_KEY;
  }
  if (provider === "google") {
    return config?.providers?.google?.apiKey
      ?? (config?.llm.provider === "google" ? config.llm.apiKey : undefined)
      ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
      ?? process.env.GOOGLE_API_KEY;
  }
  if (provider === "groq") {
    return config?.providers?.groq?.apiKey
      ?? (config?.llm.provider === "groq" ? config.llm.apiKey : undefined)
      ?? process.env.GROQ_API_KEY;
  }
  return "ollama";
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function fetchLiveModels(provider: LlmProvider, apiKey?: string): Promise<string[]> {
  if (provider === "openai") {
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) =>
        /^(gpt-|o[1-9]|chatgpt)/.test(id)
        && !/(audio|realtime|transcribe|tts|image|moderation|embedding|whisper|davinci|babbage)/.test(id),
      );
    return uniqueSorted(ids).reverse();
  }

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Anthropic model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    return uniqueSorted((body.data ?? []).map((m) => m.id ?? "")).reverse();
  }

  if (provider === "google") {
    if (!apiKey) throw new Error("Missing GOOGLE_GENERATIVE_AI_API_KEY");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google model list failed (${res.status})`);
    const body = await res.json() as { models?: Array<{ name?: string }> };
    const ids = (body.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.startsWith("gemini"));
    return uniqueSorted(ids).reverse();
  }

  if (provider === "groq") {
    if (!apiKey) throw new Error("Missing GROQ_API_KEY");
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Groq model list failed (${res.status})`);
    const body = await res.json() as { data?: Array<{ id?: string }> };
    return uniqueSorted((body.data ?? []).map((m) => m.id ?? "")).reverse();
  }

  const res = await fetch("http://localhost:11434/api/tags");
  if (!res.ok) throw new Error(`Ollama model list failed (${res.status})`);
  const body = await res.json() as { models?: Array<{ name?: string }> };
  return uniqueSorted((body.models ?? []).map((m) => m.name ?? "")).reverse();
}

interface GitHubSession {
  accessToken: string;
  tokenType?: string;
  scope?: string;
}

interface StoredGitHubAuthConfig {
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
const GITHUB_SESSION_FILE = join(homedir(), ".bender", "github-session.json");
const GITHUB_AUTH_CONFIG_FILE = join(homedir(), ".bender", "github-auth.json");

async function readStoredGitHubAuthConfig(): Promise<StoredGitHubAuthConfig> {
  if (!existsSync(GITHUB_AUTH_CONFIG_FILE)) return {};
  try {
    const raw = await readFile(GITHUB_AUTH_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoredGitHubAuthConfig;
    return {
      clientId: parsed.clientId?.trim() || undefined,
      clientSecret: parsed.clientSecret?.trim() || undefined,
      redirectUri: parsed.redirectUri?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

async function writeStoredGitHubAuthConfig(config: StoredGitHubAuthConfig): Promise<void> {
  const dir = dirname(GITHUB_AUTH_CONFIG_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(GITHUB_AUTH_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

async function getGithubAuthConfig() {
  const stored = await readStoredGitHubAuthConfig();
  return {
    clientId: process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID ?? stored.clientId,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET ?? stored.clientSecret,
    redirectUri: process.env.GITHUB_APP_REDIRECT_URI ?? stored.redirectUri ?? `http://localhost:${API_PORT}/api/github/auth/callback`,
  };
}

async function startGitHubDeviceFlow(): Promise<{
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}> {
  const cfg = await getGithubAuthConfig();
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

async function pollGitHubDeviceFlow(sessionId: string): Promise<
  | { status: "pending"; intervalSec: number }
  | { status: "expired" | "denied" }
  | { status: "connected"; login?: string }
> {
  const cfg = await getGithubAuthConfig();
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
      // ignore user lookup failure; session is still valid
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

async function readGitConfigValue(projectRoot: string, key: string, global = false): Promise<string | null> {
  const git = simpleGit(projectRoot);
  try {
    const args = global
      ? ["config", "--global", "--get", key]
      : ["config", "--local", "--get", key];
    const value = await git.raw(args);
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function setGitConfigValue(projectRoot: string, key: string, value: string, global = false): Promise<void> {
  const git = simpleGit(projectRoot);
  const args = global
    ? ["config", "--global", key, value]
    : ["config", "--local", key, value];
  await git.raw(args);
}

async function approveGitHubCredential(projectRoot: string, username: string, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["credential", "approve"], {
      cwd: projectRoot,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Failed to save git credential"));
    });
    child.stdin.write(`protocol=https\nhost=github.com\nusername=${username}\npassword=${token}\n\n`);
    child.stdin.end();
  });
}

async function readGitHubSession(): Promise<GitHubSession | null> {
  if (!existsSync(GITHUB_SESSION_FILE)) return null;
  try {
    const raw = await readFile(GITHUB_SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GitHubSession>;
    if (!parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      tokenType: parsed.tokenType,
      scope: parsed.scope,
    };
  } catch {
    return null;
  }
}

async function writeGitHubSession(session: GitHubSession): Promise<void> {
  const dir = dirname(GITHUB_SESSION_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(GITHUB_SESSION_FILE, JSON.stringify(session, null, 2), "utf-8");
}

async function clearGitHubSession(): Promise<void> {
  try {
    if (existsSync(GITHUB_SESSION_FILE)) {
      await unlink(GITHUB_SESSION_FILE);
    }
  } catch {
    // ignore cleanup failure
  }
}

async function githubApi<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bender-local",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

function authCloneUrl(cloneUrl: string, token: string): string {
  if (!cloneUrl.startsWith("https://")) return cloneUrl;
  return cloneUrl.replace("https://", `https://x-access-token:${encodeURIComponent(token)}@`);
}

// ── Pending answers ──────────────────────────────────────────────────────────

const pendingAnswers = new Map<string, (answer: string) => void>();

function sendSSE(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Web adapter factory ───────────────────────────────────────────────────────

function createWebAdapter(res: Response): UIAdapter {
  function send(event: SSEEvent) {
    try { sendSSE(res, event); } catch { /* connection closed */ }
  }

  function waitForAnswer(id: string): Promise<string> {
    return new Promise((resolve, reject) => {
      pendingAnswers.set(id, resolve);
      res.once("close", () => {
        if (pendingAnswers.has(id)) {
          pendingAnswers.delete(id);
          reject(new Error("Connection closed"));
        }
      });
    });
  }

  return {
    header(text) { send({ type: "header", text }); },
    subheader(text) { send({ type: "subheader", text }); },
    info(text) { send({ type: "output", text, level: "info" }); },
    success(text) { send({ type: "output", text, level: "success" }); },
    error(text) { send({ type: "output", text, level: "error" }); },
    warn(text) { send({ type: "output", text, level: "warn" }); },
    streamWriter() {
      return (chunk: string) => send({ type: "stream", chunk });
    },
    spinner(text: string): SpinnerAdapter {
      send({ type: "spinner", text, state: "start" });
      let currentText = text;
      return {
        get text() { return currentText; },
        set text(v: string) { currentText = v; send({ type: "spinner", text: v, state: "start" }); },
        start() { send({ type: "spinner", text: currentText, state: "start" }); },
        stop() { send({ type: "spinner", text: currentText, state: "stop" }); },
        succeed(t) { send({ type: "spinner", text: t ?? currentText, state: "succeed" }); },
        fail(t) { send({ type: "spinner", text: t ?? currentText, state: "fail" }); },
      };
    },
    async confirm(question, defaultYes = true): Promise<boolean> {
      const id = randomUUID();
      send({ type: "confirm", id, question, default: defaultYes });
      return (await waitForAnswer(id)) === "true";
    },
    async promptMultiline(question): Promise<string> {
      const id = randomUUID();
      send({ type: "prompt", id, question });
      return waitForAnswer(id);
    },
    showFileOperations(ops) { send({ type: "files", ops }); },
    cleanup() { /* no-op */ },
  };
}

function parseLogEntries(raw: string, limit?: number): LogEntry[] {
  const lines = raw.split("\n").filter(Boolean);
  const sliced = typeof limit === "number" ? lines.slice(-Math.max(0, limit)) : lines;
  return sliced
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is LogEntry => entry !== null);
}

function aggregateTokenUsage(
  entries: LogEntry[],
  sinceMs?: number,
): { inputTokens: number; outputTokens: number; events: number; lastTimestamp: string | null } {
  let inputTokens = 0;
  let outputTokens = 0;
  let events = 0;
  let lastTimestamp: string | null = null;

  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts)) continue;
    if (typeof sinceMs === "number" && ts < sinceMs) continue;

    const input = typeof entry.data?.inputTokens === "number" ? entry.data.inputTokens : 0;
    const output = typeof entry.data?.outputTokens === "number" ? entry.data.outputTokens : 0;
    if (input <= 0 && output <= 0) continue;

    inputTokens += input;
    outputTokens += output;
    events += 1;
    lastTimestamp = entry.timestamp;
  }

  return { inputTokens, outputTokens, events, lastTimestamp };
}

// ── SSE operation runner ──────────────────────────────────────────────────────

async function runOperation(
  res: Response,
  operation: (adapter: UIAdapter) => Promise<void>,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const adapter = createWebAdapter(res);
  try {
    await operation(adapter);
    sendSSE(res, { type: "done", success: true });
  } catch (err) {
    sendSSE(res, { type: "error", message: (err as Error).message });
  } finally {
    res.end();
    for (const [id] of pendingAnswers) pendingAnswers.delete(id);
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function startServer(initialProject?: string): Promise<HttpServer> {
  if (initialProject) {
    currentProject = initialProject;
    await addToRegistry(initialProject);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  const webDistDir = join(import.meta.dirname, "..", "web");
  if (existsSync(webDistDir)) app.use(express.static(webDistDir));

  // ── Project management ────────────────────────────────────────────────────

  // Current project info
  app.get("/api/project", (_req, res) => {
    res.json({ path: currentProject });
  });

  // Recent projects list
  app.get("/api/projects", async (_req, res) => {
    try {
      const projects = await readRegistry();
      res.json(projects);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Select (switch to) an existing project
  app.post("/api/project/select", async (req, res) => {
    const { path } = req.body as { path: string };
    if (!path) { res.status(400).json({ error: "path required" }); return; }
    const normalizedPath = normalizeUserPath(path);
    if (!existsSync(normalizedPath)) { res.status(400).json({ error: "Directory does not exist" }); return; }
    const dirStat = await stat(normalizedPath);
    if (!dirStat.isDirectory()) { res.status(400).json({ error: "Path is not a directory" }); return; }
    currentProject = normalizedPath;
    await addToRegistry(normalizedPath);
    res.json({ ok: true, path: normalizedPath });
  });

  // Open a directory (create if needed, don't init .bender yet)
  app.post("/api/project/open", async (req, res) => {
    const { path } = req.body as { path: string };
    if (!path) { res.status(400).json({ error: "path required" }); return; }
    const normalizedPath = normalizeUserPath(path);
    if (!existsSync(normalizedPath)) {
      await mkdir(normalizedPath, { recursive: true });
    } else {
      const dirStat = await stat(normalizedPath);
      if (!dirStat.isDirectory()) { res.status(400).json({ error: "Path is not a directory" }); return; }
    }
    currentProject = normalizedPath;
    await addToRegistry(normalizedPath);
    res.json({ ok: true, path: normalizedPath });
  });

  // Remove from recents
  app.delete("/api/projects/:encodedPath", async (req, res) => {
    const path = decodeURIComponent(req.params.encodedPath);
    await removeFromRegistry(path);
    res.json({ ok: true });
  });

  // ── GitHub App auth + repo access ────────────────────────────────────────

  app.get("/api/github/auth/config", async (_req, res) => {
    try {
      const stored = await readStoredGitHubAuthConfig();
      const cfg = await getGithubAuthConfig();
      res.json({
        clientId: cfg.clientId ?? "",
        clientSecretSet: !!cfg.clientSecret,
        redirectUri: cfg.redirectUri,
        usingEnvClientId: !!(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID),
        usingEnvClientSecret: !!(process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET),
        storedClientId: stored.clientId ?? "",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/github/auth/config", async (req, res) => {
    try {
      const body = req.body as { clientId?: string; clientSecret?: string; redirectUri?: string };
      const existing = await readStoredGitHubAuthConfig();

      const hasClientId = Object.prototype.hasOwnProperty.call(body, "clientId");
      const hasClientSecret = Object.prototype.hasOwnProperty.call(body, "clientSecret");
      const hasRedirectUri = Object.prototype.hasOwnProperty.call(body, "redirectUri");

      const nextConfig: StoredGitHubAuthConfig = {
        clientId: hasClientId ? (body.clientId?.trim() || undefined) : existing.clientId,
        clientSecret: hasClientSecret ? (body.clientSecret?.trim() || undefined) : existing.clientSecret,
        redirectUri: hasRedirectUri ? (body.redirectUri?.trim() || undefined) : existing.redirectUri,
      };

      await writeStoredGitHubAuthConfig(nextConfig);
      const cfg = await getGithubAuthConfig();
      res.json({
        ok: true,
        clientId: cfg.clientId ?? "",
        clientSecretSet: !!cfg.clientSecret,
        redirectUri: cfg.redirectUri,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/auth/status", async (_req, res) => {
    try {
      const cfg = await getGithubAuthConfig();
      if (!cfg.clientId) {
        res.json({
          configured: false,
          connected: false,
          message: "Set GITHUB_APP_CLIENT_ID to enable GitHub device login",
        });
        return;
      }

      const session = await readGitHubSession();
      if (!session?.accessToken) {
        res.json({
          configured: true,
          connected: false,
          authMode: cfg.clientSecret ? "oauth-or-device" : "device-only",
        });
        return;
      }

      try {
        const user = await githubApi<{ login: string; avatar_url?: string }>("/user", session.accessToken);
        res.json({
          configured: true,
          connected: true,
          login: user.login,
          avatarUrl: user.avatar_url,
          authMode: cfg.clientSecret ? "oauth-or-device" : "device-only",
        });
      } catch {
        await clearGitHubSession();
        res.json({
          configured: true,
          connected: false,
          authMode: cfg.clientSecret ? "oauth-or-device" : "device-only",
        });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/auth/start", (_req, res) => {
    // OAuth callback flow kept for compatibility; device flow is preferred in UI.
    const run = async () => {
      const cfg = await getGithubAuthConfig();
      if (!cfg.clientId || !cfg.clientSecret) {
        res.status(400).json({ error: "OAuth callback flow is not configured. Use GitHub device login instead." });
        return;
      }

      const state = randomUUID();
      githubAuthStates.set(state, Date.now() + 10 * 60 * 1000);

      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        scope: "repo read:org",
        state,
        allow_signup: "true",
      });

      res.json({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
    };
    void run().catch((err) => {
      res.status(500).json({ error: (err as Error).message });
    });
  });

  app.post("/api/github/device/start", async (_req, res) => {
    try {
      const flow = await startGitHubDeviceFlow();
      res.json(flow);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/github/device/poll", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      const id = (sessionId ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      const result = await pollGitHubDeviceFlow(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/auth/callback", async (req, res) => {
    const cfg = await getGithubAuthConfig();
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const authError = typeof req.query.error === "string" ? req.query.error : "";

    if (authError) {
      res.status(400).send(`<html><body><h2>GitHub auth failed</h2><p>${authError}</p></body></html>`);
      return;
    }

    const expiresAt = githubAuthStates.get(state);
    githubAuthStates.delete(state);
    if (!state || !expiresAt || Date.now() > expiresAt) {
      res.status(400).send("<html><body><h2>GitHub auth failed</h2><p>Invalid or expired state.</p></body></html>");
      return;
    }
    if (!cfg.clientId || !cfg.clientSecret || !code) {
      res.status(400).send("<html><body><h2>GitHub auth failed</h2><p>Missing configuration or code.</p></body></html>");
      return;
    }

    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: cfg.redirectUri,
        }),
      });
      const tokenBody = await tokenRes.json() as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenBody.access_token) {
        const message = tokenBody.error_description ?? tokenBody.error ?? "No access token returned";
        throw new Error(message);
      }

      await writeGitHubSession({
        accessToken: tokenBody.access_token,
        tokenType: tokenBody.token_type,
        scope: tokenBody.scope,
      });

      res.send("<html><body><h2>GitHub connected</h2><p>You can close this window and return to Bender.</p></body></html>");
    } catch (err) {
      res.status(500).send(`<html><body><h2>GitHub auth failed</h2><p>${(err as Error).message}</p></body></html>`);
    }
  });

  app.post("/api/github/auth/disconnect", async (_req, res) => {
    await clearGitHubSession();
    res.json({ ok: true });
  });

  app.get("/api/github/installations", async (_req, res) => {
    try {
      const session = await readGitHubSession();
      if (!session?.accessToken) {
        res.status(401).json({ error: "Not connected to GitHub" });
        return;
      }
      const data = await githubApi<{ installations: Array<{ id: number; account?: { login?: string }; app_slug?: string }> }>(
        "/user/installations",
        session.accessToken,
      );
      res.json({
        installations: (data.installations ?? []).map((i) => ({
          id: i.id,
          account: i.account?.login ?? "",
          appSlug: i.app_slug ?? "",
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/repos", async (req, res) => {
    try {
      const installationId = typeof req.query.installationId === "string"
        ? parseInt(req.query.installationId, 10)
        : null;
      const session = await readGitHubSession();
      if (!session?.accessToken) {
        res.status(401).json({ error: "Not connected to GitHub" });
        return;
      }

      const fetchInstallationRepos = async (id: number) => {
        const repos = await githubApi<{
          repositories: Array<{
            id: number;
            name: string;
            full_name: string;
            private: boolean;
            clone_url: string;
            html_url: string;
            default_branch: string;
            owner?: { login?: string };
          }>;
        }>(`/user/installations/${id}/repositories?per_page=100`, session.accessToken);
        return (repos.repositories ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          cloneUrl: r.clone_url,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          owner: r.owner?.login ?? "",
          installationId: id,
        }));
      };

      if (installationId) {
        res.json({ repositories: await fetchInstallationRepos(installationId) });
        return;
      }

      const installs = await githubApi<{ installations: Array<{ id: number }> }>("/user/installations", session.accessToken);
      const all = (
        await Promise.all((installs.installations ?? []).map((inst) => fetchInstallationRepos(inst.id)))
      ).flat();
      res.json({ repositories: all });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/github/clone", async (req, res) => {
    try {
      const { cloneUrl, targetPath } = req.body as { cloneUrl?: string; targetPath?: string };
      const rawCloneUrl = (cloneUrl ?? "").trim();
      const rawTarget = (targetPath ?? "").trim();
      if (!rawCloneUrl) { res.status(400).json({ error: "cloneUrl is required" }); return; }
      if (!rawTarget) { res.status(400).json({ error: "targetPath is required" }); return; }

      const normalizedTarget = normalizeUserPath(rawTarget);
      if (existsSync(normalizedTarget)) {
        const targetStat = await stat(normalizedTarget);
        if (!targetStat.isDirectory()) {
          res.status(400).json({ error: "targetPath is not a directory" });
          return;
        }
        const entries = await readdir(normalizedTarget);
        if (entries.length > 0) {
          res.status(400).json({ error: "targetPath must be empty for clone" });
          return;
        }
      } else {
        await mkdir(normalizedTarget, { recursive: true });
      }

      const session = await readGitHubSession();
      const cloneWithAuth = session?.accessToken ? authCloneUrl(rawCloneUrl, session.accessToken) : rawCloneUrl;
      const git = simpleGit();
      await git.clone(cloneWithAuth, normalizedTarget);

      currentProject = normalizedTarget;
      await addToRegistry(normalizedTarget);

      res.json({ ok: true, path: normalizedTarget, name: basename(normalizedTarget) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Filesystem browser ───────────────────────────────────────────────────

  app.get("/api/fs/browse", async (req, res) => {
    try {
      const queryPath = typeof req.query.path === "string" ? req.query.path : "";
      const targetPath = normalizeUserPath(queryPath);

      if (!existsSync(targetPath)) {
        res.status(400).json({ error: "Path does not exist" });
        return;
      }

      const targetStat = await stat(targetPath);
      if (!targetStat.isDirectory()) {
        res.status(400).json({ error: "Path is not a directory" });
        return;
      }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const dirs = (
        await Promise.all(
          entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map(async (e) => {
              const fullPath = join(targetPath, e.name);
              const hasBender = existsSync(join(fullPath, ".bender"));
              return { name: e.name, path: fullPath, hasBender };
            }),
        )
      ).sort((a, b) => a.name.localeCompare(b.name));

      // Also include hidden dirs that are bender projects
      const hiddenDirs = (
        await Promise.all(
          entries
            .filter((e) => e.isDirectory() && e.name.startsWith("."))
            .map(async (e) => {
              const fullPath = join(targetPath, e.name);
              const hasBender = existsSync(join(fullPath, ".bender"));
              return hasBender ? { name: e.name, path: fullPath, hasBender } : null;
            }),
        )
      ).filter(Boolean) as { name: string; path: string; hasBender: boolean }[];

      res.json({
        path: targetPath,
        parent: dirname(targetPath) !== targetPath ? dirname(targetPath) : null,
        dirs: [...dirs, ...hiddenDirs],
        hasBender: existsSync(join(targetPath, ".bender")),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/fs/inspect", async (req, res) => {
    try {
      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      if (!rawPath.trim()) {
        res.status(400).json({ error: "path required" });
        return;
      }

      const targetPath = normalizeUserPath(rawPath);
      if (!existsSync(targetPath)) {
        res.json({
          path: targetPath,
          exists: false,
          isDirectory: false,
          empty: true,
          hasBender: false,
          initialized: false,
          entryCount: 0,
          fileCount: 0,
          dirCount: 0,
        });
        return;
      }

      const targetStat = await stat(targetPath);
      if (!targetStat.isDirectory()) {
        res.json({
          path: targetPath,
          exists: true,
          isDirectory: false,
          empty: false,
          hasBender: false,
          initialized: false,
          entryCount: 0,
          fileCount: 0,
          dirCount: 0,
        });
        return;
      }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const fileCount = entries.filter((e) => e.isFile()).length;
      const dirCount = entries.filter((e) => e.isDirectory()).length;
      const hasBender = existsSync(join(targetPath, ".bender"));

      res.json({
        path: targetPath,
        exists: true,
        isDirectory: true,
        empty: entries.length === 0,
        hasBender,
        initialized: hasBender,
        entryCount: entries.length,
        fileCount,
        dirCount,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/llm/status", async (req, res) => {
    try {
      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      const targetPath = rawPath.trim()
        ? normalizeUserPath(rawPath)
        : (currentProject ?? null);

      const config = await readEffectiveConfig(targetPath).catch(() => null);
      const envFlags = {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        google: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY || !!process.env.GOOGLE_API_KEY,
        groq: !!process.env.GROQ_API_KEY,
        ollama: false,
      };

      const configFlags = {
        anthropic: !!config?.providers?.anthropic?.apiKey || (config?.llm.provider === "anthropic" && !!config?.llm.apiKey),
        openai: !!config?.providers?.openai?.apiKey || (config?.llm.provider === "openai" && !!config?.llm.apiKey),
        google: !!config?.providers?.google?.apiKey || (config?.llm.provider === "google" && !!config?.llm.apiKey),
        groq: !!config?.providers?.groq?.apiKey || (config?.llm.provider === "groq" && !!config?.llm.apiKey),
        ollama: config?.llm.provider === "ollama",
      };

      const providers = {
        anthropic: { configured: envFlags.anthropic || configFlags.anthropic },
        openai: { configured: envFlags.openai || configFlags.openai },
        google: { configured: envFlags.google || configFlags.google },
        groq: { configured: envFlags.groq || configFlags.groq },
        ollama: { configured: envFlags.ollama || configFlags.ollama },
      };

      const hasAnyKey =
        providers.anthropic.configured
        || providers.openai.configured
        || providers.google.configured
        || providers.groq.configured
        || providers.ollama.configured;

      res.json({
        hasAnyKey,
        activeProvider: config?.llm.provider ?? "anthropic",
        providers,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/llm/models", async (req, res) => {
    try {
      const rawProvider = typeof req.query.provider === "string" ? req.query.provider.trim().toLowerCase() : "";
      if (!rawProvider || !isLlmProvider(rawProvider)) {
        res.status(400).json({ error: "provider must be one of: anthropic, openai, google, groq, ollama" });
        return;
      }

      const config = await readEffectiveConfig(currentProject).catch(() => null);
      const apiKey = resolveProviderApiKey(rawProvider, config);
      const models = await fetchLiveModels(rawProvider, apiKey);

      res.json({
        provider: rawProvider,
        models,
        source: "live",
        count: models.length,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Project state ─────────────────────────────────────────────────────────

  app.get("/api/state", async (_req, res) => {
    if (!currentProject) {
      res.json({ initialized: false, projectRoot: null });
      return;
    }
    try {
      const projectRoot = currentProject;
      const state = new StateManager(projectRoot);

      if (!state.isInitialized()) {
        res.json({ initialized: false, projectRoot });
        return;
      }

      const config = await readEffectiveConfig(projectRoot);
      const context = await state.gatherContext();
      const decisions = await state.readDecisions();
      const completedTasks = await state.readCompletedTasks();
      const flows = await state.readFlows();
      const taskAgents = await state.readTaskAgents();

      let git = null;
      try {
        const gitOps = new GitOperations(projectRoot);
        if (await gitOps.isRepo()) {
          const branch = await gitOps.getCurrentBranch();
          const clean = !(await gitOps.hasChanges());
          const recentCommits = await gitOps.log(5);
          git = { branch, clean, recentCommits };
        }
      } catch { /* not a git repo */ }

      res.json({
        initialized: true,
        projectRoot,
        brief: context.brief,
        architecture: context.architecture,
        conventions: context.conventions,
        schema: context.schema,
        decisions,
        currentTasks: context.currentTasks,
        completedTasks,
        taskAgents,
        apiContracts: context.apiContracts,
        flows,
        config: {
          llm: { provider: config.llm.provider, models: config.llm.models },
          stack: config.stack,
        },
        git,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Config ────────────────────────────────────────────────────────────────

  app.get("/api/config", async (_req, res) => {
    try {
      const projectRoot = currentProject;
      const config = await readGlobalConfig();
      const MASK = "••••••••";
      const maskSensitive = (value?: string) => (value ? MASK : "");
      res.json({
        scope: "global",
        projectRoot,
        ...config,
        llm: { ...config.llm, apiKey: config.llm.apiKey ? MASK : undefined },
        providers: config.providers
          ? Object.fromEntries(
              Object.entries(config.providers).map(([name, p]) => [name, { apiKey: maskSensitive(p.apiKey) }]),
            )
          : {},
        mcp: {
          enabled: config.mcp?.enabled ?? false,
          servers: (config.mcp?.servers ?? []).map((server) => ({
            ...server,
            authorizationToken: maskSensitive(server.authorizationToken),
            headers: server.headers
              ? Object.fromEntries(
                  Object.entries(server.headers).map(([k, v]) => [k, maskSensitive(v)]),
                )
              : undefined,
          })),
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/config", async (req, res) => {
    try {
      const current = await readGlobalConfig();
      const updates = req.body as Partial<typeof current>;
      const MASK = "••••••••";

      const mergedProviders: { [k: string]: { apiKey?: string } } = { ...current.providers };
      if (updates.providers) {
        for (const [name, p] of Object.entries(updates.providers)) {
          if (p.apiKey && p.apiKey !== MASK) mergedProviders[name] = { apiKey: p.apiKey };
          else if (!p.apiKey) mergedProviders[name] = { apiKey: undefined };
        }
      }

      const mergedMcpServers = (() => {
        const incoming = updates.mcp?.servers;
        if (!incoming) return current.mcp?.servers ?? [];

        return incoming.map((server, i) => {
          const existing = current.mcp?.servers?.[i];

          const mergedHeaders = (() => {
            if (!server.headers) return existing?.headers;
            const mapped = Object.fromEntries(
              Object.entries(server.headers).map(([key, value]) => {
                if (value === MASK) return [key, existing?.headers?.[key] ?? ""];
                return [key, value];
              }),
            );
            const cleaned = Object.fromEntries(
              Object.entries(mapped).filter(([, value]) => String(value).trim() !== ""),
            );
            return Object.keys(cleaned).length > 0 ? cleaned : undefined;
          })();

          return {
            ...existing,
            ...server,
            authorizationToken:
              server.authorizationToken === MASK
                ? existing?.authorizationToken
                : (server.authorizationToken || undefined),
            headers: mergedHeaders,
          };
        });
      })();

      const nextConfig = {
        ...current,
        ...updates,
        llm: {
          ...current.llm, ...updates.llm,
          apiKey: updates.llm?.apiKey && updates.llm.apiKey !== MASK ? updates.llm.apiKey : current.llm.apiKey,
          models: { ...current.llm.models, ...updates.llm?.models },
        },
        providers: mergedProviders,
        mcp: {
          ...current.mcp,
          ...updates.mcp,
          servers: mergedMcpServers,
        },
        skills: {
          ...current.skills,
          ...updates.skills,
          paths: updates.skills?.paths ?? current.skills?.paths,
          maxChars: updates.skills?.maxChars ?? current.skills?.maxChars,
        },
        stack: { ...current.stack, ...updates.stack },
        deploy: { ...current.deploy, ...updates.deploy },
        test: { ...current.test, ...updates.test },
        reanalyze: { ...current.reanalyze, ...updates.reanalyze },
        logging: { ...current.logging, ...updates.logging },
      };

      await writeGlobalConfig(nextConfig);
      res.json({ ok: true, scope: "global" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── MCP Connectors (curated) ─────────────────────────────────────────────

  app.get("/api/mcp/connectors", async (_req, res) => {
    try {
      const config = await readGlobalConfig();
      const servers = config.mcp?.servers ?? [];
      const connectors = CURATED_MCP_CONNECTORS.map((def) => {
        const existing = servers.find((s) => s.id === def.id);
        const token = existing?.authorizationToken;
        return {
          ...def,
          enabled: existing?.enabled ?? false,
          configured: !!token,
          authorizationToken: token ? MASKED_VALUE : "",
        };
      });
      res.json({ connectors });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/mcp/connectors/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const def = CURATED_MCP_CONNECTORS.find((c) => c.id === id);
      if (!def) {
        return res.status(400).json({ error: `Unknown connector: ${id}` });
      }

      const body = req.body as { enabled?: boolean; authorizationToken?: string };
      const current = await readGlobalConfig();
      const servers = [...(current.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => s.id === id);
      const existing = idx >= 0 ? servers[idx] : undefined;

      const nextToken = (() => {
        if (typeof body.authorizationToken !== "string") return existing?.authorizationToken;
        const trimmed = body.authorizationToken.trim();
        if (!trimmed || trimmed === MASKED_VALUE) return existing?.authorizationToken;
        return trimmed;
      })();

      const nextEnabled = typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? false);
      const nextServer = {
        ...(existing ?? {}),
        id: def.id,
        name: def.name,
        url: def.url,
        description: def.description,
        enabled: nextEnabled,
        authorizationToken: nextToken,
      };

      if (idx >= 0) {
        servers[idx] = nextServer;
      } else {
        servers.push(nextServer);
      }

      const nextConfig = {
        ...current,
        mcp: {
          ...current.mcp,
          enabled: (current.mcp?.enabled ?? false) || nextEnabled,
          servers,
        },
      };

      await writeGlobalConfig(nextConfig);

      res.json({
        connector: {
          ...def,
          enabled: nextEnabled,
          configured: !!nextToken,
          authorizationToken: nextToken ? MASKED_VALUE : "",
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Git ───────────────────────────────────────────────────────────────────

  app.get("/api/git/repo", async (_req, res) => {
    try {
      const projectRoot = getProject();
      const gitOps = new GitOperations(projectRoot);
      const isRepo = await gitOps.isRepo();

      if (!isRepo) {
        res.json({
          isRepo: false,
          branch: null,
          clean: true,
          ahead: 0,
          behind: 0,
          staged: [],
          modified: [],
          deleted: [],
          untracked: [],
          remotes: [],
        });
        return;
      }

      try {
        const repo = await gitOps.getRepoState();
        res.json({ isRepo: true, ...repo });
      } catch (err) {
        const rawMessage = (err as Error).message;
        const message = rawMessage.includes("did not match the expected pattern")
          ? "Git metadata could not be parsed. Reinitialize Git to repair this repository."
          : rawMessage;
        const likelyNotRepo = /not a git repository/i.test(message);
        res.json({
          isRepo: !likelyNotRepo,
          branch: null,
          clean: false,
          ahead: 0,
          behind: 0,
          staged: [],
          modified: [],
          deleted: [],
          untracked: [],
          remotes: [],
          error: message,
        });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/init", async (_req, res) => {
    try {
      const { force } = (_req.body ?? {}) as { force?: boolean };
      const projectRoot = getProject();
      const gitOps = new GitOperations(projectRoot);
      await gitOps.init(!!force);
      const repo = await gitOps.getRepoState().catch(() => ({
        branch: null,
        clean: false,
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        deleted: [],
        untracked: [],
        remotes: [],
      }));
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/remote", async (req, res) => {
    try {
      const { name, url } = req.body as { name?: string; url?: string };
      const remoteName = (name ?? "origin").trim();
      const remoteUrl = (url ?? "").trim();
      if (!remoteName) { res.status(400).json({ error: "name is required" }); return; }
      if (!remoteUrl) { res.status(400).json({ error: "url is required" }); return; }

      const projectRoot = getProject();
      const gitOps = new GitOperations(projectRoot);
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }

      await gitOps.setRemote(remoteName, remoteUrl);
      const repo = await gitOps.getRepoState().catch(() => ({
        branch: null,
        clean: false,
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        deleted: [],
        untracked: [],
        remotes: [],
      }));
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/git/identity", async (_req, res) => {
    try {
      const projectRoot = getProject();
      const localName = await readGitConfigValue(projectRoot, "user.name", false);
      const localEmail = await readGitConfigValue(projectRoot, "user.email", false);
      const globalName = await readGitConfigValue(projectRoot, "user.name", true);
      const globalEmail = await readGitConfigValue(projectRoot, "user.email", true);
      const localHelper = await readGitConfigValue(projectRoot, "credential.helper", false);
      const globalHelper = await readGitConfigValue(projectRoot, "credential.helper", true);

      res.json({
        name: localName ?? globalName ?? "",
        email: localEmail ?? globalEmail ?? "",
        nameScope: localName ? "local" : globalName ? "global" : "unset",
        emailScope: localEmail ? "local" : globalEmail ? "global" : "unset",
        credentialHelper: localHelper ?? globalHelper ?? "",
        credentialHelperScope: localHelper ? "local" : globalHelper ? "global" : "unset",
        platform: osPlatform(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/identity", async (req, res) => {
    try {
      const { name, email, scope } = req.body as { name?: string; email?: string; scope?: "local" | "global" };
      const normalizedName = (name ?? "").trim();
      const normalizedEmail = (email ?? "").trim();
      const targetScope = scope === "global" ? "global" : "local";

      if (!normalizedName && !normalizedEmail) {
        res.status(400).json({ error: "name or email is required" });
        return;
      }

      const projectRoot = getProject();
      if (normalizedName) {
        await setGitConfigValue(projectRoot, "user.name", normalizedName, targetScope === "global");
      }
      if (normalizedEmail) {
        await setGitConfigValue(projectRoot, "user.email", normalizedEmail, targetScope === "global");
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/credential-helper", async (req, res) => {
    try {
      const { helper, scope } = req.body as { helper?: string; scope?: "local" | "global" };
      const targetScope = scope === "global" ? "global" : "local";
      const normalizedHelper = (helper ?? "").trim() || (
        osPlatform() === "darwin"
          ? "osxkeychain"
          : (osPlatform() === "win32" ? "manager-core" : "cache --timeout=7200")
      );

      await setGitConfigValue(getProject(), "credential.helper", normalizedHelper, targetScope === "global");
      res.json({ ok: true, helper: normalizedHelper, scope: targetScope });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/github-credential", async (req, res) => {
    try {
      const { username, token } = req.body as { username?: string; token?: string };
      const normalizedUsername = (username ?? "").trim();
      const normalizedToken = (token ?? "").trim();
      if (!normalizedUsername) {
        res.status(400).json({ error: "username is required" });
        return;
      }
      if (!normalizedToken) {
        res.status(400).json({ error: "token is required" });
        return;
      }

      const projectRoot = getProject();
      const helper = await readGitConfigValue(projectRoot, "credential.helper", false)
        ?? await readGitConfigValue(projectRoot, "credential.helper", true);
      if (!helper) {
        const fallbackHelper = osPlatform() === "darwin"
          ? "osxkeychain"
          : (osPlatform() === "win32" ? "manager-core" : "cache --timeout=7200");
        await setGitConfigValue(projectRoot, "credential.helper", fallbackHelper, false);
      }

      await approveGitHubCredential(projectRoot, normalizedUsername, normalizedToken);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/git/branches", async (_req, res) => {
    try {
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      const branches = await gitOps.getBranches().catch(() => ({ current: "", all: [] }));
      res.json(branches);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/checkout", async (req, res) => {
    try {
      const { branch, create } = req.body as { branch?: string; create?: boolean };
      const nextBranch = (branch ?? "").trim();
      if (!nextBranch) { res.status(400).json({ error: "branch is required" }); return; }
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      await gitOps.checkoutBranch(nextBranch, !!create);
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/stage", async (req, res) => {
    try {
      const { path, all } = req.body as { path?: string; all?: boolean };
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      if (all) await gitOps.stageAll();
      else if (path?.trim()) await gitOps.stageFile(path.trim());
      else { res.status(400).json({ error: "path or all required" }); return; }
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/unstage", async (req, res) => {
    try {
      const { path } = req.body as { path?: string };
      if (!path?.trim()) { res.status(400).json({ error: "path is required" }); return; }
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      await gitOps.unstageFile(path.trim());
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/discard", async (req, res) => {
    try {
      const { path } = req.body as { path?: string };
      if (!path?.trim()) { res.status(400).json({ error: "path is required" }); return; }
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      await gitOps.discardFile(path.trim());
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/commit", async (req, res) => {
    try {
      const { message } = req.body as { message?: string };
      const commitMessage = (message ?? "").trim();
      if (!commitMessage) { res.status(400).json({ error: "message is required" }); return; }
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      const hash = await gitOps.commitAll(commitMessage);
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, commit: hash, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/fetch", async (_req, res) => {
    try {
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      await gitOps.fetch();
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/pull", async (req, res) => {
    try {
      const { remote, branch } = req.body as { remote?: string; branch?: string };
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      await gitOps.pull((remote ?? "origin").trim() || "origin", branch?.trim() || undefined);
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/git/push", async (req, res) => {
    try {
      const { remote, branch } = req.body as { remote?: string; branch?: string };
      const gitOps = new GitOperations(getProject());
      if (!(await gitOps.isRepo())) { res.status(400).json({ error: "Not a git repository" }); return; }
      await gitOps.push((remote ?? "origin").trim() || "origin", branch?.trim() || undefined);
      const repo = await gitOps.getRepoState();
      res.json({ ok: true, ...repo });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/git/diff", async (req, res) => {
    try {
      const projectRoot = getProject();
      const gitOps = new GitOperations(projectRoot);
      if (!(await gitOps.isRepo())) { res.json({ diff: null }); return; }
      const commits = parseInt((req.query.commits as string) ?? "1", 10);
      const diff = await gitOps.getDiffRange(`HEAD~${commits}..HEAD`);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Structured log ────────────────────────────────────────────────────────

  app.get("/api/logs", async (req, res) => {
    try {
      const projectRoot = getProject();
      const logPath = join(projectRoot, ".bender", "bender.log");
      if (!existsSync(logPath)) return res.json({ entries: [] });

      const raw = await readFile(logPath, "utf-8");
      const limit = Math.min(500, parseInt((req.query.limit as string) ?? "200", 10) || 200);
      const entries = parseLogEntries(raw, limit);

      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/usage/session", async (_req, res) => {
    try {
      if (!currentProject) {
        return res.json({
          startedAt: new Date(SERVER_SESSION_STARTED_AT).toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          events: 0,
          lastUpdatedAt: null,
        });
      }

      const projectRoot = getProject();
      const logPath = join(projectRoot, ".bender", "bender.log");
      if (!existsSync(logPath)) {
        return res.json({
          startedAt: new Date(SERVER_SESSION_STARTED_AT).toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          events: 0,
          lastUpdatedAt: null,
        });
      }

      const raw = await readFile(logPath, "utf-8");
      const entries = parseLogEntries(raw);
      const usage = aggregateTokenUsage(entries, SERVER_SESSION_STARTED_AT);
      return res.json({
        startedAt: new Date(SERVER_SESSION_STARTED_AT).toISOString(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        events: usage.events,
        lastUpdatedAt: usage.lastTimestamp,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Terminal ──────────────────────────────────────────────────────────────

  app.post("/api/terminal/exec", async (req, res) => {
    const { command } = req.body as { command?: string };
    if (!command || !command.trim()) {
      return res.status(400).json({ error: "command is required" });
    }

    // Security: limit command length and reject dangerous patterns
    const trimmed = command.trim();
    if (trimmed.length > 512) {
      return res.status(400).json({ error: "command too long" });
    }

    let projectRoot: string;
    try {
      projectRoot = getProject();
    } catch {
      return res.status(400).json({ error: "No project selected" });
    }

    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(trimmed, {
        cwd: projectRoot,
        timeout: 30000, // 30s timeout
        maxBuffer: 512 * 1024, // 512KB output limit
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      res.json({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 });
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      res.json({
        stdout: (execErr.stdout ?? "").trimEnd(),
        stderr: (execErr.stderr ?? (err as Error).message).trimEnd(),
        exitCode: execErr.code ?? 1,
      });
    }
  });

  // ── Sessions ──────────────────────────────────────────────────────────────

  app.get("/api/sessions", async (_req, res) => {
    try {
      const projectRoot = getProject();
      const state = new StateManager(projectRoot);
      res.json(state.isInitialized() ? await state.readSessions() : []);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Task Agent Assignments ────────────────────────────────────────────────

  app.get("/api/tasks/agents", async (_req, res) => {
    if (!currentProject) {
      res.json({ assignments: {} });
      return;
    }
    try {
      const state = new StateManager(currentProject);
      if (!state.isInitialized()) {
        res.json({ assignments: {} });
        return;
      }
      const assignments = await state.readTaskAgents();
      res.json({ assignments });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/tasks/agents/:taskId", async (req, res) => {
    if (!currentProject) {
      res.status(400).json({ error: "No project selected" });
      return;
    }
    try {
      const { taskId } = req.params;
      const { agentId } = req.body as { agentId?: string | null };
      const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : null;
      const normalizedTaskId = taskId.trim();
      if (!normalizedTaskId || !/^\d+$/.test(normalizedTaskId)) {
        res.status(400).json({ error: "taskId must be numeric" });
        return;
      }

      if (normalizedAgentId) {
        const allAgents = await getAllAgents();
        const selected = allAgents.find((a) => a.id === normalizedAgentId);
        if (!selected) {
          res.status(400).json({ error: `Unknown agent: ${normalizedAgentId}` });
          return;
        }
        if (selected.baseRole !== "implementer") {
          res.status(400).json({ error: `Agent ${normalizedAgentId} is not an implementer agent` });
          return;
        }
      }

      const state = new StateManager(currentProject);
      if (!state.isInitialized()) {
        res.status(400).json({ error: "Project is not initialized" });
        return;
      }

      await state.setTaskAgent(normalizedTaskId, normalizedAgentId || null);
      const assignments = await state.readTaskAgents();
      res.json({ ok: true, assignments });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Run operations (SSE) ──────────────────────────────────────────────────

  app.post("/api/run/answer", (req, res) => {
    const { id, answer } = req.body as { id: string; answer: string };
    const resolver = pendingAnswers.get(id);
    if (resolver) { pendingAnswers.delete(id); resolver(answer); res.json({ ok: true }); }
    else res.status(404).json({ error: "No pending question with that id" });
  });

  app.post("/api/run/init", async (req, res) => {
    const {
      description,
      path: requestedPath,
      template,
      llmProvider,
      llmApiKey,
    } = req.body as {
      description?: string;
      path?: string;
      template?: "nextjs-saas" | "express-api" | "auto";
      llmProvider?: "anthropic" | "openai" | "google" | "groq" | "ollama";
      llmApiKey?: string;
    };

    await runOperation(res, async (adapter) => {
      let projectRoot: string;
      if (requestedPath?.trim()) {
        projectRoot = normalizeUserPath(requestedPath);
        if (!existsSync(projectRoot)) {
          await mkdir(projectRoot, { recursive: true });
        } else {
          const rootStat = await stat(projectRoot);
          if (!rootStat.isDirectory()) {
            throw new Error("Selected path is not a directory.");
          }
        }
      } else {
        projectRoot = getProject();
      }

      currentProject = projectRoot;

      const initialConfig = await readEffectiveConfig(projectRoot);
      let shouldWriteConfig = false;
      const nextConfig = {
        ...initialConfig,
        llm: { ...initialConfig.llm },
        providers: { ...(initialConfig.providers ?? {}) },
        stack: { ...initialConfig.stack },
      };

      if (template && template !== "auto") {
        nextConfig.stack.template = template;
        if (template === "nextjs-saas") {
          nextConfig.stack.framework = "next.js";
        } else if (template === "express-api") {
          nextConfig.stack.framework = "express";
        }
        shouldWriteConfig = true;
      }

      if (llmProvider) {
        nextConfig.llm.provider = llmProvider;
        if (llmApiKey?.trim() && llmProvider !== "ollama") {
          nextConfig.providers[llmProvider] = { apiKey: llmApiKey.trim() };
        }
        shouldWriteConfig = true;
      }

      if (shouldWriteConfig) {
        await writeConfig(projectRoot, nextConfig);
      }

      let firstPrompt = true;
      const originalPrompt = adapter.promptMultiline.bind(adapter);
      adapter.promptMultiline = async (q: string) => {
        if (firstPrompt && description) { firstPrompt = false; adapter.info(`> ${description}`); return description; }
        return originalPrompt(q);
      };
      await initCommand(projectRoot, adapter);
      await addToRegistry(projectRoot);
    });
  });

  app.post("/api/run/plan", async (req, res) => {
    const {
      feature,
      role,
      agentId,
      askClarifyingQuestions,
      requireArchitectureApproval,
      requirePlanApproval,
    } = req.body as {
      feature?: string;
      role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
      agentId?: string;
      askClarifyingQuestions?: boolean;
      requireArchitectureApproval?: boolean;
      requirePlanApproval?: boolean;
    };
    if (!feature) { res.status(400).json({ error: "feature is required" }); return; }
    await runOperation(res, (adapter) => planCommand(getProject(), feature, adapter, {
      role,
      agentId,
      askClarifyingQuestions,
      requireArchitectureApproval,
      requirePlanApproval,
    }));
  });

  app.post("/api/run/implement", async (req, res) => {
    const { taskId } = (req.body ?? {}) as { taskId?: number };
    if (taskId !== undefined) {
      await runOperation(res, (adapter) => implementSingleTask(getProject(), Number(taskId), adapter));
    } else {
      await runOperation(res, (adapter) => implementCommand(getProject(), adapter));
    }
  });

  app.post("/api/run/analyze", async (_req, res) => {
    await runOperation(res, (adapter) => analyzeCommand(getProject(), adapter));
  });

  app.post("/api/run/flows", async (_req, res) => {
    await runOperation(res, async (adapter) => {
      const projectRoot = getProject();
      const state = new StateManager(projectRoot);
      const context = await state.gatherContext();

      if (!context.brief || !context.architecture) {
        throw new Error("Project needs a brief and architecture before flows can be generated. Run init or analyze first.");
      }

      let models;
      let runtime;
      let architectTier: "fast" | "default" | "strong" = "default";
      let architectAgentName = "Architect";
      try {
        const config = await readEffectiveConfig(projectRoot);
        const logger = createLogger(
          "flows",
          projectRoot,
          makeAdapterSink(adapter),
          toLoggerOptions(config.logging),
        );
        models = createModelSet(config);
        const architectAgent = await getEffectiveAgentForRole("architect");
        architectTier = architectAgent.modelTier;
        architectAgentName = architectAgent.name;
        runtime = await createRoleRuntime(
          projectRoot,
          config,
          {
            role: "architect",
            pinnedSkills: architectAgent.pinnedSkills,
            mcpServerIds: architectAgent.mcpServerIds,
            modelTier: architectAgent.modelTier,
          },
          context.architecture ?? undefined,
          logger,
        );
      } catch (err: unknown) {
        throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
      }

      try {
        adapter.subheader("Generating user flow diagrams...");
        adapter.info(`Using agent: ${architectAgentName} (${architectTier})`);
        const flows = await generateFlows(
          getModelForTier(models, architectTier),
          context.brief,
          context.architecture,
          context.schema,
          adapter.streamWriter(),
          runtime,
        );

        await state.writeFlows(flows);
        adapter.success("Flow diagrams saved to .bender/flows.md");
      } finally {
        await runtime?.close();
      }
    });
  });

  // ── Audits ────────────────────────────────────────────────────────────────

  app.get("/api/audits", async (_req, res) => {
    try {
      const state = new StateManager(getProject());
      const [security, tests] = await Promise.all([
        state.readAudit("security"),
        state.readAudit("tests"),
      ]);
      res.json({ security, tests });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  async function runAudit(
    res: Response,
    auditType: "security" | "tests",
  ): Promise<void> {
    await runOperation(res, async (adapter) => {
      const projectRoot = getProject();
      const state = new StateManager(projectRoot);
      const context = await state.gatherContext();
      const label = auditType === "security" ? "Security audit" : "Test harness audit";

      adapter.header(`Bender ${label}`);

      if (!context.architecture) {
        throw new Error("Project needs architecture to be analyzed before auditing. Run analyze first.");
      }

      let runtime;
      try {
        const config = await readEffectiveConfig(projectRoot);
        const logger = createLogger(
          `audit:${auditType}`,
          projectRoot,
          makeAdapterSink(adapter),
          toLoggerOptions(config.logging),
        );
        const analyzerAgent = await getEffectiveAgentForRole("analyzer");
        runtime = await createRoleRuntime(
          projectRoot,
          config,
          {
            role: "analyzer",
            taskDescription: auditType === "security" ? "security audit vulnerability analysis" : "test harness coverage audit",
            pinnedSkills: analyzerAgent.pinnedSkills,
            mcpServerIds: analyzerAgent.mcpServerIds,
            modelTier: analyzerAgent.modelTier,
          },
          context.architecture ?? undefined,
          logger,
        );
      } catch (err: unknown) {
        throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
      }

      const roleName = auditType === "security" ? "security-auditor" : "test-auditor";

      try {
        adapter.subheader(`Running ${label}...`);
        const config = await readEffectiveConfig(projectRoot);
        const models = createModelSet(config);
        const analyzerAgent = await getEffectiveAgentForRole("analyzer");

        const systemContext = [
          context.architecture ? `## Architecture\n\n${context.architecture}` : "",
          context.schema ? `## Database Schema\n\n${context.schema}` : "",
          context.conventions ? `## Conventions\n\n${context.conventions}` : "",
        ].filter(Boolean).join("\n\n---\n\n");

        const userMessage = [
          `Audit this project's ${auditType === "security" ? "security vulnerabilities" : "test coverage and quality"}.`,
          "",
          "## Project Context",
          systemContext,
        ].join("\n");

        adapter.info(`Analyzing with ${analyzerAgent.name} (${analyzerAgent.modelTier})...`);
        const spin = adapter.spinner("Running LLM audit...");

        const model = getModelForTier(models, analyzerAgent.modelTier);
        let rawOutput = "";
        try {
          rawOutput = await runRole(
            model,
            roleName,
            systemContext,
            userMessage,
            runtime ?? undefined,
          );
        } catch (err) {
          spin.fail("LLM audit failed");
          throw err;
        }

        // Parse JSON from output (strip markdown fences if present)
        let jsonStr = rawOutput.trim();
        if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        }

        let parsed: { summary?: string; coverageEstimate?: string; issues?: AuditIssue[] };
        try {
          parsed = JSON.parse(jsonStr) as typeof parsed;
        } catch {
          spin.fail("Audit response parse failed");
          throw new Error("Audit returned invalid JSON. Try again.");
        }
        spin.succeed("LLM audit complete");

        const result: AuditResult = {
          type: auditType,
          runAt: Date.now(),
          summary: parsed.summary ?? "",
          coverageEstimate: parsed.coverageEstimate,
          issues: (parsed.issues ?? []).map((issue, i) => ({
            id: issue.id ?? `${auditType.toUpperCase().slice(0, 3)}-${String(i + 1).padStart(3, "0")}`,
            title: issue.title ?? "Untitled issue",
            severity: issue.severity ?? "medium",
            category: issue.category ?? "other",
            description: issue.description ?? "",
            recommendation: issue.recommendation ?? "",
            files: issue.files ?? [],
          })),
        };

        await state.writeAudit(auditType, result);
        if (result.summary) {
          adapter.info(`Summary: ${result.summary}`);
        }
        if (result.coverageEstimate) {
          adapter.info(`Coverage estimate: ${result.coverageEstimate}`);
        }
        const severityCounts = result.issues.reduce(
          (acc, issue) => {
            acc[issue.severity] += 1;
            return acc;
          },
          { low: 0, medium: 0, high: 0, critical: 0 } as Record<AuditIssue["severity"], number>,
        );
        adapter.info(
          `Severity counts: critical ${severityCounts.critical}, high ${severityCounts.high}, medium ${severityCounts.medium}, low ${severityCounts.low}`,
        );
        if (result.issues.length > 0) {
          adapter.subheader("Top findings");
          for (const issue of result.issues.slice(0, 8)) {
            const issueFiles = issue.files ?? [];
            const files = issueFiles.length > 0 ? ` [${issueFiles.join(", ")}]` : "";
            adapter.warn(`${issue.severity.toUpperCase()}: ${issue.title}${files}`);
          }
        } else {
          adapter.success("No issues reported by this audit.");
        }
        adapter.success(`${label} complete — ${result.issues.length} issue(s) found.`);
      } finally {
        await runtime?.close();
      }
    });
  }

  app.post("/api/run/audit/security", async (_req, res) => {
    await runAudit(res, "security");
  });

  app.post("/api/run/audit/tests", async (_req, res) => {
    await runAudit(res, "tests");
  });

  // ── Append task from audit issue ──────────────────────────────────────────

  app.post("/api/tasks/append", async (req, res) => {
    try {
      const { title, description } = req.body as { title?: string; description?: string };
      if (!title) {
        return res.status(400).json({ error: "title is required" });
      }
      const state = new StateManager(getProject());
      const existing = await state.readCurrentTasks();
      const taskId = `task-${randomUUID().slice(0, 8)}`;
      const newEntry = `\n## ${title}\n\nID: ${taskId}\nStatus: pending\n\n${description ?? ""}\n`;
      const updated = (existing ?? "") + newEntry;
      await state.writeCurrentTasks(updated.trim());
      res.json({ ok: true, taskId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  function parseDependencyIds(depStr: string): number[] {
    if (!depStr || depStr.trim().toLowerCase() === "none") return [];
    const matches = depStr.match(/\d+/g);
    return matches ? matches.map(Number) : [];
  }

  interface ParsedTaskBlock {
    id: number;
    title: string;
    body: string;
    start: number;
    end: number;
    dependencies: string;
  }

  function parseTaskBlocks(markdown: string): ParsedTaskBlock[] {
    const tasks: ParsedTaskBlock[] = [];
    const pattern = /###\s*Task\s*(\d+):\s*(.+?)\n([\s\S]*?)(?=\n###\s*Task|\n##\s|$)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
      const body = match[3];
      const depsMatch = body.match(/\*\*Dependencies\*\*:\s*(.+)/);
      tasks.push({
        id: Number(match[1]),
        title: match[2].trim(),
        body,
        start: match.index,
        end: match.index + match[0].length,
        dependencies: depsMatch ? depsMatch[1].trim() : "None",
      });
    }
    return tasks;
  }

  function replaceTaskBodyField(body: string, label: string, value: string): string {
    const fieldPattern = new RegExp(`(\\*\\*${label}\\*\\*:\\s*)([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n###|$)`);
    if (fieldPattern.test(body)) {
      return body.replace(fieldPattern, `$1${value}`);
    }
    const trimmed = body.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n` : "";
    return `${prefix}- **${label}**: ${value}\n`;
  }

  app.patch("/api/tasks/:taskId", async (req, res) => {
    try {
      const { taskId } = req.params;
      const id = Number(taskId);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "taskId must be numeric" });
      }
      const { title, description, dependencies, criteria } = (req.body ?? {}) as {
        title?: string;
        description?: string;
        dependencies?: string;
        criteria?: string;
      };

      if (title === undefined && description === undefined && dependencies === undefined && criteria === undefined) {
        return res.status(400).json({ error: "No task fields provided" });
      }

      const state = new StateManager(getProject());
      const markdown = await state.readCurrentTasks();
      if (!markdown) {
        return res.status(400).json({ error: "No current task plan found" });
      }

      const tasks = parseTaskBlocks(markdown);
      const target = tasks.find((t) => t.id === id);
      if (!target) {
        return res.status(404).json({ error: `Task ${id} not found` });
      }

      const nextTitle = title !== undefined ? title.trim() : target.title;
      let nextBody = target.body;
      if (description !== undefined) nextBody = replaceTaskBodyField(nextBody, "Description", description.trim());
      if (dependencies !== undefined) nextBody = replaceTaskBodyField(nextBody, "Dependencies", dependencies.trim() || "None");
      if (criteria !== undefined) nextBody = replaceTaskBodyField(nextBody, "Acceptance criteria", criteria.trim());

      const updatedBlock = `### Task ${id}: ${nextTitle}\n${nextBody}`;
      const updated = `${markdown.slice(0, target.start)}${updatedBlock}${markdown.slice(target.end)}`;
      await state.writeCurrentTasks(updated.trim());
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/tasks/:taskId", async (req, res) => {
    try {
      const { taskId } = req.params;
      const id = Number(taskId);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "taskId must be numeric" });
      }
      const { cascadeDependents } = (req.body ?? {}) as { cascadeDependents?: boolean };

      const state = new StateManager(getProject());
      const markdown = await state.readCurrentTasks();
      if (!markdown) {
        return res.status(400).json({ error: "No current task plan found" });
      }

      const tasks = parseTaskBlocks(markdown);
      const target = tasks.find((t) => t.id === id);
      if (!target) {
        return res.status(404).json({ error: `Task ${id} not found` });
      }

      const idsToDelete = new Set<number>([id]);
      if (cascadeDependents) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const task of tasks) {
            if (idsToDelete.has(task.id)) continue;
            const deps = parseDependencyIds(task.dependencies);
            if (deps.some((depId) => idsToDelete.has(depId))) {
              idsToDelete.add(task.id);
              changed = true;
            }
          }
        }
      }

      let updated = markdown;
      for (const task of tasks.filter((t) => idsToDelete.has(t.id)).sort((a, b) => b.start - a.start)) {
        updated = `${updated.slice(0, task.start)}${updated.slice(task.end)}`;
      }
      await state.writeCurrentTasks(updated.trim());

      const taskAgents = await state.readTaskAgents();
      let changedAssignments = false;
      for (const deletedId of idsToDelete) {
        const key = String(deletedId);
        if (taskAgents[key]) {
          delete taskAgents[key];
          changedAssignments = true;
        }
      }
      if (changedAssignments) {
        await state.writeTaskAgents(taskAgents);
      }

      res.json({ ok: true, deletedTaskIds: Array.from(idsToDelete).sort((a, b) => a - b) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Skills registry ───────────────────────────────────────────────────────

  app.get("/api/skills/registry", async (_req, res) => {
    try {
      const registry = await readSkillsRegistry();
      if (!registry) {
        return res.json({ skills: [], fetchedAt: null, needsRefresh: true });
      }
      res.json({ skills: registry.skills, fetchedAt: registry.fetchedAt, needsRefresh: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/skills/refresh", async (_req, res) => {
    try {
      const registry = await fetchRegistry(true);
      res.json({ skills: registry.skills, fetchedAt: registry.fetchedAt });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Agents ────────────────────────────────────────────────────────────────

  app.get("/api/agents", async (_req, res) => {
    try {
      const agents = await getAllAgents();
      res.json({ agents });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/agents/selection", async (_req, res) => {
    try {
      const selectedByRole = await readRoleSelections();
      res.json({ selectedByRole });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/agents/selection/:role", async (req, res) => {
    try {
      const role = req.params.role;
      if (!isBaseRole(role)) {
        return res.status(400).json({ error: `Invalid role: ${role}` });
      }

      const { agentId } = req.body as { agentId?: string | null };
      const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";

      if (normalizedAgentId) {
        const allAgents = await getAllAgents();
        const agent = allAgents.find((a) => a.id === normalizedAgentId);
        if (!agent) {
          return res.status(400).json({ error: `Unknown agent: ${normalizedAgentId}` });
        }
        if (agent.baseRole !== role) {
          return res.status(400).json({ error: `Agent ${normalizedAgentId} cannot be assigned to role ${role}` });
        }
      }

      await writeRoleSelection(role, normalizedAgentId || null);
      const selectedByRole = await readRoleSelections();
      res.json({ ok: true, selectedByRole });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/agents/prompt-snippets", async (_req, res) => {
    try {
      const snippets: Partial<Record<BaseRole, string>> = {};
      for (const role of BASE_ROLES) {
        try {
          const prompt = await loadPrompt(role);
          snippets[role] = toPromptSnippet(prompt);
        } catch {
          // Skip missing prompt for this role; frontend will show fallback.
        }
      }
      res.json({ snippets });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      const normalized = normalizeAgentCreatePayload(req.body as Partial<AgentConfig>);
      if (normalized.error || !normalized.value) {
        return res.status(400).json({ error: normalized.error ?? "Invalid agent payload" });
      }
      const agent = normalized.value;
      if (BUILTIN_AGENTS.some((a) => a.id === agent.id)) {
        return res.status(400).json({ error: "Cannot override a builtin agent ID" });
      }
      const custom = await readCustomAgents();
      const existing = custom.findIndex((a) => a.id === agent.id);
      if (existing >= 0) {
        custom[existing] = agent;
      } else {
        custom.push(agent);
      }
      await writeCustomAgents(custom);
      res.json({ agent });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/agents/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (BUILTIN_AGENTS.some((a) => a.id === id)) {
        return res.status(400).json({ error: "Cannot edit builtin agents" });
      }
      const patch = req.body as Partial<AgentConfig>;
      const custom = await readCustomAgents();
      const idx = custom.findIndex((a) => a.id === id);
      if (idx < 0) return res.status(404).json({ error: "Agent not found" });
      const normalized = normalizeAgentPatchPayload(custom[idx], patch);
      if (normalized.error || !normalized.value) {
        return res.status(400).json({ error: normalized.error ?? "Invalid agent payload" });
      }
      custom[idx] = { ...normalized.value, id, isBuiltin: false };
      await writeCustomAgents(custom);
      res.json({ agent: custom[idx] });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (BUILTIN_AGENTS.some((a) => a.id === id)) {
        return res.status(400).json({ error: "Cannot delete builtin agents" });
      }
      const custom = await readCustomAgents();
      const filtered = custom.filter((a) => a.id !== id);
      if (filtered.length === custom.length) {
        return res.status(404).json({ error: "Agent not found" });
      }
      await writeCustomAgents(filtered);
      const selectedByRole = await readRoleSelections();
      for (const role of BASE_ROLES) {
        if (selectedByRole[role] === id) {
          await writeRoleSelection(role, null);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────

  app.get("/{*path}", (_req, res) => {
    const indexPath = join(webDistDir, "index.html");
    if (existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send("Web UI not built. Run: npm run build:web");
  });

  return await new Promise<HttpServer>((resolvePromise, rejectPromise) => {
    const server = app.listen(API_PORT, () => resolvePromise(server));
    server.once("error", rejectPromise);
  });
}
