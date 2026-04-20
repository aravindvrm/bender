import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LoadingDots } from "../components/LoadingDots";
import { roleLabel, type BaseRole } from "../lib/roleLabels";

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
  source?: "curated" | "user" | "project";
  defaultPinnedRoles?: BaseRole[];
  runtimeBaselineRoles?: BaseRole[];
  defaultRuntimeEnabled?: boolean;
}

interface SkillLibrarySummary {
  total: number;
  curated: number;
  user: number;
  project: number;
  runtimeCuratedPool: number;
}

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS: ModelTier[] = ["fast", "default", "strong"];
const MAX_PINNED_SKILLS_PER_AGENT = 6;
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
type AgentSectionId = "role-defaults" | "skill-library" | "create-agent" | "builtin-agents" | "custom-agents";
const AGENT_SECTIONS_STORAGE_KEY = "bender.agents.openSections.v1";
const DEFAULT_OPEN_SECTIONS: Record<AgentSectionId, boolean> = {
  "role-defaults": false,
  "skill-library": false,
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
      "role-defaults": typeof parsed["role-defaults"] === "boolean" ? parsed["role-defaults"] : DEFAULT_OPEN_SECTIONS["role-defaults"],
      "skill-library": typeof parsed["skill-library"] === "boolean" ? parsed["skill-library"] : DEFAULT_OPEN_SECTIONS["skill-library"],
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

function sourceTone(source?: SkillMeta["source"]): string {
  if (source === "project") return "bg-cyan-950/70 text-cyan-300 border-cyan-900/60";
  if (source === "user") return "bg-emerald-950/70 text-emerald-300 border-emerald-900/60";
  return "bg-zinc-800 text-zinc-300 border-zinc-700";
}

function sourceLabel(source?: SkillMeta["source"]): string {
  if (source === "project") return "Project";
  if (source === "user") return "User";
  return "Curated";
}

export function AgentsView() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [skillLibrarySummary, setSkillLibrarySummary] = useState<SkillLibrarySummary | null>(null);
  const [selectedByRole, setSelectedByRole] = useState<Partial<Record<BaseRole, string>>>({});
  const [promptSnippets, setPromptSnippets] = useState<Partial<Record<BaseRole, string>>>({});
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [skillsStale, setSkillsStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<BaseRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [createSkillSearch, setCreateSkillSearch] = useState("");
  const [openSections, setOpenSections] = useState<Record<AgentSectionId, boolean>>(() => readOpenSections());
  const [skillLibraryScope, setSkillLibraryScope] = useState<"user" | "project">("project");
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");
  const [importSkillScope, setImportSkillScope] = useState<"user" | "project">("project");
  const [importSkillPath, setImportSkillPath] = useState("");
  const [importSkillName, setImportSkillName] = useState("");
  const [skillLibraryBusy, setSkillLibraryBusy] = useState<"create" | "import" | null>(null);

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

  async function loadSkillsCatalog(options?: { forceCuratedRefresh?: boolean }): Promise<{ skills: SkillMeta[]; summary: SkillLibrarySummary | null; stale: boolean }> {
    const forceCuratedRefresh = !!options?.forceCuratedRefresh;
    try {
      const catalogRes = await fetch("/api/skills/catalog");
      const catalogBody = await catalogRes.json() as { skills?: SkillMeta[]; summary?: SkillLibrarySummary; stale?: boolean; error?: string };
      if (catalogRes.ok) {
        return {
          skills: Array.isArray(catalogBody.skills) ? catalogBody.skills : [],
          summary: catalogBody.summary ?? null,
          stale: catalogBody.stale === true,
        };
      }
    } catch {
      // Fallback to legacy registry endpoint below.
    }

    const registryRes = await fetch("/api/skills/registry");
    const registryBody = await registryRes.json() as { skills?: SkillMeta[]; needsRefresh?: boolean; error?: string };
    if (!registryRes.ok) {
      throw new Error(registryBody.error ?? "Failed to load skills");
    }
    let resolvedSkills: SkillMeta[] = Array.isArray(registryBody.skills) ? registryBody.skills : [];
    if (forceCuratedRefresh || registryBody.needsRefresh || resolvedSkills.length === 0) {
      try {
        const refreshRes = await fetch("/api/skills/refresh", { method: "POST" });
        const refreshBody = await refreshRes.json() as { skills?: SkillMeta[] };
        if (refreshRes.ok && Array.isArray(refreshBody.skills)) {
          resolvedSkills = refreshBody.skills;
        }
      } catch {
        // Keep initial result on refresh failure.
      }
    }
    return { skills: resolvedSkills, summary: null, stale: false };
  }

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [agentsRes, skillsCatalog, selectionsRes, snippetsRes] = await Promise.all([
        fetch("/api/agents"),
        loadSkillsCatalog(),
        fetch("/api/agents/selection"),
        fetch("/api/agents/prompt-snippets"),
      ]);
      const agentsBody = await agentsRes.json();
      const selectionsBody = await selectionsRes.json();
      const snippetsBody = await snippetsRes.json();
      if (!agentsRes.ok) throw new Error(agentsBody.error ?? "Failed to load agents");
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
      setSkills(skillsCatalog.skills);
      setSkillLibrarySummary(skillsCatalog.summary);
      setSkillsStale(skillsCatalog.stale);
      setSelectedByRole(selectionsBody.selectedByRole ?? {});
      setPromptSnippets(snippetsBody.snippets ?? {});

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
  const capabilityChoices = CAPABILITY_CHOICES;

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
      setNotice(`Updated default agent for ${roleLabel(role)}.`);
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

  async function createLibrarySkill() {
    const trimmedName = newSkillName.trim();
    if (!trimmedName) {
      setError("Skill name is required.");
      return;
    }
    setSkillLibraryBusy("create");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/skills/library/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: skillLibraryScope,
          name: trimmedName,
          description: newSkillDescription.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to create skill package");
      setNewSkillName("");
      setNewSkillDescription("");
      const catalog = await loadSkillsCatalog();
      setSkills(catalog.skills);
      setSkillLibrarySummary(catalog.summary);
      setSkillsStale(catalog.stale);
      setNotice(`Created skill package: ${body.name ?? trimmedName}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSkillLibraryBusy(null);
    }
  }

  async function importLibrarySkill() {
    const trimmedPath = importSkillPath.trim();
    if (!trimmedPath) {
      setError("Skill source path is required.");
      return;
    }
    setSkillLibraryBusy("import");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/skills/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: importSkillScope,
          sourcePath: trimmedPath,
          name: importSkillName.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to import skill package");
      setImportSkillPath("");
      setImportSkillName("");
      const catalog = await loadSkillsCatalog();
      setSkills(catalog.skills);
      setSkillLibrarySummary(catalog.summary);
      setSkillsStale(catalog.stale);
      setNotice(`Imported skill package: ${body.name ?? "skill"}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSkillLibraryBusy(null);
    }
  }

  async function refreshSkillsRegistry() {
    setSkillsRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      await fetch("/api/skills/refresh", { method: "POST" });
      const catalog = await loadSkillsCatalog({ forceCuratedRefresh: true });
      setSkills(catalog.skills);
      setSkillLibrarySummary(catalog.summary);
      setSkillsStale(catalog.stale);
      setNotice("Skills refreshed.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSkillsRefreshing(false);
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
            {skillsRefreshing ? "Refreshing skills..." : "Refresh catalog"}
          </button>
        </div>
        <p className="text-xs text-zinc-600">Default agents are read-only. Create custom agents and assign them per role (global) or per task (implementer).</p>
      </section>

      {(error || notice) && (
        <p className={`text-xs ${error ? "text-red-400" : "text-zinc-400"}`}>{error ?? notice}</p>
      )}

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
                <span className="text-xs text-zinc-500">{roleLabel(role)}</span>
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
        title="Skill Library"
        description={
          skillsStale
            ? "Showing cached skills · offline"
            : "Curated defaults stay lean; extend the user/project library for custom agents."
        }
        count={skills.length}
        open={openSections["skill-library"]}
        onToggle={() => toggleSection("skill-library")}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-600">Total</p>
              <p className="text-zinc-300 mt-0.5">{skillLibrarySummary?.total ?? skills.length}</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-600">Curated</p>
              <p className="text-zinc-300 mt-0.5">{skillLibrarySummary?.curated ?? skills.filter((s) => s.source === "curated").length}</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-600">User</p>
              <p className="text-zinc-300 mt-0.5">{skillLibrarySummary?.user ?? skills.filter((s) => s.source === "user").length}</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-600">Project</p>
              <p className="text-zinc-300 mt-0.5">{skillLibrarySummary?.project ?? skills.filter((s) => s.source === "project").length}</p>
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-600">Runtime curated pool</p>
              <p className="text-zinc-300 mt-0.5">{skillLibrarySummary?.runtimeCuratedPool ?? "—"}</p>
            </div>
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3 space-y-2">
            <p className="text-xs text-zinc-500">Create skill package</p>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
              <div className="relative">
                <select
                  value={skillLibraryScope}
                  onChange={(e) => setSkillLibraryScope(e.target.value as "user" | "project")}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                >
                  <option value="project">Project library</option>
                  <option value="user">User library</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
              <input
                value={newSkillName}
                onChange={(e) => setNewSkillName(e.target.value)}
                placeholder="Skill name (e.g. api-contract-qa)"
                className="bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
              <input
                value={newSkillDescription}
                onChange={(e) => setNewSkillDescription(e.target.value)}
                placeholder="Short description (optional)"
                className="bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => void createLibrarySkill()}
                disabled={skillLibraryBusy === "create"}
                className="px-3 py-2 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {skillLibraryBusy === "create" ? "Creating..." : "Create"}
              </button>
            </div>
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3 space-y-2">
            <p className="text-xs text-zinc-500">Import skill package from local path</p>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
              <div className="relative">
                <select
                  value={importSkillScope}
                  onChange={(e) => setImportSkillScope(e.target.value as "user" | "project")}
                  className="select-flat w-full pl-3 pr-8 py-2 text-sm"
                >
                  <option value="project">Project library</option>
                  <option value="user">User library</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              </div>
              <input
                value={importSkillPath}
                onChange={(e) => setImportSkillPath(e.target.value)}
                placeholder="Source directory path"
                className="bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
              <input
                value={importSkillName}
                onChange={(e) => setImportSkillName(e.target.value)}
                placeholder="Override name (optional)"
                className="bg-zinc-950/50 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={() => void importLibrarySkill()}
                disabled={skillLibraryBusy === "import"}
                className="px-3 py-2 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {skillLibraryBusy === "import" ? "Importing..." : "Import"}
              </button>
            </div>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection
        title="Create Agent"
        description="Create custom agents and tune role, model tier, skills, capability policy, and prompt addition."
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
                {BASE_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
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
                    <label key={skill.name} className="flex items-start gap-2 px-2.5 py-1.5 text-xs text-zinc-300 border-b border-zinc-800/60 last:border-b-0">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={atLimit}
                        onChange={(e) => toggleDraftSkill(skill.name, e.target.checked)}
                      />
                      <span className="leading-4">
                        <span className="font-mono text-zinc-200">{skill.name}</span>
                        <span className={`ml-1 inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${sourceTone(skill.source)}`}>
                          {sourceLabel(skill.source)}
                        </span>
                        {skill.defaultRuntimeEnabled && (
                          <span className="ml-1 text-[10px] text-amber-300">runtime baseline</span>
                        )}
                        {skill.description && (
                          <span className="block text-zinc-500">{skill.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })
              )}
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
                    <p className="text-zinc-300 mt-0.5">{roleLabel(agent.baseRole)}</p>
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
                        {BASE_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
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
                            <label key={skill.name} className="flex items-start gap-2 px-2.5 py-1.5 text-xs text-zinc-300 border-b border-zinc-800/60 last:border-b-0">
                              <input
                                type="checkbox"
                                checked={enabled}
                                disabled={atLimit}
                                onChange={(e) => toggleSkill(agent.id, skill.name, e.target.checked)}
                              />
                              <span className="leading-4">
                                <span className="font-mono text-zinc-200">{skill.name}</span>
                                <span className={`ml-1 inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${sourceTone(skill.source)}`}>
                                  {sourceLabel(skill.source)}
                                </span>
                                {skill.defaultRuntimeEnabled && (
                                  <span className="ml-1 text-[10px] text-amber-300">runtime baseline</span>
                                )}
                                {skill.description && (
                                  <span className="block text-zinc-500">{skill.description}</span>
                                )}
                              </span>
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
