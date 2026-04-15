import type { Express } from "express";
import { readGlobalConfig, writeGlobalConfig } from "../../state/config.js";

interface CuratedMcpServerDefinition {
  id: string;
  name: string;
  url: string;
  description: string;
}

interface ConnectorHealthStatus {
  id: string;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  authValid: boolean;
  discoveredCapabilities: string[];
  lastCheckedAt: string;
  error?: string;
}

interface ConnectorsRouteDeps {
  curatedConnectors: CuratedMcpServerDefinition[];
  getConnectorHealthStatus: (
    def: CuratedMcpServerDefinition,
    existing: { enabled?: boolean; authorizationToken?: string } | undefined,
    forceRefresh: boolean,
  ) => Promise<ConnectorHealthStatus>;
  clearConnectorHealthCache: (id: string) => void;
}

const MASKED_VALUE = "••••••••";

export function registerConnectorRoutes(app: Express, deps: ConnectorsRouteDeps): void {
  app.get("/api/mcp/connectors", async (_req, res) => {
    try {
      const cfg = await readGlobalConfig();
      const servers = cfg.mcp?.servers ?? [];
      const connectors = deps.curatedConnectors.map((def) => {
        const existing = servers.find((s) => (s.id ?? "").trim() === def.id) ?? null;
        return {
          ...def,
          enabled: existing?.enabled ?? false,
          configured: !!existing?.authorizationToken,
          authorizationToken: existing?.authorizationToken ? MASKED_VALUE : "",
        };
      });
      res.json({ connectors });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connectors/status", async (req, res) => {
    try {
      const force = String(req.query.force ?? req.query.refresh ?? "").toLowerCase() === "true";
      const cfg = await readGlobalConfig();
      const servers = cfg.mcp?.servers ?? [];
      const statuses = await Promise.all(
        deps.curatedConnectors.map(async (def) => {
          const existing = servers.find((s) => (s.id ?? "").trim() === def.id);
          return await deps.getConnectorHealthStatus(def, existing, force);
        }),
      );
      res.json({ statuses });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/mcp/connectors/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    const def = deps.curatedConnectors.find((c) => c.id === id);
    if (!def) {
      res.status(404).json({ error: `Unknown connector: ${id}` });
      return;
    }

    try {
      const body = req.body as {
        enabled?: boolean;
        authorizationToken?: string;
      };

      const current = await readGlobalConfig();
      const servers = [...(current.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => (s.id ?? "").trim() === id);
      const existing = idx >= 0 ? servers[idx] : null;

      const hasEnabled = Object.prototype.hasOwnProperty.call(body, "enabled");
      const hasToken = Object.prototype.hasOwnProperty.call(body, "authorizationToken");

      const nextEnabled = hasEnabled ? !!body.enabled : (existing?.enabled ?? false);
      const nextToken = hasToken
        ? (() => {
          const trimmed = (body.authorizationToken ?? "").trim();
          if (!trimmed || trimmed === MASKED_VALUE) return existing?.authorizationToken;
          return trimmed;
        })()
        : existing?.authorizationToken;

      const nextServer = {
        id,
        name: def.name,
        url: def.url,
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
      deps.clearConnectorHealthCache(id);

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
}
