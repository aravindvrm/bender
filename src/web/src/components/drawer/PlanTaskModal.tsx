import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { BaseRole } from "../../lib/roleLabels";

export interface TaskCreateSubmission {
  title?: string;
  description: string;
  agentId?: string;
}

interface AgentOption {
  id: string;
  name: string;
  baseRole: BaseRole;
  modelTier: "fast" | "default" | "strong";
  isBuiltin?: boolean;
}

function formatAgentOptionLabel(agent: AgentOption, roleOption: BaseRole): string {
  const builtinSuffix = agent.isBuiltin ? " [builtin]" : "";
  const isRoleDefaultBuiltin = agent.id === `default-${roleOption}`;
  const roleSuffix = ` · ${agent.baseRole}`;
  if (isRoleDefaultBuiltin || agent.modelTier === "default") {
    return `${agent.name}${roleSuffix}${builtinSuffix}`;
  }
  return `${agent.name} (${agent.modelTier})${roleSuffix}${builtinSuffix}`;
}

interface PlanTaskModalProps {
  initialDescription: string;
  onSubmit: (submission: TaskCreateSubmission) => Promise<void>;
  onCancel: () => void;
}

export function PlanTaskModal({ initialDescription, onSubmit, onCancel }: PlanTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(initialDescription);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgents((data.agents ?? []) as AgentOption[]))
      .catch(() => setAgents([]));
  }, []);

  const selectableAgents = [...agents]
    .sort((a, b) => {
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
      if (a.baseRole !== b.baseRole) {
        return a.baseRole.localeCompare(b.baseRole);
      }
      if (a.modelTier !== b.modelTier) {
        const tierOrder = { fast: 0, default: 1, strong: 2 } as const;
        return tierOrder[a.modelTier] - tierOrder[b.modelTier];
      }
      return a.name.localeCompare(b.name);
    });

  const canSubmit = description.trim().length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        description: description.trim(),
        agentId: agentId || undefined,
      });
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">New Task</h3>
        </div>
        <div className="p-5 space-y-5 overflow-y-auto">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Title (optional)</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short task title (auto-derived from description if omitted)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Task Description</label>
            <textarea
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what should be done, expected outcome, and constraints..."
              rows={7}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSubmit();
                }
                if (e.key === "Escape" && !submitting) onCancel();
              }}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Agent Preference (optional)</label>
            <div className="relative">
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="select-flat w-full pl-3 pr-8 py-2 text-sm"
              >
                <option value="">No specific agent</option>
                {selectableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {formatAgentOptionLabel(agent, agent.baseRole)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            </div>
          </div>

          {submitError && <p className="text-xs text-red-400">{submitError}</p>}
          <p className="text-xs text-zinc-600">⌘ Enter to create task</p>
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => { void handleSubmit(); }}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            {submitting ? "Creating..." : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
