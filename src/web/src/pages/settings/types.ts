// Shared types for SettingsView and its section components.

export type ConfigScope = "global" | "project";
export type ModelTier = "fast" | "default" | "strong";

export interface TierModelConfig {
  provider: string;
  model: string;
}

export const MODEL_TIERS: ModelTier[] = ["fast", "default", "strong"];

export const PROVIDERS = ["anthropic", "openai", "google", "groq", "ollama", "local"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface FullConfig {
  llm: {
    provider: string;
    apiKey?: string;
    models: {
      fast: string | TierModelConfig;
      default: string | TierModelConfig;
      strong: string | TierModelConfig;
    };
  };
  providers: {
    [name: string]: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      supportsTools?: boolean;
      supportsJson?: boolean;
      supportsStreaming?: boolean;
      modelCapabilities?: Record<string, OpenAiCompatibleModelCapabilities>;
    };
  };
  mcp?: {
    enabled?: boolean;
    servers?: Array<{
      id?: string;
      name: string;
      url: string;
      enabled?: boolean;
      description?: string;
      authorizationToken?: string;
    }>;
  };
  skills?: {
    enabled?: boolean;
    enabledSkills?: string[];
    paths?: string[];
    maxChars?: number;
  };
  ui?: {
    themeId?: string;
  };
  stack: { template: string; framework: string; database: string; orm: string; auth: string; styling: string; language: string };
  deploy: { target?: string };
  test: { command?: string };
  reanalyze?: { enabled?: boolean; threshold?: number };
  logging?: {
    enabled?: boolean;
    level?: "debug" | "info" | "warn" | "error";
    consoleLevel?: "none" | "debug" | "info" | "warn" | "error";
  };
}

export interface ConfigResponse extends FullConfig {
  scope?: ConfigScope;
  projectRoot?: string | null;
}

export type ThemeAppearance = "dark" | "light";
export type ThemeSource = "builtin" | "global" | "project";

export interface ThemePreview {
  appBg: string;
  panelBg: string;
  textPrimary: string;
  accent: string;
  success: string;
  danger: string;
}

export interface ThemeSummary {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  description?: string;
  author?: string;
  source: ThemeSource;
  isActive?: boolean;
  preview?: ThemePreview;
}

export interface ThemeListResponse {
  themes: ThemeSummary[];
  activeThemeId: string;
}

export interface LlmStatus {
  hasAnyKey: boolean;
  activeProvider: string;
  providers: Record<string, { configured: boolean }>;
}

export interface OpenAiCompatibleModelCapabilities {
  supportsTools: boolean;
  supportsJson: boolean;
  supportsStreaming: boolean;
  endpoint?: string;
  apiStyle?: "chat" | "responses" | "auto";
  errors?: string[];
}

export interface GitHubAuthStatus {
  configured: boolean;
  connected: boolean;
  login?: string;
  message?: string;
  authMode?: string;
}

export interface GitHubAuthConfig {
  clientId: string;
  clientSecretSet: boolean;
  redirectUri: string;
  usingEnvClientId: boolean;
  usingEnvClientSecret: boolean;
  storedClientId: string;
}

export interface GitHubDeviceFlowStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}

export interface GitHubDeviceFlowPoll {
  status: "pending" | "connected" | "expired" | "denied";
  intervalSec?: number;
  login?: string;
}

export interface CuratedMcpServer {
  id: string;
  name: string;
  url: string;
  description: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  docsUrl: string;
}

export const CURATED_MCP_SERVERS: CuratedMcpServer[] = [
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    description: "Repository management, file operations, pull requests, and issues.",
    tokenLabel: "GitHub Personal Access Token",
    tokenPlaceholder: "ghp_...",
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "figma",
    name: "Figma",
    url: "https://mcp.figma.com/mcp",
    description: "Access Figma designs, generate code from components, and read design tokens.",
    tokenLabel: "Figma API Key",
    tokenPlaceholder: "figd_...",
    docsUrl: "https://help.figma.com/hc/en-us/articles/32132100833559",
  },
  {
    id: "neon",
    name: "Neon (Postgres)",
    url: "https://mcp.neon.tech/mcp",
    description: "Query and manage Neon Postgres databases, inspect schemas, run migrations.",
    tokenLabel: "Neon API Key",
    tokenPlaceholder: "neon_...",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://mcp.vercel.com",
    description: "Deploy projects, manage environments, inspect deployment logs.",
    tokenLabel: "Vercel API Token",
    tokenPlaceholder: "vercel_token_...",
    docsUrl: "https://vercel.com/docs/mcp",
  },
];

export interface ConnectorStatus {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  authValid: boolean;
  discoveredCapabilities: string[];
  lastCheckedAt: string;
  error?: string;
}

export const PROVIDER_MODEL_HINTS: Record<string, { fast: string; default: string; strong: string }> = {
  anthropic: { fast: "claude-haiku-4-5-20251001", default: "claude-sonnet-4-6-20250514", strong: "claude-opus-4-6-20250514" },
  openai: { fast: "gpt-4o-mini", default: "gpt-4o", strong: "gpt-4.1" },
  google: { fast: "gemini-2.0-flash", default: "gemini-2.5-pro", strong: "gemini-2.5-pro" },
  groq: { fast: "llama-3.3-70b-versatile", default: "llama-3.3-70b-versatile", strong: "llama-3.3-70b-versatile" },
  ollama: { fast: "llama3.2", default: "llama3.1:70b", strong: "llama3.1:70b" },
  "local": { fast: "local-model", default: "local-model", strong: "local-model" },
};

export const PROVIDER_MODEL_OPTIONS: Record<string, string[]> = {
  anthropic: [
    "claude-opus-4-6-20250514",
    "claude-sonnet-4-6-20250514",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-4.1-nano",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
  ],
  google: [
    "gemini-2.5-pro",
    "gemini-2.0-flash",
  ],
  groq: [
    "llama-3.3-70b-versatile",
  ],
  ollama: [
    "llama3.1:70b",
    "llama3.2",
  ],
  "local": [
    "local-model",
  ],
};
