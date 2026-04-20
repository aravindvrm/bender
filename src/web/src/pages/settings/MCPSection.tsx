import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { TextInput, SectionHeader } from "./shared";
import type { FullConfig, CuratedMcpServer, ConnectorStatus } from "./types";
import { CURATED_MCP_SERVERS } from "./types";

interface MCPSectionProps {
  config: FullConfig;
  setConfig: React.Dispatch<React.SetStateAction<FullConfig | null>>;
}

export function MCPSection({ config, setConfig }: MCPSectionProps) {
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [connectorExpanded, setConnectorExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadConnectorStatuses();
  }, []);

  async function loadConnectorStatuses(force = false) {
    setConnectorsLoading(true);
    setConnectorsError(null);
    try {
      const q = force ? "?force=true" : "";
      const res = await fetch(`/api/connectors/status${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load connector status");
      const byId: Record<string, ConnectorStatus> = {};
      for (const status of (data.statuses ?? []) as ConnectorStatus[]) {
        byId[status.id] = status;
      }
      setConnectorStatuses(byId);
    } catch (err) {
      setConnectorsError((err as Error).message);
    } finally {
      setConnectorsLoading(false);
    }
  }

  function toggleConnectorExpanded(id: string) {
    setConnectorExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function getMcpServerEntry(id: string) {
    return (config.mcp?.servers ?? []).find((s) => s.id === id);
  }

  function setMcpServerEnabled(id: string, def: CuratedMcpServer, enabled: boolean) {
    setConfig((c) => {
      if (!c) return c;
      const servers = [...(c.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => s.id === id);
      if (idx >= 0) {
        servers[idx] = { ...servers[idx], enabled };
      } else {
        servers.push({ id, name: def.name, url: def.url, description: def.description, enabled, authorizationToken: "" });
      }
      return { ...c, mcp: { ...c.mcp, servers } };
    });
  }

  function setMcpServerToken(id: string, def: CuratedMcpServer, token: string) {
    setConfig((c) => {
      if (!c) return c;
      const servers = [...(c.mcp?.servers ?? [])];
      const idx = servers.findIndex((s) => s.id === id);
      if (idx >= 0) {
        servers[idx] = { ...servers[idx], authorizationToken: token };
      } else {
        servers.push({ id, name: def.name, url: def.url, description: def.description, enabled: false, authorizationToken: token });
      }
      return { ...c, mcp: { ...c.mcp, servers } };
    });
  }

  return (
    <section>
      <SectionHeader
        title="MCP Connectors"
        description="Configure curated connectors and review runtime health/capabilities in one place."
      />
      <div className="space-y-2">
        {CURATED_MCP_SERVERS.map((connector) => {
          const status = connectorStatuses[connector.id];
          const entry = getMcpServerEntry(connector.id);
          const expanded = !!connectorExpanded[connector.id];
          return (
            <div key={connector.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-3 space-y-2">
              <button
                type="button"
                onClick={() => toggleConnectorExpanded(connector.id)}
                className="w-full flex items-center gap-2 text-left"
              >
                <span className="text-sm text-zinc-300">{connector.name}</span>
                <span className="text-[10px] text-zinc-500 font-mono">{connector.url}</span>
                <span className="ml-auto text-[10px] text-zinc-600">
                  {status?.lastCheckedAt
                    ? `checked ${new Date(status.lastCheckedAt).toLocaleTimeString()}`
                    : "not checked"}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className={`px-1.5 py-0.5 rounded border ${status?.enabled ? "text-emerald-300 border-emerald-800/60" : "text-zinc-500 border-zinc-700"}`}>
                  {status?.enabled ? "enabled" : "disabled"}
                </span>
                <span className={`px-1.5 py-0.5 rounded border ${status?.configured ? "text-zinc-300 border-zinc-700" : "text-zinc-500 border-zinc-700"}`}>
                  {status?.configured ? "configured" : "no token"}
                </span>
                <span className={`px-1.5 py-0.5 rounded border ${status?.reachable ? "text-emerald-300 border-emerald-800/60" : "text-amber-300 border-amber-800/60"}`}>
                  {status?.reachable ? "reachable" : "unreachable"}
                </span>
                <span className={`px-1.5 py-0.5 rounded border ${status?.authValid ? "text-emerald-300 border-emerald-800/60" : "text-amber-300 border-amber-800/60"}`}>
                  {status?.authValid ? "auth valid" : "auth unknown/invalid"}
                </span>
              </div>
              {expanded && (
                <div className="space-y-2 pt-1 border-t border-zinc-800">
                  <p className="text-xs text-zinc-600">{connector.description}</p>
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <input
                      type="checkbox"
                      checked={entry?.enabled ?? false}
                      onChange={(e) => setMcpServerEnabled(connector.id, connector, e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-zinc-100 focus:ring-zinc-500"
                    />
                    <span>Enable connector</span>
                  </label>
                  <TextInput
                    value={entry?.authorizationToken ?? ""}
                    onChange={(v) => setMcpServerToken(connector.id, connector, v)}
                    placeholder={connector.tokenPlaceholder}
                    password
                    mono
                  />
                  <p className="text-[11px] text-zinc-500">
                    {connector.tokenLabel}
                    {" · "}
                    <a
                      href={connector.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-2"
                    >
                      docs
                    </a>
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {(status?.discoveredCapabilities ?? []).join(", ") || "No capabilities discovered"}
                  </p>
                  {status?.error && (
                    <p className="text-[11px] text-amber-400">{status.error}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => void loadConnectorStatuses(true)}
            disabled={connectorsLoading}
            className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {connectorsLoading ? "Refreshing..." : "Refresh connector checks"}
          </button>
          {connectorsError && <span className="text-xs text-red-400">{connectorsError}</span>}
        </div>
      </div>
    </section>
  );
}
