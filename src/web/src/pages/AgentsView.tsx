import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Pin, PinOff, Plus, X } from "lucide-react";
import { LoadingDots } from "../components/LoadingDots";
import { roleLabel, type BaseRole } from "../lib/roleLabels";
import { CreateSkillModal } from "../components/drawer/CreateSkillModal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------

const ROLE_DOT: Record<BaseRole, string> = {
  analyzer: "bg-blue-400",
  architect: "bg-violet-400",
  planner: "bg-amber-400",
  implementer: "bg-emerald-400",
  reviewer: "bg-rose-400",
};

const ROLE_BADGE: Record<BaseRole, string> = {
  analyzer: "text-blue-300 bg-blue-950/40 border-blue-900/40",
  architect: "text-violet-300 bg-violet-950/40 border-violet-900/40",
  planner: "text-amber-300 bg-amber-950/40 border-amber-900/40",
  implementer: "text-emerald-300 bg-emerald-950/40 border-emerald-900/40",
  reviewer: "text-rose-300 bg-rose-950/40 border-rose-900/40",
};

const TIER_BADGE: Record<ModelTier, string> = {
  fast: "text-sky-300 bg-sky-950/40 border-sky-900/40",
  default: "text-zinc-400 bg-zinc-800 border-zinc-700",
  strong: "text-violet-300 bg-violet-950/40 border-violet-900/40",
};

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

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ---------------------------------------------------------------------------
// Small shared sub-components
// ---------------------------------------------------------------------------

function RoleDot({ role }: { role: BaseRole }) {
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ROLE_DOT[role]}`} />;
}

function RoleBadge({ role }: { role: BaseRole }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide ${ROLE_BADGE[role]}`}>
      {roleLabel(role)}
    </span>
  );
}

function TierChip({ tier }: { tier: ModelTier }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${TIER_BADGE[tier]}`}>
      {tier}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skill row used inside agent detail panels (chips, not checkboxes)
// ---------------------------------------------------------------------------

function PinnedSkillChips({
  pinnedSkills,
  onRemove,
}: {
  pinnedSkills: string[];
  onRemove?: (skill: string) => void;
}) {
  if (pinnedSkills.length === 0) {
    return <p className="text-xs text-zinc-600">None pinned.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {pinnedSkills.map((s) => (
        <span
          key={s}
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono"
        >
          {s}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(s)}
              className="text-zinc-500 hover:text-zinc-200 transition-colors leading-none"
              tabIndex={-1}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capability checkboxes (shared between create and edit panels)
// ---------------------------------------------------------------------------

function CapabilityGrid({
  allowed,
  onChange,
}: {
  allowed: CapabilityId[];
  onChange: (next: CapabilityId[]) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
      {CAPABILITY_CHOICES.map((cap) => {
        const enabled = allowed.includes(cap.id);
        return (
          <label
            key={cap.id}
            className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5 text-xs text-zinc-300 cursor-pointer hover:border-zinc-700 transition-colors"
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...new Set([...allowed, cap.id])]
                  : allowed.filter((id) => id !== cap.id);
                onChange(next);
              }}
            />
            <span>{cap.label}</span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Builtin agent detail (read-only)
// ---------------------------------------------------------------------------

function BuiltinAgentDetail({
  agent,
  promptSnippet,
}: {
  agent: AgentConfig;
  promptSnippet?: string;
}) {
  return (
    <div className="p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-medium text-zinc-100">{agent.name}</p>
          <p className="text-xs text-zinc-500 font-mono mt-0.5">{agent.id}</p>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 uppercase tracking-wide flex-shrink-0">
          Builtin
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <RoleBadge role={agent.baseRole} />
        <TierChip tier={agent.modelTier} />
      </div>

      {promptSnippet && (
        <div className="space-y-1.5">
          <p className="text-xs text-zinc-500">System prompt</p>
          <p className="text-xs text-zinc-400 leading-relaxed bg-zinc-950/40 border border-zinc-800 rounded-lg px-3 py-2">
            {promptSnippet}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-xs text-zinc-500">
          Pinned skills ({agent.pinnedSkills.length})
        </p>
        <PinnedSkillChips pinnedSkills={agent.pinnedSkills} />
      </div>

      {(agent.capabilityPolicy?.allow?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-zinc-500">Capabilities</p>
          <div className="flex flex-wrap gap-1.5">
            {(agent.capabilityPolicy?.allow ?? []).map((cap) => (
              <span
                key={cap}
                className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono"
              >
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom agent edit panel
// ---------------------------------------------------------------------------

function CustomAgentEditPanel({
  agent,
  edit,
  skills,
  saving,
  onEditChange,
  onSave,
  onDelete,
}: {
  agent: AgentConfig;
  edit: AgentConfig;
  skills: SkillMeta[];
  saving: boolean;
  onEditChange: (next: AgentConfig) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const [skillSearch, setSkillSearch] = useState("");
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const atLimit = edit.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT;

  const filteredSkills = useMemo(
    () =>
      skills.filter(
        (s) =>
          !skillSearch ||
          s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
          s.description.toLowerCase().includes(skillSearch.toLowerCase()),
      ),
    [skills, skillSearch],
  );

  return (
    <div className="p-5 space-y-5">
      {/* Name / role / tier */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          value={edit.name}
          onChange={(e) => onEditChange({ ...edit, name: e.target.value })}
          className="bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
        />
        <div className="relative">
          <select
            value={edit.baseRole}
            onChange={(e) => onEditChange({ ...edit, baseRole: e.target.value as BaseRole })}
            className="select-flat w-full pl-3 pr-8 py-2 text-sm"
          >
            {BASE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
        </div>
        <div className="relative">
          <select
            value={edit.modelTier}
            onChange={(e) => onEditChange({ ...edit, modelTier: e.target.value as ModelTier })}
            className="select-flat w-full pl-3 pr-8 py-2 text-sm"
          >
            {MODEL_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
        </div>
      </div>

      <p className="text-[11px] text-zinc-600 font-mono -mt-3">{agent.id}</p>

      {/* System prompt */}
      <div className="space-y-1.5">
        <label className="text-xs text-zinc-500">System prompt addition</label>
        <textarea
          value={edit.systemPromptAddition ?? ""}
          onChange={(e) => onEditChange({ ...edit, systemPromptAddition: e.target.value })}
          placeholder="Extra instructions appended to this agent's system prompt…"
          rows={3}
          className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      {/* Pinned skills */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-500">
            Pinned skills ({edit.pinnedSkills.length}/{MAX_PINNED_SKILLS_PER_AGENT})
          </p>
          <button
            type="button"
            onClick={() => setShowSkillPicker((p) => !p)}
            className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showSkillPicker ? "Close picker" : "+ Add skill"}
          </button>
        </div>

        <PinnedSkillChips
          pinnedSkills={edit.pinnedSkills}
          onRemove={(s) =>
            onEditChange({ ...edit, pinnedSkills: edit.pinnedSkills.filter((x) => x !== s) })
          }
        />

        {showSkillPicker && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
            <div className="px-2 py-1.5 border-b border-zinc-800">
              <input
                autoFocus
                value={skillSearch}
                onChange={(e) => setSkillSearch(e.target.value)}
                placeholder="Filter skills…"
                className="w-full bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 outline-none"
              />
            </div>
            <div className="max-h-36 overflow-y-auto">
              {skills.length === 0 ? (
                <p className="px-3 py-3 text-xs text-zinc-600">No skills loaded yet.</p>
              ) : filteredSkills.length === 0 ? (
                <p className="px-3 py-3 text-xs text-zinc-600">No skills match.</p>
              ) : (
                filteredSkills.map((skill) => {
                  const pinned = edit.pinnedSkills.includes(skill.name);
                  const disabled = !pinned && atLimit;
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        const next = pinned
                          ? edit.pinnedSkills.filter((s) => s !== skill.name)
                          : [...edit.pinnedSkills, skill.name];
                        onEditChange({ ...edit, pinnedSkills: next });
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left border-b border-zinc-800/60 last:border-b-0 transition-colors
                        ${pinned ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"}
                        ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      {pinned ? (
                        <PinOff className="h-3 w-3 flex-shrink-0 text-zinc-400" />
                      ) : (
                        <Pin className="h-3 w-3 flex-shrink-0 text-zinc-600" />
                      )}
                      <span className="font-mono text-zinc-200">{skill.name}</span>
                      <span
                        className={`ml-0.5 inline-flex items-center rounded border px-1 py-0 text-[10px] font-medium uppercase tracking-wide ${sourceTone(skill.source)}`}
                      >
                        {sourceLabel(skill.source)}
                      </span>
                      {skill.description && (
                        <span className="text-zinc-600 truncate">{skill.description}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {atLimit && (
          <p className="text-[11px] text-zinc-600">
            Max {MAX_PINNED_SKILLS_PER_AGENT} pinned skills reached. Remove one to add another.
          </p>
        )}
      </div>

      {/* Capabilities */}
      <div className="space-y-2">
        <p className="text-xs text-zinc-500">
          Capabilities ({edit.capabilityPolicy?.allow?.length ?? 0} allowed)
        </p>
        <CapabilityGrid
          allowed={edit.capabilityPolicy?.allow ?? []}
          onChange={(next) =>
            onEditChange({
              ...edit,
              capabilityPolicy: { allow: next, deny: edit.capabilityPolicy?.deny ?? [] },
            })
          }
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 rounded-md text-xs font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onDelete}
          disabled={saving}
          className="px-3 py-1.5 rounded-md text-xs border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-40 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New agent create panel
// ---------------------------------------------------------------------------

function CreateAgentPanel({
  draft,
  setDraft,
  skills,
  saving,
  onCreate,
}: {
  draft: AgentConfig;
  setDraft: React.Dispatch<React.SetStateAction<AgentConfig>>;
  skills: SkillMeta[];
  saving: boolean;
  onCreate: () => void;
}) {
  const [skillSearch, setSkillSearch] = useState("");
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const atLimit = draft.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT;

  const filteredSkills = useMemo(
    () =>
      skills.filter(
        (s) =>
          !skillSearch ||
          s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
          s.description.toLowerCase().includes(skillSearch.toLowerCase()),
      ),
    [skills, skillSearch],
  );

  return (
    <div className="p-5 space-y-5">
      <div>
        <p className="text-sm font-medium text-zinc-100">New Agent</p>
        <p className="text-xs text-zinc-600 mt-0.5">
          Custom agents extend the built-in defaults. They can be assigned per-task or set as the
          default for a role.
        </p>
      </div>

      {/* Name / role / tier */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          autoFocus
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Name (e.g. Security Reviewer)"
          className="bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
        <div className="relative">
          <select
            value={draft.baseRole}
            onChange={(e) => setDraft((d) => ({ ...d, baseRole: e.target.value as BaseRole }))}
            className="select-flat w-full pl-3 pr-8 py-2 text-sm"
          >
            {BASE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
        </div>
        <div className="relative">
          <select
            value={draft.modelTier}
            onChange={(e) => setDraft((d) => ({ ...d, modelTier: e.target.value as ModelTier }))}
            className="select-flat w-full pl-3 pr-8 py-2 text-sm"
          >
            {MODEL_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
        </div>
      </div>

      {/* System prompt */}
      <div className="space-y-1.5">
        <label className="text-xs text-zinc-500">System prompt addition</label>
        <textarea
          value={draft.systemPromptAddition ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, systemPromptAddition: e.target.value }))}
          placeholder="Extra instructions appended to this agent's system prompt…"
          rows={3}
          className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 resize-none"
        />
      </div>

      {/* Pinned skills */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-500">
            Pinned skills ({draft.pinnedSkills.length}/{MAX_PINNED_SKILLS_PER_AGENT})
          </p>
          <button
            type="button"
            onClick={() => setShowSkillPicker((p) => !p)}
            className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showSkillPicker ? "Close picker" : "+ Add skill"}
          </button>
        </div>

        <PinnedSkillChips
          pinnedSkills={draft.pinnedSkills}
          onRemove={(s) =>
            setDraft((d) => ({ ...d, pinnedSkills: d.pinnedSkills.filter((x) => x !== s) }))
          }
        />

        {showSkillPicker && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
            <div className="px-2 py-1.5 border-b border-zinc-800">
              <input
                autoFocus
                value={skillSearch}
                onChange={(e) => setSkillSearch(e.target.value)}
                placeholder="Filter skills…"
                className="w-full bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 outline-none"
              />
            </div>
            <div className="max-h-36 overflow-y-auto">
              {skills.length === 0 ? (
                <p className="px-3 py-3 text-xs text-zinc-600">No skills loaded yet.</p>
              ) : filteredSkills.length === 0 ? (
                <p className="px-3 py-3 text-xs text-zinc-600">No skills match.</p>
              ) : (
                filteredSkills.map((skill) => {
                  const pinned = draft.pinnedSkills.includes(skill.name);
                  const disabled = !pinned && atLimit;
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        const next = pinned
                          ? draft.pinnedSkills.filter((s) => s !== skill.name)
                          : [...draft.pinnedSkills, skill.name];
                        setDraft((d) => ({ ...d, pinnedSkills: next }));
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left border-b border-zinc-800/60 last:border-b-0 transition-colors
                        ${pinned ? "text-zinc-100 bg-zinc-800/60" : "text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"}
                        ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      {pinned ? (
                        <PinOff className="h-3 w-3 flex-shrink-0 text-zinc-400" />
                      ) : (
                        <Pin className="h-3 w-3 flex-shrink-0 text-zinc-600" />
                      )}
                      <span className="font-mono text-zinc-200">{skill.name}</span>
                      <span
                        className={`ml-0.5 inline-flex items-center rounded border px-1 py-0 text-[10px] font-medium uppercase tracking-wide ${sourceTone(skill.source)}`}
                      >
                        {sourceLabel(skill.source)}
                      </span>
                      {skill.description && (
                        <span className="text-zinc-600 truncate">{skill.description}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Capabilities */}
      <div className="space-y-2">
        <p className="text-xs text-zinc-500">
          Capabilities ({draft.capabilityPolicy?.allow?.length ?? 0} allowed)
        </p>
        <CapabilityGrid
          allowed={draft.capabilityPolicy?.allow ?? []}
          onChange={(next) =>
            setDraft((d) => ({
              ...d,
              capabilityPolicy: { allow: next, deny: d.capabilityPolicy?.deny ?? [] },
            }))
          }
        />
      </div>

      {/* Action */}
      <button
        onClick={onCreate}
        disabled={saving || !draft.name.trim()}
        className="px-4 py-1.5 rounded-md text-xs font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-40 transition-colors"
      >
        {saving ? "Creating…" : "Create Agent"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills section (tabbed)
// ---------------------------------------------------------------------------

type SkillTab = "curated" | "user" | "project";

function SkillsSection({
  skills,
  summary,
  stale,
  skillsRefreshing,
  onRefresh,
  onNewSkill,
  pinnedSkills,
  canPin,
  onPinToggle,
}: {
  skills: SkillMeta[];
  summary: SkillLibrarySummary | null;
  stale: boolean;
  skillsRefreshing: boolean;
  onRefresh: () => void;
  onNewSkill: () => void;
  pinnedSkills: string[];
  canPin: boolean;
  onPinToggle: (skillName: string) => void;
}) {
  const [tab, setTab] = useState<SkillTab>("curated");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importScope, setImportScope] = useState<"user" | "project">("project");
  const [importPath, setImportPath] = useState("");
  const [importName, setImportName] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const tabSkills = useMemo(
    () =>
      skills.filter((s) => {
        const matchesTab =
          tab === "curated"
            ? s.source === "curated" || !s.source
            : s.source === tab;
        const q = search.toLowerCase();
        const matchesSearch =
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q);
        return matchesTab && matchesSearch;
      }),
    [skills, tab, search],
  );

  const counts = {
    curated: skills.filter((s) => s.source === "curated" || !s.source).length,
    user: skills.filter((s) => s.source === "user").length,
    project: skills.filter((s) => s.source === "project").length,
  };

  async function handleImport() {
    const trimmedPath = importPath.trim();
    if (!trimmedPath) {
      setImportError("Source path is required.");
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setImportNotice(null);
    try {
      const res = await fetch("/api/skills/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: importScope,
          sourcePath: trimmedPath,
          name: importName.trim() || undefined,
        }),
      });
      const body = (await res.json()) as { name?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Import failed");
      setImportPath("");
      setImportName("");
      setImportNotice(`Imported: ${body.name ?? "skill"}`);
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImportBusy(false);
    }
  }

  const totalSkills = summary?.total ?? skills.length;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-zinc-900/50 transition-colors text-left"
      >
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">Skills</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
          {totalSkills}
        </span>
        {stale && (
          <span className="text-[10px] text-amber-400 bg-amber-950/40 border border-amber-900/40 rounded px-1.5 py-0.5">
            offline · cached
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-zinc-800">
          {/* Tab strip + search + actions */}
          <div className="px-4 py-2 flex items-center gap-1 border-b border-zinc-800">
            {(["curated", "user", "project"] as SkillTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors capitalize ${
                  tab === t
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50"
                }`}
              >
                {t}
                <span className="ml-1 text-[10px] text-zinc-600">{counts[t]}</span>
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="bg-zinc-950/50 border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 w-36"
              />
              <button
                type="button"
                onClick={onRefresh}
                disabled={skillsRefreshing}
                title="Refresh curated catalog"
                className="px-2.5 py-1 rounded-md text-[11px] border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 transition-colors"
              >
                {skillsRefreshing ? "…" : "Refresh"}
              </button>
              <button
                type="button"
                onClick={onNewSkill}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
              >
                <Plus className="h-3 w-3" />
                New Skill
              </button>
            </div>
          </div>

          {/* Skill list */}
          {tabSkills.length === 0 ? (
            <p className="px-4 py-4 text-xs text-zinc-600">
              {search ? "No skills match this search." : `No ${tab} skills yet.`}
            </p>
          ) : (
            <div className="divide-y divide-zinc-800/60">
              {tabSkills.map((skill) => {
                const pinned = pinnedSkills.includes(skill.name);
                const atLimit = !pinned && pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT;
                return (
                  <div
                    key={skill.name}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-900/30 transition-colors group"
                  >
                    <span className="font-mono text-xs text-zinc-200 flex-shrink-0">
                      {skill.name}
                    </span>
                    <span
                      className={`inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide flex-shrink-0 ${sourceTone(skill.source)}`}
                    >
                      {sourceLabel(skill.source)}
                    </span>
                    {skill.defaultRuntimeEnabled && (
                      <span className="text-[10px] text-amber-300 flex-shrink-0">
                        runtime baseline
                      </span>
                    )}
                    <span className="text-xs text-zinc-600 truncate flex-1 min-w-0">
                      {skill.description}
                    </span>
                    {canPin && (
                      <button
                        type="button"
                        disabled={atLimit}
                        title={
                          pinned
                            ? "Unpin from agent"
                            : atLimit
                              ? `Max ${MAX_PINNED_SKILLS_PER_AGENT} skills`
                              : "Pin to agent"
                        }
                        onClick={() => onPinToggle(skill.name)}
                        className={`flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors
                          ${pinned
                            ? "text-zinc-200 bg-zinc-700 hover:bg-zinc-600"
                            : "text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 disabled:opacity-30"
                          } disabled:cursor-not-allowed`}
                      >
                        {pinned ? (
                          <PinOff className="h-3 w-3" />
                        ) : (
                          <Pin className="h-3 w-3" />
                        )}
                        {pinned ? "Unpin" : "Pin"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Import form (secondary, hidden by default) */}
          <div className="border-t border-zinc-800 px-4 py-2">
            <button
              type="button"
              onClick={() => setImportOpen((p) => !p)}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {importOpen ? "▾ Hide import" : "▸ Import from local path"}
            </button>
            {importOpen && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <div className="relative">
                    <select
                      value={importScope}
                      onChange={(e) => setImportScope(e.target.value as "user" | "project")}
                      className="select-flat w-full pl-3 pr-8 py-1.5 text-xs"
                    >
                      <option value="project">Project</option>
                      <option value="user">User</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
                  </div>
                  <input
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                    placeholder="Source directory path"
                    className="bg-zinc-950/50 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                  />
                  <input
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="Override name (optional)"
                    className="bg-zinc-950/50 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                  />
                  <button
                    onClick={() => void handleImport()}
                    disabled={importBusy}
                    className="px-2.5 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                  >
                    {importBusy ? "Importing…" : "Import"}
                  </button>
                </div>
                {importError && <p className="text-xs text-red-400">{importError}</p>}
                {importNotice && <p className="text-xs text-zinc-400">{importNotice}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

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
  const [selectedId, setSelectedId] = useState<string | null | "__new__">(null);
  const [showCreateSkill, setShowCreateSkill] = useState(false);

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

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadSkillsCatalog(options?: {
    forceCuratedRefresh?: boolean;
  }): Promise<{ skills: SkillMeta[]; summary: SkillLibrarySummary | null; stale: boolean }> {
    const forceCuratedRefresh = !!options?.forceCuratedRefresh;
    try {
      const catalogRes = await fetch("/api/skills/catalog");
      const catalogBody = (await catalogRes.json()) as {
        skills?: SkillMeta[];
        summary?: SkillLibrarySummary;
        stale?: boolean;
        error?: string;
      };
      if (catalogRes.ok) {
        return {
          skills: Array.isArray(catalogBody.skills) ? catalogBody.skills : [],
          summary: catalogBody.summary ?? null,
          stale: catalogBody.stale === true,
        };
      }
    } catch {
      // fall through to legacy endpoint
    }

    const registryRes = await fetch("/api/skills/registry");
    const registryBody = (await registryRes.json()) as {
      skills?: SkillMeta[];
      needsRefresh?: boolean;
      error?: string;
    };
    if (!registryRes.ok) throw new Error(registryBody.error ?? "Failed to load skills");
    let resolvedSkills: SkillMeta[] = Array.isArray(registryBody.skills)
      ? registryBody.skills
      : [];
    if (forceCuratedRefresh || registryBody.needsRefresh || resolvedSkills.length === 0) {
      try {
        const refreshRes = await fetch("/api/skills/refresh", { method: "POST" });
        const refreshBody = (await refreshRes.json()) as { skills?: SkillMeta[] };
        if (refreshRes.ok && Array.isArray(refreshBody.skills)) {
          resolvedSkills = refreshBody.skills;
        }
      } catch {
        // keep initial result
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

      const normalised = ((agentsBody.agents ?? []) as AgentConfig[]).map((a) => ({
        ...a,
        pinnedSkills: a.pinnedSkills ?? [],
        mcpServerIds: a.mcpServerIds ?? [],
        capabilityPolicy: {
          allow: [...new Set(a.capabilityPolicy?.allow ?? [])],
          deny: [...new Set(a.capabilityPolicy?.deny ?? [])],
        },
      }));

      setAgents(normalised);
      setSkills(skillsCatalog.skills);
      setSkillLibrarySummary(skillsCatalog.summary);
      setSkillsStale(skillsCatalog.stale);
      setSelectedByRole(selectionsBody.selectedByRole ?? {});
      setPromptSnippets(snippetsBody.snippets ?? {});

      const nextEdits: Record<string, AgentConfig> = {};
      for (const agent of normalised) {
        if (!agent.isBuiltin) nextEdits[agent.id] = { ...agent };
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

  // ── Derived state ─────────────────────────────────────────────────────────

  const orderedAgents = useMemo(
    () =>
      [...agents].sort(
        (a, b) => Number(!!b.isBuiltin) - Number(!!a.isBuiltin) || a.name.localeCompare(b.name),
      ),
    [agents],
  );
  const builtinAgents = useMemo(() => orderedAgents.filter((a) => !!a.isBuiltin), [orderedAgents]);
  const customAgents = useMemo(() => orderedAgents.filter((a) => !a.isBuiltin), [orderedAgents]);

  const selectedAgent = agents.find((a) => a.id === selectedId);

  // The pinned skills for the currently-selected entity (for the skills section pin button)
  const activePinnedSkills: string[] = useMemo(() => {
    if (selectedId === "__new__") return draft.pinnedSkills;
    if (selectedId && !selectedAgent?.isBuiltin) {
      return customEdits[selectedId]?.pinnedSkills ?? [];
    }
    return [];
  }, [selectedId, draft.pinnedSkills, customEdits, selectedAgent]);

  const canPinToSelected =
    selectedId !== null &&
    (selectedId === "__new__" || (!!selectedAgent && !selectedAgent.isBuiltin));

  // ── Actions ───────────────────────────────────────────────────────────────

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
    if (agents.some((a) => a.id === id)) id = `${baseId}-${Date.now().toString().slice(-5)}`;

    const payload: AgentConfig = {
      ...draft,
      id,
      name,
      systemPromptAddition: draft.systemPromptAddition?.trim() || undefined,
      capabilityPolicy: {
        allow: [...new Set(draft.capabilityPolicy?.allow ?? [])],
        deny: [...new Set(draft.capabilityPolicy?.deny ?? [])],
      },
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
      setSelectedId(id);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
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
      setNotice(`Saved: ${edit.name}`);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  async function deleteCustomAgent(id: string) {
    if (!window.confirm("Delete this agent?")) return;
    setSavingId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to delete agent");
      setNotice("Agent deleted.");
      if (selectedId === id) setSelectedId(null);
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
      if (!res.ok) throw new Error(body.error ?? "Failed to update role default");
      setSelectedByRole(body.selectedByRole ?? {});
      setNotice(`Updated default agent for ${roleLabel(role)}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingRole(null);
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

  function handlePinToggle(skillName: string) {
    if (selectedId === "__new__") {
      const pinned = draft.pinnedSkills.includes(skillName);
      if (!pinned && draft.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT) return;
      setDraft((d) => ({
        ...d,
        pinnedSkills: pinned
          ? d.pinnedSkills.filter((s) => s !== skillName)
          : [...d.pinnedSkills, skillName],
      }));
    } else if (selectedId && !selectedAgent?.isBuiltin) {
      const edit = customEdits[selectedId];
      if (!edit) return;
      const pinned = edit.pinnedSkills.includes(skillName);
      if (!pinned && edit.pinnedSkills.length >= MAX_PINNED_SKILLS_PER_AGENT) return;
      setCustomEdits((prev) => ({
        ...prev,
        [selectedId]: {
          ...edit,
          pinnedSkills: pinned
            ? edit.pinnedSkills.filter((s) => s !== skillName)
            : [...edit.pinnedSkills, skillName],
        },
      }));
    }
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingDots size={28} />
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-300">Agents</h3>
        <p className="text-xs text-zinc-600">
          Built-in agents are read-only. Create custom agents and assign per role or per task.
        </p>
      </div>

      {/* Error / notice banner */}
      {(error || notice) && (
        <p className={`text-xs px-3 py-2 rounded-lg border ${
          error
            ? "text-red-400 bg-red-950/20 border-red-900/30"
            : "text-zinc-400 bg-zinc-900/40 border-zinc-800"
        }`}>
          {error ?? notice}
        </p>
      )}

      {/* ── Two-panel layout ── */}
      <div className="flex gap-4" style={{ minHeight: 400 }}>
        {/* Left: agent list */}
        <div className="w-64 flex-shrink-0 space-y-0.5">
          {/* Built-ins */}
          <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-2 mb-1">
            Built-in
          </p>
          {builtinAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedId(agent.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors
                ${
                  selectedId === agent.id
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
            >
              <RoleDot role={agent.baseRole} />
              <span className="flex-1 truncate text-sm">{agent.name}</span>
              <TierChip tier={agent.modelTier} />
            </button>
          ))}

          {/* Custom agents */}
          <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-2 mt-3 mb-1">
            Custom
          </p>
          {customAgents.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-zinc-600">No custom agents yet.</p>
          ) : (
            customAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelectedId(agent.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors
                  ${
                    selectedId === agent.id
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
              >
                <RoleDot role={agent.baseRole} />
                <span className="flex-1 truncate text-sm">{agent.name}</span>
                <TierChip tier={agent.modelTier} />
              </button>
            ))
          )}

          {/* New agent button */}
          <button
            type="button"
            onClick={() => setSelectedId("__new__")}
            className={`w-full flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-left transition-colors mt-1
              ${
                selectedId === "__new__"
                  ? "bg-zinc-800 text-zinc-300"
                  : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900/50"
              }`}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="text-xs">New agent</span>
          </button>
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/20 overflow-y-auto">
          {selectedId === null ? (
            <div className="flex items-center justify-center h-full py-20 text-zinc-600 text-sm">
              Select an agent or{" "}
              <button
                type="button"
                onClick={() => setSelectedId("__new__")}
                className="ml-1 text-zinc-400 underline underline-offset-2 hover:text-zinc-200 transition-colors"
              >
                create a new one
              </button>
            </div>
          ) : selectedId === "__new__" ? (
            <CreateAgentPanel
              draft={draft}
              setDraft={setDraft}
              skills={skills}
              saving={savingId === "__new__"}
              onCreate={() => void createAgent()}
            />
          ) : selectedAgent?.isBuiltin ? (
            <BuiltinAgentDetail
              agent={selectedAgent}
              promptSnippet={promptSnippets[selectedAgent.baseRole]}
            />
          ) : selectedAgent ? (
            <CustomAgentEditPanel
              agent={selectedAgent}
              edit={customEdits[selectedAgent.id] ?? selectedAgent}
              skills={skills}
              saving={savingId === selectedAgent.id}
              onEditChange={(next) =>
                setCustomEdits((prev) => ({ ...prev, [selectedAgent.id]: next }))
              }
              onSave={() => void saveCustomAgent(selectedAgent.id)}
              onDelete={() => void deleteCustomAgent(selectedAgent.id)}
            />
          ) : (
            // Agent was deleted while selected
            <div className="flex items-center justify-center h-full py-20 text-zinc-600 text-sm">
              Agent not found.
            </div>
          )}
        </div>
      </div>

      {/* ── Role defaults ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Role defaults</p>
          <p className="text-xs text-zinc-600 mt-0.5">
            Override the default agent for each pipeline role. Leave empty to use the built-in
            default.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {BASE_ROLES.map((role) => {
            const roleAgents = agents.filter((a) => a.baseRole === role);
            return (
              <div key={role} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${ROLE_DOT[role]}`} />
                  <span className="text-xs text-zinc-500">{roleLabel(role)}</span>
                </div>
                <div className="relative">
                  <select
                    value={selectedByRole[role] ?? ""}
                    onChange={(e) => void setRoleSelection(role, e.target.value)}
                    disabled={savingRole === role}
                    className="select-flat w-full pl-3 pr-8 py-1.5 text-xs disabled:opacity-50"
                  >
                    <option value="">Built-in default</option>
                    {roleAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.modelTier}){agent.isBuiltin ? " [builtin]" : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Skills section ── */}
      <SkillsSection
        skills={skills}
        summary={skillLibrarySummary}
        stale={skillsStale}
        skillsRefreshing={skillsRefreshing}
        onRefresh={() => void refreshSkillsRegistry()}
        onNewSkill={() => setShowCreateSkill(true)}
        pinnedSkills={activePinnedSkills}
        canPin={canPinToSelected}
        onPinToggle={handlePinToggle}
      />

      {/* ── Create skill modal ── */}
      {showCreateSkill && (
        <CreateSkillModal
          onClose={() => setShowCreateSkill(false)}
          onCreated={async (name) => {
            setShowCreateSkill(false);
            const catalog = await loadSkillsCatalog();
            setSkills(catalog.skills);
            setSkillLibrarySummary(catalog.summary);
            setSkillsStale(catalog.stale);
            setNotice(`Skill '${name}' created.`);
          }}
        />
      )}
    </div>
  );
}
