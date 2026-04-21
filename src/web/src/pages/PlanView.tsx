import { useEffect, useState } from "react";
import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";
import { Play, Sparkles, Search, ChevronDown, Pencil, Trash2, Save, X, GitBranch } from "lucide-react";
import { GitHubIssueImportDialog } from "../components/GitHubIssueImportDialog";

interface PlanViewProps {
  state: ProjectState;
  onImplement: () => void;
  onNewTask: () => void;
  onRunTask: (taskId: string) => void;
  onTasksChanged?: () => Promise<void> | void;
}

interface ParsedTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  implementerAgentId: string;
  status: "todo" | "in_progress" | "done";
}

interface AgentOption {
  id: string;
  name: string;
  baseRole: string;
  modelTier: "fast" | "default" | "strong";
  isBuiltin?: boolean;
}

interface TaskGitHubLink {
  repoFullName?: string;
  issueNumber?: number;
  issueUrl?: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  lastSyncedAt?: number;
}

type TaskStatus = ParsedTask["status"];

function parseCriteriaInput(value: string): string[] {
  const items = value
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  if (items.length > 0) return items;
  return ["Task implemented and tests pass"];
}

function stringifyCriteria(criteria: string[]): string {
  if (criteria.length === 0) return "";
  return criteria.map((item) => `- ${item}`).join("\n");
}

function taskNumericSuffix(taskId: string): string | null {
  const match = taskId.match(/^task-(\d+)$/i);
  return match ? match[1] : null;
}

function isTaskCompleted(task: ParsedTask, completedTasks: { name: string; content: string }[]): boolean {
  if (task.status === "done") return true;
  const legacyId = taskNumericSuffix(task.id);
  return completedTasks.some((entry) => {
    if (entry.content.includes(`Task ${task.id}:`)) return true;
    return legacyId ? entry.content.includes(`Task ${legacyId}:`) : false;
  });
}

function getTaskCompletionProof(task: ParsedTask, completedTasks: { name: string; content: string }[]): string | null {
  const legacyId = taskNumericSuffix(task.id);
  for (let i = completedTasks.length - 1; i >= 0; i -= 1) {
    const entry = completedTasks[i];
    if (entry.content.includes(`Task ${task.id}:`)) return entry.content.trim();
    if (legacyId && entry.content.includes(`Task ${legacyId}:`)) return entry.content.trim();
  }
  return null;
}

type StatusFilter = "all" | "completed" | "pending";

export function PlanView({ state, onImplement, onNewTask, onRunTask, onTasksChanged }: PlanViewProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [taskAgents, setTaskAgents] = useState<Record<string, string>>(state.taskAgents ?? {});
  const [taskGitHubLinks, setTaskGitHubLinks] = useState<Record<string, TaskGitHubLink>>(state.taskGitHubLinks ?? {});
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [deleteDialogTaskId, setDeleteDialogTaskId] = useState<string | null>(null);
  const [showGitHubIssueImportDialog, setShowGitHubIssueImportDialog] = useState(false);

  useEffect(() => {
    setTaskAgents(state.taskAgents ?? {});
  }, [state.taskAgents]);

  useEffect(() => {
    setTaskGitHubLinks(state.taskGitHubLinks ?? {});
  }, [state.taskGitHubLinks]);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => {
        const all = (data.agents ?? []) as AgentOption[];
        setAgents(
          [...all].sort((a, b) => {
            if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
            if (a.baseRole !== b.baseRole) return a.baseRole.localeCompare(b.baseRole);
            if (a.modelTier !== b.modelTier) {
              const tierOrder = { fast: 0, default: 1, strong: 2 } as const;
              return tierOrder[a.modelTier] - tierOrder[b.modelTier];
            }
            return a.name.localeCompare(b.name);
          }),
        );
      })
      .catch(() => {});
  }, []);

  function renderEmptyState() {
    return (
      <>
        <div className="flex items-center justify-center min-h-[320px]">
          <div className="text-center max-w-xs space-y-3">
            <div className="mx-auto w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
              <Sparkles className="w-4 h-4 text-zinc-600" />
            </div>
            <p className="text-[13px] font-medium text-zinc-300">No tasks yet</p>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Describe a feature or change and Bender will break it into a structured, agent-ready task plan.
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                onClick={onNewTask}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-900 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                New Task
              </button>
              <button
                onClick={() => setShowGitHubIssueImportDialog(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 transition-colors"
              >
                <GitBranch className="h-3.5 w-3.5" />
                Import GitHub Issues
              </button>
            </div>
          </div>
        </div>
        {showGitHubIssueImportDialog && (
          <GitHubIssueImportDialog
            onClose={() => setShowGitHubIssueImportDialog(false)}
            onImported={onTasksChanged}
          />
        )}
      </>
    );
  }

  const tasks = (state.currentTaskPlan?.tasks ?? []) as ParsedTask[];
  if (tasks.length === 0) {
    return renderEmptyState();
  }

  const summaryMatch = state.currentTasks?.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##)/);
  const riskMatch = state.currentTasks?.match(/##\s*Risk Notes\s*\n([\s\S]*?)$/);

  const tasksWithStatus = tasks.map((task) => ({
    ...task,
    completed: isTaskCompleted(task, state.completedTasks),
    completionProof: getTaskCompletionProof(task, state.completedTasks),
    assignedAgentId: taskAgents[task.id] ?? task.implementerAgentId ?? "implementer",
    githubLink: taskGitHubLinks[task.id] ?? null,
  }));

  const filtered = tasksWithStatus.filter((task) => {
    if (statusFilter === "completed" && !task.completed) return false;
    if (statusFilter === "pending" && task.completed) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return task.title.toLowerCase().includes(q) || task.description.toLowerCase().includes(q);
    }
    return true;
  });

  const completedCount = tasksWithStatus.filter((t) => t.completed).length;
  const progress = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

  async function assignAgent(taskId: string, agentId: string) {
    const previous = taskAgents[taskId] ?? "";
    setAssignError(null);
    setAssigningTaskId(taskId);
    setTaskAgents((prev) => ({ ...prev, [taskId]: agentId }));
    try {
      const res = await fetch(`/api/tasks/agents/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agentId || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to assign agent");
      setTaskAgents(body.assignments ?? {});
      await onTasksChanged?.();
    } catch (err) {
      setTaskAgents((prev) => ({ ...prev, [taskId]: previous }));
      setAssignError((err as Error).message);
    } finally {
      setAssigningTaskId(null);
    }
  }

  async function saveTaskEdits(
    taskId: string,
    updates: {
      title: string;
      description: string;
      acceptanceCriteria: string[];
      status: TaskStatus;
      implementerAgentId?: string;
    },
  ) {
    setEditError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to update task");
      await onTasksChanged?.();
    } catch (err) {
      setEditError((err as Error).message);
      throw err;
    }
  }

  async function deleteTask(taskId: string) {
    setDeleteError(null);
    setDeletingTaskId(taskId);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cascadeDependents: false }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to delete task");
      setDeleteDialogTaskId(null);
      await onTasksChanged?.();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeletingTaskId(null);
    }
  }

  async function saveTaskGitHubLink(taskId: string, link: Partial<TaskGitHubLink>) {
    setGithubError(null);
    const previous = taskGitHubLinks[taskId] ?? {};
    const optimistic = { ...previous, ...link };
    setTaskGitHubLinks((prev) => ({ ...prev, [taskId]: optimistic }));
    try {
      const res = await fetch(`/api/tasks/links/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(link),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to update task GitHub link");
      setTaskGitHubLinks(body.links ?? {});
      await onTasksChanged?.();
    } catch (err) {
      setTaskGitHubLinks((prev) => ({ ...prev, [taskId]: previous }));
      setGithubError((err as Error).message);
      throw err;
    }
  }

  async function createTaskIssue(taskId: string, repoFullName?: string) {
    setGithubError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/github/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoFullName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to create linked issue");
      if (body.link) {
        setTaskGitHubLinks((prev) => ({ ...prev, [taskId]: body.link as TaskGitHubLink }));
      }
      await onTasksChanged?.();
    } catch (err) {
      setGithubError((err as Error).message);
      throw err;
    }
  }

  async function createTaskBranch(taskId: string, branchName?: string) {
    setGithubError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/github/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to create/switch task branch");
      if (body.link) {
        setTaskGitHubLinks((prev) => ({ ...prev, [taskId]: body.link as TaskGitHubLink }));
      }
      await onTasksChanged?.();
    } catch (err) {
      setGithubError((err as Error).message);
      throw err;
    }
  }

  async function createTaskPR(taskId: string, repoFullName?: string, head?: string) {
    setGithubError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/github/pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoFullName, head }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to open linked PR");
      if (body.link) {
        setTaskGitHubLinks((prev) => ({ ...prev, [taskId]: body.link as TaskGitHubLink }));
      }
      await onTasksChanged?.();
    } catch (err) {
      setGithubError((err as Error).message);
      throw err;
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold text-zinc-100">Task Plan</h2>
          {summaryMatch && (
            <p className="text-xs text-zinc-500 max-w-xl">{summaryMatch[1].trim()}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGitHubIssueImportDialog(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-200 transition-colors"
          >
            <GitBranch className="h-3.5 w-3.5 text-zinc-400" />
            Import Issues
          </button>
          <button
            onClick={onNewTask}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-200 transition-colors"
          >
            <Sparkles className="h-3.5 w-3.5 text-zinc-400" />
            New Task
          </button>
          <button
            onClick={onImplement}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-white border border-zinc-200 rounded-lg text-xs text-zinc-900 font-medium transition-colors"
          >
            <Play className="h-3.5 w-3.5" />
            Implement All
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-xs text-zinc-500 tabular-nums shrink-0">
          {completedCount}/{tasks.length} complete
        </span>
      </div>

      <div className="flex items-center gap-2">
        <StatusSelect value={statusFilter} onChange={setStatusFilter} />
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="w-full pl-8 pr-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
        </div>
      </div>
      {assignError && <p className="text-xs text-red-400">{assignError}</p>}
      {editError && <p className="text-xs text-red-400">{editError}</p>}
      {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
      {githubError && <p className="text-xs text-red-400">{githubError}</p>}

      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_120px_140px] gap-3 px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800">
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Task</span>
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Status</span>
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Progress</span>
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider text-right">Action</span>
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-600">No tasks match your filters.</div>
        ) : (
          filtered.map((task, idx) => (
            <TaskRow
              key={task.id}
              task={task}
              agents={agents}
              assigning={assigningTaskId === task.id}
              isLast={idx === filtered.length - 1}
              expanded={expandedId === task.id}
              onToggleExpand={() => setExpandedId(expandedId === task.id ? null : task.id)}
              onRun={() => onRunTask(task.id)}
              onAssignAgent={(agentId) => void assignAgent(task.id, agentId)}
              onSaveEdits={(updates) => saveTaskEdits(task.id, updates)}
              onDelete={() => setDeleteDialogTaskId(task.id)}
              onSaveGitHubLink={(link) => saveTaskGitHubLink(task.id, link)}
              onCreateIssue={(repoFullName) => createTaskIssue(task.id, repoFullName)}
              onCreateBranch={(branchName) => createTaskBranch(task.id, branchName)}
              onCreatePR={(repoFullName, head) => createTaskPR(task.id, repoFullName, head)}
            />
          ))
        )}
      </div>

      {riskMatch && (
        <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-lg">
          <h3 className="text-xs font-medium text-amber-400 mb-1.5 uppercase tracking-wider">Risk Notes</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">{riskMatch[1].trim()}</p>
        </div>
      )}

      {deleteDialogTaskId !== null && (
        <DeleteTaskDialog
          taskId={deleteDialogTaskId}
          deleting={deletingTaskId === deleteDialogTaskId}
          onCancel={() => setDeleteDialogTaskId(null)}
          onConfirm={() => void deleteTask(deleteDialogTaskId)}
        />
      )}

      {showGitHubIssueImportDialog && (
        <GitHubIssueImportDialog
          onClose={() => setShowGitHubIssueImportDialog(false)}
          onImported={onTasksChanged}
        />
      )}
    </div>
  );
}

interface TaskRowProps {
  task: ParsedTask & {
    completed: boolean;
    completionProof: string | null;
    assignedAgentId: string;
    githubLink: TaskGitHubLink | null;
  };
  agents: AgentOption[];
  assigning: boolean;
  isLast: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onRun: () => void;
  onAssignAgent: (agentId: string) => void;
  onSaveEdits: (updates: {
    title: string;
    description: string;
    acceptanceCriteria: string[];
    status: TaskStatus;
    implementerAgentId?: string;
  }) => Promise<void>;
  onDelete: () => void;
  onSaveGitHubLink: (link: Partial<TaskGitHubLink>) => Promise<void>;
  onCreateIssue: (repoFullName?: string) => Promise<void>;
  onCreateBranch: (branchName?: string) => Promise<void>;
  onCreatePR: (repoFullName?: string, head?: string) => Promise<void>;
}

function TaskRow({
  task,
  agents,
  assigning,
  isLast,
  expanded,
  onToggleExpand,
  onRun,
  onAssignAgent,
  onSaveEdits,
  onDelete,
  onSaveGitHubLink,
  onCreateIssue,
  onCreateBranch,
  onCreatePR,
}: TaskRowProps) {
  const progress = task.completed ? 100 : task.status === "in_progress" ? 50 : 0;
  const barColor = task.completed ? "bg-emerald-500" : task.status === "in_progress" ? "bg-amber-500" : "bg-zinc-700";
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDescription, setDraftDescription] = useState(task.description);
  const [draftCriteria, setDraftCriteria] = useState(stringifyCriteria(task.acceptanceCriteria));
  const [draftStatus, setDraftStatus] = useState<TaskStatus>(task.status);
  const [draftRepoFullName, setDraftRepoFullName] = useState(task.githubLink?.repoFullName ?? "");
  const [draftBranchName, setDraftBranchName] = useState(task.githubLink?.branchName ?? "");
  const [savingGitHubLink, setSavingGitHubLink] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [creatingPR, setCreatingPR] = useState(false);

  const statusLabel = task.status === "done" ? "Done" : task.status === "in_progress" ? "In Progress" : "Todo";
  const statusColors: Record<string, string> = {
    Done: "text-emerald-400 bg-emerald-500/10",
    "In Progress": "text-amber-300 bg-amber-500/10",
    Todo: "text-zinc-500 bg-zinc-800",
  };

  useEffect(() => {
    setDraftTitle(task.title);
    setDraftDescription(task.description);
    setDraftCriteria(stringifyCriteria(task.acceptanceCriteria));
    setDraftStatus(task.status);
    setDraftRepoFullName(task.githubLink?.repoFullName ?? "");
    setDraftBranchName(task.githubLink?.branchName ?? "");
  }, [task.id, task.title, task.description, task.acceptanceCriteria, task.status, task.githubLink?.repoFullName, task.githubLink?.branchName]);

  const showMutableControls = task.status !== "done";

  useEffect(() => {
    if (!showMutableControls) {
      setEditing(false);
    }
  }, [showMutableControls]);

  return (
    <>
      <div
        className={`grid grid-cols-[1fr_120px_120px_140px] gap-3 px-4 py-3.5 items-center transition-colors hover:bg-zinc-900/40 ${
          !isLast ? "border-b border-zinc-800/60" : ""
        } ${expanded ? "bg-zinc-900/40" : ""}`}
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-zinc-600 font-mono shrink-0">{task.id}</span>
            <span className={`text-sm font-medium truncate ${task.completed ? "text-zinc-500 line-through decoration-zinc-700" : "text-zinc-200"}`}>
              {task.title}
            </span>
          </div>
          {task.description && !expanded && (
            <p className="text-xs text-zinc-600 truncate mt-0.5 ml-6">{task.description}</p>
          )}
        </div>

        <div>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${statusColors[statusLabel]}`}>
            {statusLabel}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-zinc-500 tabular-nums w-8 text-right">{progress}%</span>
        </div>

        <div className="flex items-center justify-end gap-1.5">
          {!task.completed && (
            <button
              onClick={onRun}
              title="Run this task"
              className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-600 bg-zinc-800 text-xs text-zinc-200 hover:bg-zinc-700 hover:border-zinc-500 transition-colors"
            >
              <Play className="h-3 w-3 text-zinc-400" />
              Run
            </button>
          )}
          <button
            onClick={onToggleExpand}
            title={expanded ? "Collapse" : "Expand details"}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            Details
            <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className={`px-4 pb-4 pt-1 bg-zinc-900/40 space-y-3 ${!isLast ? "border-b border-zinc-800/60" : ""}`}>
          {showMutableControls && editing ? (
            <div className="ml-6 space-y-2">
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="w-full max-w-xl select-flat px-3 py-1.5 text-sm"
                placeholder="Task title"
              />
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={3}
                className="w-full max-w-2xl bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300"
                placeholder="Task description"
              />
              <textarea
                value={draftCriteria}
                onChange={(e) => setDraftCriteria(e.target.value)}
                rows={4}
                className="w-full max-w-2xl bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-300 font-mono"
                placeholder="- Acceptance criterion 1"
              />
              <div className="relative w-56">
                <select
                  value={draftStatus}
                  onChange={(e) => setDraftStatus(e.target.value as TaskStatus)}
                  className="select-flat w-full pl-2 pr-7 py-1 text-xs"
                >
                  <option value="todo">todo</option>
                  <option value="in_progress">in_progress</option>
                  <option value="done">done</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
              </div>
            </div>
          ) : (
            task.description && (
              <p className="text-sm text-zinc-400 leading-relaxed ml-6">{task.description}</p>
            )
          )}

          {!editing && task.acceptanceCriteria.length > 0 && (
            <div className="ml-6">
              <p className="text-xs text-zinc-600 mb-1">Acceptance criteria</p>
              <ul className="text-xs text-zinc-400 leading-relaxed list-disc ml-4">
                {task.acceptanceCriteria.map((item, idx) => (
                  <li key={`${task.id}-criterion-${idx}`}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {task.completed && (
            <div className="ml-6 space-y-2">
              <p className="text-xs text-zinc-600">Result / Acceptance Proof</p>
              {task.completionProof ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-3">
                  <MarkdownView content={task.completionProof} className="text-xs" />
                </div>
              ) : (
                <p className="text-xs text-zinc-500">No completion proof recorded.</p>
              )}
            </div>
          )}

          {showMutableControls && (
            <>
              <div className="ml-6 flex items-center gap-2">
                <p className="text-xs text-zinc-600">Agent</p>
                <div className="relative">
                  <select
                    value={task.assignedAgentId}
                    onChange={(e) => onAssignAgent(e.target.value)}
                    disabled={assigning}
                    className="select-flat pl-2 pr-7 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="">No specific agent</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.baseRole}{agent.modelTier !== "default" ? ` · ${agent.modelTier}` : ""})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
                </div>
                {assigning && <span className="text-[11px] text-zinc-500">Saving…</span>}
              </div>

              <div className="ml-6 space-y-2 pt-1">
                <p className="text-xs text-zinc-600">GitHub Linkage</p>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2 max-w-3xl">
                  <input
                    value={draftRepoFullName}
                    onChange={(e) => setDraftRepoFullName(e.target.value)}
                    className="select-flat px-3 py-1.5 text-xs font-mono"
                    placeholder="owner/repo"
                  />
                  <input
                    value={draftBranchName}
                    onChange={(e) => setDraftBranchName(e.target.value)}
                    className="select-flat px-3 py-1.5 text-xs font-mono"
                    placeholder="task/123-short-name"
                  />
                  <button
                    disabled={savingGitHubLink}
                    onClick={async () => {
                      setSavingGitHubLink(true);
                      try {
                        await onSaveGitHubLink({
                          repoFullName: draftRepoFullName.trim() || undefined,
                          branchName: draftBranchName.trim() || undefined,
                        });
                      } finally {
                        setSavingGitHubLink(false);
                      }
                    }}
                    className="px-2 py-1 text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {savingGitHubLink ? "Saving..." : "Save Link"}
                  </button>
                </div>
                <div className="flex items-center flex-wrap gap-2 text-xs">
                  <button
                    disabled={creatingIssue}
                    onClick={async () => {
                      setCreatingIssue(true);
                      try {
                        await onCreateIssue(draftRepoFullName.trim() || undefined);
                      } finally {
                        setCreatingIssue(false);
                      }
                    }}
                    className="px-2 py-1 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {creatingIssue ? "Creating issue..." : "Create Linked Issue"}
                  </button>
                  <button
                    disabled={creatingBranch}
                    onClick={async () => {
                      setCreatingBranch(true);
                      try {
                        await onCreateBranch(draftBranchName.trim() || undefined);
                      } finally {
                        setCreatingBranch(false);
                      }
                    }}
                    className="px-2 py-1 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {creatingBranch ? "Switching..." : "Create/Switch Branch"}
                  </button>
                  <button
                    disabled={creatingPR}
                    onClick={async () => {
                      setCreatingPR(true);
                      try {
                        await onCreatePR(draftRepoFullName.trim() || undefined, draftBranchName.trim() || undefined);
                      } finally {
                        setCreatingPR(false);
                      }
                    }}
                    className="px-2 py-1 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {creatingPR ? "Opening PR..." : "Open PR"}
                  </button>
                  {task.githubLink?.issueUrl && (
                    <a
                      href={task.githubLink.issueUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-2"
                    >
                      Issue #{task.githubLink.issueNumber ?? "?"}
                    </a>
                  )}
                  {task.githubLink?.prUrl && (
                    <a
                      href={task.githubLink.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-2"
                    >
                      PR #{task.githubLink.prNumber ?? "?"}
                    </a>
                  )}
                </div>
              </div>

              <div className="ml-6 flex items-center gap-2 pt-1">
                {!editing ? (
                  <>
                    <button
                      onClick={() => setEditing(true)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                    <button
                      onClick={onDelete}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-red-900/60 text-red-300 hover:bg-red-950/30"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      disabled={saving || !draftTitle.trim()}
                      onClick={async () => {
                        setSaving(true);
                        try {
                          await onSaveEdits({
                            title: draftTitle.trim(),
                            description: draftDescription.trim(),
                            acceptanceCriteria: parseCriteriaInput(draftCriteria),
                            status: draftStatus,
                            implementerAgentId: task.assignedAgentId || undefined,
                          });
                          setEditing(false);
                        } finally {
                          setSaving(false);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <Save className="h-3 w-3" />
                      Save
                    </button>
                    <button
                      disabled={saving}
                      onClick={() => {
                        setEditing(false);
                        setDraftTitle(task.title);
                        setDraftDescription(task.description);
                        setDraftCriteria(stringifyCriteria(task.acceptanceCriteria));
                        setDraftStatus(task.status);
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                    >
                      <X className="h-3 w-3" />
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function DeleteTaskDialog({
  taskId,
  deleting,
  onCancel,
  onConfirm,
}: {
  taskId: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-lg">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-100">Delete {taskId}</h3>
        </div>
        <div className="px-4 py-4 space-y-3 text-sm">
          <p className="text-zinc-300">This will remove {taskId} from the current plan.</p>
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="px-3 py-1.5 text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="px-3 py-1.5 text-xs border border-red-900/60 text-red-200 hover:bg-red-950/30 disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface StatusSelectProps {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}

function StatusSelect({ value, onChange }: StatusSelectProps) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as StatusFilter)}
        className="select-flat pl-3 pr-7 py-1.5 text-xs cursor-pointer"
      >
        <option value="all">All Statuses</option>
        <option value="completed">Completed</option>
        <option value="pending">Pending</option>
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
    </div>
  );
}
