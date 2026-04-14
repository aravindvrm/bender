import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LoadingDots } from "../components/LoadingDots";

type BaseRole = "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
type ModelTier = "fast" | "default" | "strong";
type CapabilityId =
  | "github.repo.read"
  | "github.repo.write"
  | "github.issue.read"
  | "github.issue.write"
  | "github.pr.read"
  | "github.pr.comment"
  | "github.branch.manage"
  | "github.clone"
  | `connector.${string}.use`;

interface CapabilityPolicy {
  allow?: CapabilityId[];
  deny?: CapabilityId[];
}

interface AgentConfig {
  id: string;
  name: string;
  baseRole: BaseRole;
  modelTier: ModelTier;
  pinnedSkills: string[];
  mcpServerIds: string[];
  capabilityPolicy?: CapabilityPolicy;
  systemPromptAddition?: string;
  isBuiltin?: boolean;
}

interface SkillMeta {
  name: string;
  description: string;
  size: number;
}

interface McpConnector {
  id: string;
  name: string;
  url: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  authorizationToken: string;
}

interface ConnectorStatus {
  id: string;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  authValid: boolean;
  discoveredCapabilities: string[];
  lastCheckedAt: string;
  error?: string;
}

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS: ModelTier[] = ["fast", "default", "strong"];
const MAX_PINNED_SKILLS_PER_AGENT = 6;
const MAX_MCP_SERVERS_PER_AGENT = 6;
const CAPABILITY_CHOICES: Array<{ id: CapabilityId; label: string }> = [
  { id: "connector.github.use", label: "GitHub Connector" },
  { id: "github.repo.read", label: "Read Repos" },
  { id: "github.repo.write", label: "Write Repos" },
  { id: "github.issue.read", label: "Read Issues" },
  { id: "github.issue.write", label: "Write Issues" },
  { id: "github.pr.read", label: "Read PRs" },
  { id: "github.pr.comment", label: "Comment on PRs" },
  { id: "github.branch.manage", label: "Manage Branches" },
  { id: "github.clone", label: "Clone Repos" },
  { id: "connector.figma.use", label: "Figma Connector" },
  { id: "connector.neon.use", label: "Neon Connector" },
  { id: "connector.vercel.use", label: "Vercel Connector" },
];

const CAPABILITY_LABELS = new Map<CapabilityId, string>(CAPABILITY_CHOICES.map((c) => [c.id, c.label]));

function fallbackCapabilityLabel(id: string): string {
  return id
    .replace(/^connector\./, "")
    .replace(/^github\./, "GitHub ")
    .replace(/\.use$/, " connector")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function explainConnectorAvailability(
  connector: McpConnector,
  status: ConnectorStatus | undefined,
  allowedCapabilities: Set<string>,
): string | null {
  if (!connector.enabled) return "Disabled globally in connector settings.";
  if (!connector.configured) return "Missing API token/configuration.";
  if (!allowedCapabilities.has(`connector.${connector.id}.use`)) return "Agent policy does not allow this connector capability.";
  if (status && !status.reachable) return "Connector endpoint is not reachable.";
  if (status && !status.authValid) return "Token/auth check did not validate.";
  if (status?.error) return status.error;
  return null;
}
type AgentSectionId = "mcp-connectors" | "role-defaults" | "create-agent" | "builtin-agents" | "custom-agents";
const AGENT_SECTIONS_STORAGE_KEY = "bender.agents.openSections.v1";
const DEFAULT_OPEN_SECTIONS: Record<AgentSectionId, boolean> = {
  "mcp-connectors": false,
  "role-defaults": false,
  "create-agent": false,
  "builtin-agents": false,
  "custom-agents": false,
};

function readOpenSections(): Record<AgentSectionId, boolean> {
  if (typeof window === "undefined") {
    return { ...DEFAULT_OPEN_SECTIONS };
  }
  try {
    const raw = window.localStorage.getItem(AGENT_SECTIONS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_OPEN_SECTIONS };
    }
    const parsed = JSON.parse(raw) as Partial<Record<AgentSectionId, unknown>>;
    return {
      "mcp-connectors": typeof parsed["mcp-connectors"] === "boolean" ? parsed["mcp-connectors"] : DEFAULT_OPEN_SECTIONS["mcp-connectors"],
      "role-defaults": typeof parsed["role-defaults"] === "boolean" ? parsed["role-defaults"] : DEFAULT_OPEN_SECTIONS["role-defaults"],
      "create-agent": typeof parsed["create-agent"] === "boolean" ? parsed["create-agent"] : DEFAULT_OPEN_SECTIONS["create-agent"],
      "builtin-agents": typeof parsed["builtin-agents"] === "boolean" ? parsed["builtin-agents"] : DEFAULT_OPEN_SECTIONS["builtin-agents"],
      "custom-agents": typeof parsed["custom-agents"] === "boolean" ? parsed["custom-agents"] : DEFAULT_OPEN_SECTIONS["custom-agents"],
    };
  } catch {
    return { ...DEFAULT_OPEN_SECTIONS };
  }
}

function AccordionSection({
  title,
  description,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  description?: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 text-left hover:bg-zinc-900/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">{title}</span>
          {typeof count === "number" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{count}</span>
          )}
          <ChevronDown className={`ml-auto h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
        {description && <p className="mt-1 text-xs text-zinc-600">{description}</p>}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-zinc-800">
          <div className="pt-3">{children}</div>
        </div>
      )}
    </section>
  );
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function AgentsView() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [connectors, setConnectors] = useState<McpConnector[]>([]);
  const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [connectorEdits, setConnectorEdits] = useState<Record<string, { enabled: boolean; token: string }>>({});
  const [selectedByRole, setSelectedByRole] = useState<Partial<Record<BaseRole, string>>>({});
  const [promptSnippets, setPromptSnippets] = useState<Partial<Record<BaseRole, string>>>({});
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingConnectorId, setSavingConnectorId] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<BaseRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [createSkillSearch, setCreateSkillSearch] = useState("");
  const [openSections, setOpenSections] = useState<Record<AgentSectionId, boolean>>(() => readOpenSections());

  const [draft, setDraft] = useState<AgentConfig>({
    id: "",
    name: "",
    baseRole: "implementer",
    modelTier: "default",
    pinnedSkills: [],
    mcpServerIds: [],
    capabilityPolicy: { allow: [], deny: [] },
    systemPromptAddition: "",
  });

  const [customEdits, setCustomEdits] = useState<Record<string, AgentConfig>>({});

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [agentsRes, skillsRes, connectorsRes, connectorStatusRes, selectionsRes, snippetsRes] = await Promise.all([
        fetch("/api/agents"),
        fetch("/api/skills/registry"),
        fetch("/api/mcp/connectors"),
        fetch("/api/connectors/status?force=true"),
        fetch("/api/agents/selection"),
        fetch("/api/agents/prompt-snippets"),
      ]);
      const agentsBody = await agentsRes.json();
      const skillsBody = await skillsRes.json();
      const connectorsBody = await connectorsRes.json();
      const connectorStatusBody = await connectorStatusRes.json().catch(() => ({ connectors: [] }));
      const selectionsBody = await selectionsRes.json();
      const snippetsBody = await snippetsRes.json();
      if (!agentsRes.ok) throw new Error(agentsBody.error ?? "Failed to load agents");
      if (!connectorsRes.ok) throw new Error(connectorsBody.error ?? "Failed to load MCP connectors");
      setAgents(
        ((agentsBody.agents ?? []) as AgentConfig[]).map((agent) => ({
          ...agent,
          pinnedSkills: agent.pinnedSkills ?? [],
          mcpServerIds: agent.mcpServerIds ?? [],
          capabilityPolicy: {
            allow: [...new Set(agent.capabilityPolicy?.allow ?? [])],
            deny: [...new Set(agent.capabilityPolicy?.deny ?? [])],
          },
        })),
      );
      let resolvedSkills: SkillMeta[] = Array.isArray(skillsBody.skills) ? skillsBody.skills : [];
      if ((skillsBody.needsRefresh || resolvedSkills.length === 0) && skillsRes.ok) {
        try {
          const refreshRes = await fetch("/api/skills/refresh", { method: "POST" });
          const refreshBody = await refreshRes.json();
          if (refreshRes.ok && Array.isArray(refreshBody.skills)) {
            resolvedSkills = refreshBody.skills;
          }
        } catch {
          // Keep initial result on refresh failure.
        }
      }
      setSkills(resolvedSkills);
      setConnectors(connectorsBody.connectors ?? []);
      const nextStatuses: Record<string, ConnectorStatus> = {};
      if (connectorStatusRes.ok && Array.isArray(connectorStatusBody.connectors)) {
        for (const status of connectorStatusBody.connectors as ConnectorStatus[]) {
          nextStatuses[status.id] = status;
        }
      }
      setConnectorStatuses(nextStatuses);
      setSelectedByRole(selectionsBody.selectedByRole ?? {});
      setPromptSnippets(snippetsBody.snippets ?? {});

      const nextConnectorEdits: Record<string, { enabled: boolean; token: string }> = {};
      for (const connector of (connectorsBody.connectors ?? []) as McpConnector[]) {
        nextConnectorEdits[connector.id] = { enabled: !!connector.enabled, token: "" };
      }
      setConnectorEdits(nextConnectorEdits);

      const nextEdits: Record<string, AgentConfig> = {};
      for (const agent of (agentsBody.agents ?? []) as AgentConfig[]) {
        if (!agent.isBuiltin) {
          nextEdits[agent.id] = {
            ...agent,
            pinnedSkills: agent.pinnedSkills ?? [],
            mcpServerIds: agent.mcpServerIds ?? [],
            capabilityPolicy: {
              allow: [...new Set(agent.capabilityPolicy?.allow ?? [])],
              deny: [...new Set(agent.capabilityPolicy?.deny ?? [])],
            },
          };
        }
      }
      setCustomEdits(nextEdits);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(AGENT_SECTIONS_STORAGE_KEY, JSON.stringify(openSections));
  }, [openSections]);

  const orderedAgents = useMemo(
    () => [...agents].sort((a, b) => Number(!!b.isBuiltin) - Number(!!a.isBuiltin) || a.name.localeCompare(b.name)),
    [agents],
  );
  const builtinAgents = useMemo(
    () => orderedAgents.filter((agent) => !!agent.isBuiltin),
    [orderedAgents],
  );
  const customAgents = useMemo(
    () => orderedAgents.filter((agent) => !agent.isBuiltin),
    [orderedAgents],
  );
  const filteredSkills = useMemo(
    () => skills.filter((s) => !skillSearch || s.name.includes(skillSearch.toLowerCase()) || s.description.toLowerCase().includes(skillSearch.toLowerCase())),
    [skills, skillSearch],
  );
  const createFilteredSkills = useMemo(
    () => skills.filter((s) => !createSkillSearch || s.name.includes(createSkillSearch.toLowerCase()) || s.description.toLowerCase().includes(createSkillSearch.toLowerCase())),
    [skills, createSkillSearch],
  );
  const capabilityChoices = useMemo(() => {
    const map = new Map<string, { id: CapabilityId; label: string }>();
    for (const item of CAPABILITY_CHOICES) {
      map.set(item.id, item);
    }
    for (const status of Object.values(connectorStatuses)) {
      for (const id of status.discoveredCapabilities ?? []) {
        if (!id || map.has(id)) continue;
        const capabilityId = id as CapabilityId;
        map.set(capabilityId, {
          id: capabilityId,
          label: CAPABILITY_LABELS.get(capabilityId) ?? fallbackCapabilityLabel(id),
        });
      }
    }
    return [...map.values()];
  }, [connectorStatuses]);

  function toggleSection(section: AgentSectionId) {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  async function createAgent() {
    setError(null);
    setNotice(null);
    const name = draft.name.trim();
    if (!name) {
      setError("Agent name is required.");
      return;
    }
    const baseId = slugify(name) || `agent-${Date.now()}`;
    let id = baseId;
    if (agents.some((a) => a.id === id)) {
      id = `${baseId}-${Date.now().toString().slice(-5)}`;
    }

    const payload: AgentConfig = {
      ...draft,
      id,
      name,
      mcpServerIds: draft.mcpServerIds,
      capabilityPolicy: {
        allow: [...new Set(draft.capabilityPolicy?.allow ?? [])],
        deny: [...new Set(draft.capabilityPolicy?.deny ?? [])],
      },
      systemPromptAddition: draft.systemPromptAddition?.trim() || undefined,
    };

    setSavingId("__new__");
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to create agent");
      setDraft({
        id: "",
        name: "",
        baseRole: draft.baseRole,
        modelTier: draft.modelTier,
        pinnedSkills: [],
        mcpServerIds: [],
        capabilityPolicy: { allow: [], deny: [] },
        systemPromptAddition: "",
      });
      setNotice(`Created agent: ${payload.name}`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  async function setRoleSelection(role: BaseRole, agentId: string) {
    setSavingRole(role);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/agents/selection/${role}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agentId || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to update role selection");
      setSelectedByRole(body.selectedByRole ?? {});
      setNotice(`Updated default agent for ${role}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingRole(null);
    }
  }

  async function saveCustomAgent(id: string) {
    const edit = customEdits[id];
    if (!edit) return;
    setSavingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: edit.name.trim(),
          baseRole: edit.baseRole,
          modelTier: edit.modelTier,
          pinnedSkills: edit.pinnedSkills,
          mcpServerIds: edit.mcpServerIds,
          capabilityPolicy: {
            allow: [...new Set(edit.capabilityPolicy?.allow ?? [])],
            deny: [...new Set(edit.capabilityPolicy?.deny ?? [])],
          },
          systemPromptAddition: edit.systemPromptAddition?.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to save agent");
      setNotice(`Saved agent: ${edit.name}`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  async function deleteCustomAgent(id: string) {
    setSavingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to delete agent");
      setNotice("Deleted agent.");
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  function toggleSkill(agentId: string, skill: string, enabled: boolean) {
    setCustomEdits((prev) => {
      const current = prev[agentId];
      if (!current) return prev;
      if (enabled && !current.pinnedSkills.includes(skill) && current.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT) {
        return prev;
      }
      const nextSkills = enabled
        ? [...current.pinnedSkills, skill]
        : current.pinnedSkills.filter((s) => s !== skill);
      return { ...prev, [agentId]: { ...current, pinnedSkills: nextSkills } };
    });
  }

  function toggleDraftSkill(skill: string, enabled: boolean) {
    setDraft((prev) => {
      if (enabled && !prev.pinnedSkills.includes(skill) && prev.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT) {
        return prev;
      }
      const next = enabled
        ? [...prev.pinnedSkills, skill]
        : prev.pinnedSkills.filter((s) => s !== skill);
      return { ...prev, pinnedSkills: next };
    });
  }

  function toggleDraftConnector(connectorId: string, enabled: boolean) {
    setDraft((prev) => {
      if (enabled && !prev.mcpServerIds.includes(connectorId) && prev.mcpServerIds.length >= MAX_MCP_SERVERS_PER_AGENT) {
        return prev;
      }
      const next = enabled
        ? [...prev.mcpServerIds, connectorId]
        : prev.mcpServerIds.filter((id) => id !== connectorId);
      return { ...prev, mcpServerIds: next };
    });
  }

  function toggleCustomConnector(agentId: string, connectorId: string, enabled: boolean) {
    setCustomEdits((prev) => {
      const current = prev[agentId];
      if (!current) return prev;
      if (enabled && !current.mcpServerIds.includes(connectorId) && current.mcpServerIds.length >= MAX_MCP_SERVERS_PER_AGENT) {
        return prev;
      }
      const nextConnectors = enabled
        ? [...current.mcpServerIds, connectorId]
        : current.mcpServerIds.filter((id) => id !== connectorId);
      return { ...prev, [agentId]: { ...current, mcpServerIds: nextConnectors } };
    });
  }

  function toggleDraftCapability(capability: CapabilityId, enabled: boolean) {
    setDraft((prev) => {
      const allow = prev.capabilityPolicy?.allow ?? [];
      const nextAllow = enabled
        ? [...new Set([...allow, capability])]
        : allow.filter((id) => id !== capability);
      return {
        ...prev,
        capabilityPolicy: {
          allow: nextAllow,
          deny: prev.capabilityPolicy?.deny ?? [],
        },
      };
    });
  }

  function toggleCustomCapability(agentId: string, capability: CapabilityId, enabled: boolean) {
    setCustomEdits((prev) => {
      const current = prev[agentId];
      if (!current) return prev;
      const allow = current.capabilityPolicy?.allow ?? [];
      const nextAllow = enabled
        ? [...new Set([...allow, capability])]
        : allow.filter((id) => id !== capability);
      return {
        ...prev,
        [agentId]: {
          ...current,
          capabilityPolicy: {
            allow: nextAllow,
            deny: current.capabilityPolicy?.deny ?? [],
          },
        },
      };
    });
  }

  function connectorLabel(id: string): string {
    return connectors.find((c) => c.id === id)?.name ?? id;
  }

  async function refreshSkillsRegistry() {
    setSkillsRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/skills/refresh", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to refresh skills registry");
      setSkills(body.skills ?? []);
      setNotice("Skills registry refreshed.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSkillsRefreshing(false);
    }
  }

  async function saveConnector(connectorId: string) {
    const edit = connectorEdits[connectorId];
    if (!edit) return;
    setSavingConnectorId(connectorId);
    setError(null);
    setNotice(null);
    try {
      const payload: { enabled: boolean; authorizationToken?: string } = { enabled: edit.enabled };
      if (edit.token.trim()) {
        payload.authorizationToken = edit.token.trim();
      }
      const res = await fetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to save connector");
      setNotice(`Saved MCP connector: ${connectorLabel(connectorId)}`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingConnectorId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingDots size={28} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-300">Agents</h3>
          <button
            onClick={() => void refreshSkillsRegistry()}
            disabled={skillsRefreshing}
            className="ml-auto px-2.5 py-1 rounded-md text-[11px] border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {skillsRefreshing ? "Refreshing skills..." : "Refresh skills"}
          </button>
        </div>
        <p className="text-xs text-zinc-600">Default agents are read-only. Create custom agents and assign them per role (global) or per task (implementer).</p>
      </section>

      {(error || notice) && (
        <p className={`text-xs ${error ? "text-red-400" : "text-zinc-400"}`}>{error ?? notice}</p>
      )}

      <AccordionSection
        title="MCP Connectors"
        description="Configure connector credentials once, then assign connectors per agent below."
        count={connectors.length}
        open={openSections["mcp-connectors"]}
        onToggle={() => toggleSection("mcp-connectors")}
      >
        {connectors.length === 0 ? (
          <p className="text-sm text-zinc-600">No curated connectors found.</p>
        ) : (
          <div className="space-y-3">
            {connectors.map((connector) => {
              const edit = connectorEdits[connector.id] ?? { enabled: connector.enabled, token: "" };
              const savingConnector = savingConnectorId === connector.id;
              const status = connectorStatuses[connector.id];
              return (
                <div key={connector.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-zinc-200">{connector.name}</p>
                      <p className="text-[11px] text-zinc-500 font-mono">{connector.url}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${connector.configured ? "bg-emerald-900/40 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                      {connector.configured ? "Configured" : "No token"}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-600">{connector.description}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span className={`px-1.5 py-0.5 rounded ${status?.enabled ? "bg-emerald-900/40 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                      {status?.enabled ? "enabled" : "disabled"}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${status?.configured ? "bg-emerald-900/40 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                      {status?.configured ? "configured" : "no token"}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${status?.reachable ? "bg-emerald-900/40 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                      {status?.reachable ? "reachable" : "unreachable"}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${status?.authValid ? "bg-emerald-900/40 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
                      {status?.authValid ? "auth valid" : "auth unknown"}
                    </span>
                  </div>
                  {status && (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/50 px-2.5 py-2 space-y-1.5">
                      <p className="text-[11px] text-zinc-500">
                        Capabilities: {(status.discoveredCapabilities ?? []).join(", ") || "none"}
                      </p>
                      <p className="text-[11px] text-zinc-600">
                        Last checked: {new Date(status.lastCheckedAt).toLocaleTimeString()}
                      </p>
                      {status.error && <p className="text-[11px] text-red-400/80">{status.error}</p>}
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={edit.enabled}
                        onChange={(e) => setConnectorEdits((prev) => ({ ...prev, [connector.id]: { ...edit, enabled: e.target.checked } }))}
                      />
                      <span>Enabled globally</span>
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={edit.token}
                      onChange={(e) => setConnectorEdits((prev) => ({ ...prev, [connector.id]: { ...edit, token: e.target.value } }))}
                      type="password"
                      placeholder={connector.configured ? "Leave blank to keep existing token" : "Paste API token"}
                      className="flex-1 bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 font-mono"
                    />
                    <button
                      onClick={() => void saveConnector(connector.id)}
                      disabled={savingConnector}
                      className="px-3 py-2 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {savingConnector ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </AccordionSection>

      <AccordionSection
        title="Role Defaults"
        description="Choose which agent runs by default for each role. Leave empty to use builtin defaults."
        open={openSections["role-defaults"]}
        onToggle={() => toggleSection("role-defaults")}
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {BASE_ROLES.map((role) => {
            const roleAgents = agents.filter((a) => a.baseRole === role);
            return (
              <label key={role} className="space-y-1">
                <span className="text-xs text-zinc-500 capitalize">{role}</span>
                <div className="relative">
                  <select
                    value={selectedByRole[role] ?? ""}
                    onChange={(e) => void setRoleSelection(role, e.target.value)}
                    disabled={savingRole === role}
                    className="select-flat w-full pl-3 pr-8 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="">Builtin default</option>
                    {roleAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.modelTier}){agent.isBuiltin ? " [builtin]" : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                </div>
              </label>
            );
          })}
        </div>
      </AccordionSection>

      <AccordionSection
        title="Create Agent"
        description="Create custom agents and tune role, model tier, skills, MCP connectors, and prompt addition."
        open={openSections["create-agent"]}
        onToggle={() => toggleSection("create-agent")}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Name (e.g. Security Reviewer)"
              className="bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
            />
            <div className="relative">
              <select
                value={draft.baseRole}
                onChange={(e) => setDraft((d) => ({ ...d, baseRole: e.target.value as BaseRole }))}
                className="select-flat w-full pl-3 pr-8 py-2 text-sm"
              >
                {BASE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            </div>
            <div className="relative">
              <select
                value={draft.modelTier}
                onChange={(e) => setDraft((d) => ({ ...d, modelTier: e.target.value as ModelTier }))}
                className="select-flat w-full pl-3 pr-8 py-2 text-sm"
              >
                {MODEL_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            </div>
          </div>
          <textarea
            value={draft.systemPromptAddition ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, systemPromptAddition: e.target.value }))}
            placeholder="Optional system prompt addition"
            rows={3}
            className="w-full bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-xs text-zinc-500">
                Skills ({draft.pinnedSkills.length}/{MAX_PINNED_SKILLS_PER_AGENT})
              </p>
              <input
                value={createSkillSearch}
                onChange={(e) => setCreateSkillSearch(e.target.value)}
                placeholder="Filter skills..."
                className="ml-auto bg-zinc-950/50 border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
            </div>
            <div className="max-h-32 overflow-y-auto border border-zinc-800 rounded-md">
              {skills.length === 0 ? (
                <div className="px-3 py-3 space-y-2">
                  <p className="text-xs text-zinc-600">No skills loaded yet.</p>
                  <button
                    onClick={() => void refreshSkillsRegistry()}
                    disabled={skillsRefreshing}
                    className="px-2.5 py-1 rounded-md text-[11px] border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  >
                    {skillsRefreshing ? <LoadingDots size={14} label="Loading…" textClassName="text-[11px] text-zinc-400" /> : "Load skills"}
                  </button>
                </div>
              ) : createFilteredSkills.length === 0 ? (
                <p className="px-3 py-3 text-xs text-zinc-600">No skills match this filter.</p>
              ) : (
                createFilteredSkills.map((skill) => {
                  const enabled = draft.pinnedSkills.includes(skill.name);
                  const atLimit = !enabled && draft.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT;
                  return (
                    <label key={skill.name} className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-300 border-b border-zinc-800/60 last:border-b-0">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={atLimit}
                        onChange={(e) => toggleDraftSkill(skill.name, e.target.checked)}
                      />
                      <span className="font-mono">{skill.name}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">
              MCP connectors ({draft.mcpServerIds.length}/{MAX_MCP_SERVERS_PER_AGENT})
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {connectors.map((connector) => {
                const enabled = draft.mcpServerIds.includes(connector.id);
                const atLimit = !enabled && draft.mcpServerIds.length >= MAX_MCP_SERVERS_PER_AGENT;
                const status = connectorStatuses[connector.id];
                const reason = explainConnectorAvailability(
                  connector,
                  status,
                  new Set(draft.capabilityPolicy?.allow ?? []),
                );
                return (
                  <div key={connector.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-xs text-zinc-300 space-y-1">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={atLimit || (!!reason && !enabled)}
                        onChange={(e) => toggleDraftConnector(connector.id, e.target.checked)}
                      />
                      <span>{connector.name}</span>
                      {!!reason && <span className="ml-auto text-zinc-600">unavailable</span>}
                    </label>
                    {reason && <p className="text-[11px] text-zinc-600">{reason}</p>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">
              Capability policy ({draft.capabilityPolicy?.allow?.length ?? 0} allowed)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {capabilityChoices.map((cap) => {
                const enabled = (draft.capabilityPolicy?.allow ?? []).includes(cap.id);
                return (
                  <label key={cap.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => toggleDraftCapability(cap.id, e.target.checked)}
                    />
                    <span>{cap.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <button
            onClick={() => void createAgent()}
            disabled={savingId === "__new__"}
            className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {savingId === "__new__" ? "Creating..." : "Create Agent"}
          </button>
        </div>
      </AccordionSection>

      <AccordionSection
        title="Built-in Agents"
        description="Read-only defaults shipped with Bender."
        count={builtinAgents.length}
        open={openSections["builtin-agents"]}
        onToggle={() => toggleSection("builtin-agents")}
      >
        {builtinAgents.length === 0 ? (
          <p className="text-sm text-zinc-600">No built-in agents found.</p>
        ) : (
          <div className="space-y-3">
            {builtinAgents.map((agent) => (
              <div key={agent.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-zinc-100">{agent.name}</p>
                    <p className="text-[11px] text-zinc-500 font-mono">{agent.id}</p>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 uppercase tracking-wide">Builtin</span>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 text-xs">
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <p className="text-zinc-600">Role</p>
                    <p className="text-zinc-300 mt-0.5">{agent.baseRole}</p>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <p className="text-zinc-600">Model tier</p>
                    <p className="text-zinc-300 mt-0.5">{agent.modelTier}</p>
                  </div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <p className="text-zinc-600">Prompt snippet</p>
                    <p className="text-zinc-500 mt-0.5 leading-relaxed">
                      {promptSnippets[agent.baseRole] ?? "Prompt snippet unavailable."}
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs text-zinc-500">Pinned skills</p>
                  {agent.pinnedSkills.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {agent.pinnedSkills.map((skill) => (
                        <span key={skill} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
                          {skill}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-600">None</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs text-zinc-500">MCP connectors</p>
                  {agent.mcpServerIds.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {agent.mcpServerIds.map((connectorId) => (
                        <span key={connectorId} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                          {connectorLabel(connectorId)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-600">None</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs text-zinc-500">Allowed capabilities</p>
                  {(agent.capabilityPolicy?.allow?.length ?? 0) > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(agent.capabilityPolicy?.allow ?? []).map((cap) => (
                        <span key={cap} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
                          {cap}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-600">None</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </AccordionSection>

      <AccordionSection
        title="Custom Agents"
        description="Edit, assign skills, and manage custom agents."
        count={customAgents.length}
        open={openSections["custom-agents"]}
        onToggle={() => toggleSection("custom-agents")}
      >
        {customAgents.length === 0 ? (
          <p className="text-sm text-zinc-600">No custom agents yet.</p>
        ) : (
          <div className="space-y-3">
            {customAgents.map((agent) => {
              const edit = customEdits[agent.id] ?? agent;
              const busy = savingId === agent.id;
              return (
                <div key={agent.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
                  <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
                    <input
                      value={edit.name}
                      onChange={(e) => setCustomEdits((prev) => ({ ...prev, [agent.id]: { ...edit, name: e.target.value } }))}
                      className="bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
                    />
                    <div className="relative">
                      <select
                        value={edit.baseRole}
                        onChange={(e) => setCustomEdits((prev) => ({ ...prev, [agent.id]: { ...edit, baseRole: e.target.value as BaseRole } }))}
                        className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                      >
                        {BASE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                    </div>
                    <div className="relative">
                      <select
                        value={edit.modelTier}
                        onChange={(e) => setCustomEdits((prev) => ({ ...prev, [agent.id]: { ...edit, modelTier: e.target.value as ModelTier } }))}
                        className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                      >
                        {MODEL_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-500 font-mono truncate">{agent.id}</span>
                    </div>
                  </div>

                  <textarea
                    value={edit.systemPromptAddition ?? ""}
                    onChange={(e) => setCustomEdits((prev) => ({ ...prev, [agent.id]: { ...edit, systemPromptAddition: e.target.value } }))}
                    placeholder="Optional system prompt addition"
                    rows={2}
                    className="w-full bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                  />

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-zinc-500">
                        Pinned skills ({edit.pinnedSkills.length}/{MAX_PINNED_SKILLS_PER_AGENT})
                      </p>
                      <input
                        value={skillSearch}
                        onChange={(e) => setSkillSearch(e.target.value)}
                        placeholder="Filter skills..."
                        className="ml-auto bg-zinc-950/50 border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                      />
                    </div>
                    <div className="max-h-36 overflow-y-auto border border-zinc-800 rounded-md">
                      {skills.length === 0 ? (
                        <div className="px-3 py-3 space-y-2">
                          <p className="text-xs text-zinc-600">No skills loaded yet.</p>
                          <button
                            onClick={() => void refreshSkillsRegistry()}
                            disabled={skillsRefreshing}
                            className="px-2.5 py-1 rounded-md text-[11px] border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                          >
                            {skillsRefreshing ? <LoadingDots size={14} label="Loading…" textClassName="text-[11px] text-zinc-400" /> : "Load skills"}
                          </button>
                        </div>
                      ) : filteredSkills.length === 0 ? (
                        <p className="px-3 py-3 text-xs text-zinc-600">No skills match this filter.</p>
                      ) : (
                        filteredSkills.map((skill) => {
                          const enabled = edit.pinnedSkills.includes(skill.name);
                          const atLimit = !enabled && edit.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT;
                          return (
                            <label key={skill.name} className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-300 border-b border-zinc-800/60 last:border-b-0">
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={atLimit}
                                onChange={(e) => toggleSkill(agent.id, skill.name, e.target.checked)}
                              />
                              <span className="font-mono">{skill.name}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    {edit.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT && (
                      <p className="text-[11px] text-zinc-600">
                        Max pinned skills reached. Uncheck one to add another.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-zinc-500">
                      MCP connectors ({edit.mcpServerIds.length}/{MAX_MCP_SERVERS_PER_AGENT})
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {connectors.map((connector) => {
                        const enabled = edit.mcpServerIds.includes(connector.id);
                        const atLimit = !enabled && edit.mcpServerIds.length >= MAX_MCP_SERVERS_PER_AGENT;
                        const status = connectorStatuses[connector.id];
                        const reason = explainConnectorAvailability(
                          connector,
                          status,
                          new Set(edit.capabilityPolicy?.allow ?? []),
                        );
                        return (
                          <div key={connector.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-xs text-zinc-300 space-y-1">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={atLimit || (!!reason && !enabled)}
                                onChange={(e) => toggleCustomConnector(agent.id, connector.id, e.target.checked)}
                              />
                              <span>{connector.name}</span>
                              {!!reason && <span className="ml-auto text-zinc-600">unavailable</span>}
                            </label>
                            {reason && <p className="text-[11px] text-zinc-600">{reason}</p>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-zinc-500">
                      Capability policy ({edit.capabilityPolicy?.allow?.length ?? 0} allowed)
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {capabilityChoices.map((cap) => {
                        const enabled = (edit.capabilityPolicy?.allow ?? []).includes(cap.id);
                        return (
                          <label key={cap.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-xs text-zinc-300">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) => toggleCustomCapability(agent.id, cap.id, e.target.checked)}
                            />
                            <span>{cap.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void saveCustomAgent(agent.id)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {busy ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => void deleteCustomAgent(agent.id)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-md text-xs border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </AccordionSection>
    </div>
  );
}
