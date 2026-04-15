import { getConnectorCapabilities } from "../../state/capabilities.js";

export interface CuratedMcpServerDefinition {
  id: string;
  name: string;
  url: string;
  description: string;
}

export interface ConnectorHealthStatus {
  id: string;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  authValid: boolean;
  discoveredCapabilities: string[];
  lastCheckedAt: string;
  error?: string;
}

const CONNECTOR_HEALTH_TTL_MS = 60_000;

async function probeConnectorReachability(
  url: string,
  token?: string,
): Promise<{ reachable: boolean; authValid: boolean; error?: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 4000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: ctrl.signal,
    });
    return {
      reachable: true,
      authValid: response.status !== 401 && response.status !== 403,
    };
  } catch (err) {
    return {
      reachable: false,
      authValid: false,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createConnectorHealthManager() {
  const cache = new Map<string, ConnectorHealthStatus>();

  async function getConnectorHealthStatus(
    def: CuratedMcpServerDefinition,
    existing: { enabled?: boolean; authorizationToken?: string } | undefined,
    forceRefresh: boolean,
  ): Promise<ConnectorHealthStatus> {
    const cached = cache.get(def.id);
    const cachedAge = cached ? Date.now() - Date.parse(cached.lastCheckedAt) : Number.POSITIVE_INFINITY;
    if (!forceRefresh && cached && Number.isFinite(cachedAge) && cachedAge <= CONNECTOR_HEALTH_TTL_MS) {
      return cached;
    }

    const enabled = existing?.enabled ?? false;
    const token = existing?.authorizationToken?.trim();
    const configured = !!token;
    let reachable = false;
    let authValid = false;
    let error: string | undefined;

    if (enabled) {
      const probe = await probeConnectorReachability(def.url, token);
      reachable = probe.reachable;
      authValid = configured ? probe.authValid : false;
      error = probe.error;
    }

    const status: ConnectorHealthStatus = {
      id: def.id,
      enabled,
      configured,
      reachable,
      authValid,
      discoveredCapabilities: getConnectorCapabilities(def.id),
      lastCheckedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    cache.set(def.id, status);
    return status;
  }

  function clearConnectorHealthCache(id: string): void {
    cache.delete(id);
  }

  return {
    getConnectorHealthStatus,
    clearConnectorHealthCache,
  };
}

export const CURATED_MCP_CONNECTORS: CuratedMcpServerDefinition[] = [
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

