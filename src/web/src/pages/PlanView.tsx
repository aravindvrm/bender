import { useEffect, useState } from "react";
import type { ProjectState } from "../hooks/useApi";
import { Play, Sparkles, Search, ChevronDown, Lock } from "lucide-react";

interface PlanViewProps {
  state: ProjectState;
  onImplement: () => void;
  onNewTask: () => void;
  onRunTask: (taskId: number) => void;
}

interface ParsedTask {
  id: number;
  title: string;
  description: string;
  files: string[];
  dependencies: string;
  criteria: string;
}

interface AgentOption {
  id: string;
  name: string;
  baseRole: string;
  modelTier: "fast" | "default" | "strong";
  isBuiltin?: boolean;
}

function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const pattern = /###\s*Task\s*(\d+):\s*(.+?)\n([\s\S]*?)(?=\n###\s*Task|\n##\s|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    const body = match[3];
    const descMatch = body.match(/\*\*Description\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const filesMatch = body.match(/`([^`]+\.[a-z]+)`/g);
    const depsMatch = body.match(/\*\*Dependencies\*\*:\s*(.+)/);
    const criteriaMatch = body.match(/\*\*Acceptance criteria\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);

    tasks.push({
      id: parseInt(match[1]),
      title: match[2].trim(),
      description: descMatch ? descMatch[1].trim() : "",
      files: filesMatch ? filesMatch.map((f) => f.replace(/`/g, "")) : [],
      dependencies: depsMatch ? depsMatch[1].trim() : "None",
      criteria: criteriaMatch ? criteriaMatch[1].trim() : "",
    });
  }
  return tasks;
}

function isTaskCompleted(taskId: number, completedTasks: { name: string; content: string }[]): boolean {
  return completedTasks.some((t) => t.content.includes(`Task ${taskId}:`));
}

function parseDependencyIds(depStr: string): number[] {
  if (!depStr || depStr.trim().toLowerCase() === "none") return [];
  const matches = depStr.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

type TaskRunStatus = "completed" | "runnable" | "blocked";

function getTaskRunStatus(
  task: ParsedTask,
  completedTasks: { name: string; content: string }[],
): TaskRunStatus {
  if (isTaskCompleted(task.id, completedTasks)) return "completed";
  const depIds = parseDependencyIds(task.dependencies);
  const allDepsComplete = depIds.every((id) => isTaskCompleted(id, completedTasks));
  return allDepsComplete ? "runnable" : "blocked";
}

type StatusFilter = "all" | "completed" | "pending";

export function PlanView({ state, onImplement, onNewTask, onRunTask }: PlanViewProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [taskAgents, setTaskAgents] = useState<Record<string, string>>(state.taskAgents ?? {});
  const [assigningTaskId, setAssigningTaskId] = useState<number | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  useEffect(() => {
    setTaskAgents(state.taskAgents ?? {});
  }, [state.taskAgents]);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => {
        const all = (data.agents ?? []) as AgentOption[];
        setAgents(all.filter((agent) => agent.baseRole === "implementer"));
      })
      .catch(() => {});
  }, []);

  if (!state.currentTasks) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <div className="text-center space-y-4">
          <p className="text-base font-medium text-zinc-400">No task plan</p>
          <p className="text-sm text-zinc-500">Describe a feature or change to generate tasks.</p>
          <button
            onClick={onNewTask}
            className="flex items-center gap-1.5 px-4 py-2 mx-auto bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-200 transition-colors"
          >
            <Sparkles className="h-4 w-4 text-zinc-400" />
            New Task
          </button>
        </div>
      </div>
    );
  }

  const tasks = parseTasks(state.currentTasks);
  const summaryMatch = state.currentTasks.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##)/);
  const riskMatch = state.currentTasks.match(/##\s*Risk Notes\s*\n([\s\S]*?)$/);

  const tasksWithStatus = tasks.map((task) => ({
    ...task,
    completed: isTaskCompleted(task.id, state.completedTasks),
    runStatus: getTaskRunStatus(task, state.completedTasks),
    assignedAgentId: taskAgents[String(task.id)] ?? "",
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

  async function assignAgent(taskId: number, agentId: string) {
    const previous = taskAgents[String(taskId)] ?? "";
    setAssignError(null);
    setAssigningTaskId(taskId);
    setTaskAgents((prev) => ({ ...prev, [String(taskId)]: agentId }));
    try {
      const res = await fetch(`/api/tasks/agents/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agentId || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to assign agent");
      setTaskAgents(body.assignments ?? {});
    } catch (err) {
      setTaskAgents((prev) => ({ ...prev, [String(taskId)]: previous }));
      setAssignError((err as Error).message);
    } finally {
      setAssigningTaskId(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold text-zinc-100">Task Plan</h2>
          {summaryMatch && (
            <p className="text-xs text-zinc-500 max-w-xl">{summaryMatch[1].trim()}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
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

      {/* Progress bar */}
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

      {/* Filter bar */}
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

      {/* Table */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_88px_120px_140px] gap-3 px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800">
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
              allTasks={tasksWithStatus}
              agents={agents}
              assigning={assigningTaskId === task.id}
              isLast={idx === filtered.length - 1}
              expanded={expandedId === task.id}
              onToggleExpand={() => setExpandedId(expandedId === task.id ? null : task.id)}
              onRun={() => onRunTask(task.id)}
              onAssignAgent={(agentId) => void assignAgent(task.id, agentId)}
            />
          ))
        )}
      </div>

      {/* Risk notes */}
      {riskMatch && (
        <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-lg">
          <h3 className="text-xs font-medium text-amber-400 mb-1.5 uppercase tracking-wider">Risk Notes</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">{riskMatch[1].trim()}</p>
        </div>
      )}
    </div>
  );
}

interface TaskRowProps {
  task: ParsedTask & { completed: boolean; runStatus: TaskRunStatus; assignedAgentId: string };
  allTasks: (ParsedTask & { completed: boolean })[];
  agents: AgentOption[];
  assigning: boolean;
  isLast: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onRun: () => void;
  onAssignAgent: (agentId: string) => void;
}

function TaskRow({ task, allTasks, agents, assigning, isLast, expanded, onToggleExpand, onRun, onAssignAgent }: TaskRowProps) {
  const progress = task.completed ? 100 : 0;
  const barColor = task.completed ? "bg-emerald-500" : "bg-zinc-700";

  const statusLabel = task.completed ? "Completed" : "Pending";
  const statusColors: Record<string, string> = {
    Completed: "text-emerald-400 bg-emerald-500/10",
    Pending: "text-zinc-500 bg-zinc-800",
  };

  const blockedByIds = parseDependencyIds(task.dependencies).filter(
    (id) => !allTasks.find((t) => t.id === id)?.completed,
  );

  return (
    <>
      <div
        className={`grid grid-cols-[1fr_88px_120px_140px] gap-3 px-4 py-3.5 items-center transition-colors hover:bg-zinc-900/40 ${
          !isLast ? "border-b border-zinc-800/60" : ""
        } ${expanded ? "bg-zinc-900/40" : ""}`}
      >
        {/* Task name */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-zinc-600 font-mono shrink-0">#{task.id}</span>
            <span className={`text-sm font-medium truncate ${task.completed ? "text-zinc-500 line-through decoration-zinc-700" : "text-zinc-200"}`}>
              {task.title}
            </span>
          </div>
          {task.description && !expanded && (
            <p className="text-xs text-zinc-600 truncate mt-0.5 ml-6">{task.description}</p>
          )}
        </div>

        {/* Status badge */}
        <div>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${statusColors[statusLabel]}`}>
            {statusLabel}
          </span>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2.5">
          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-zinc-500 tabular-nums w-8 text-right">{progress}%</span>
        </div>

        {/* Action */}
        <div className="flex items-center justify-end gap-1.5">
          {task.runStatus === "runnable" && (
            <button
              onClick={onRun}
              title="Run this task"
              className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-600 bg-zinc-800 text-xs text-zinc-200 hover:bg-zinc-700 hover:border-zinc-500 transition-colors"
            >
              <Play className="h-3 w-3 text-zinc-400" />
              Run
            </button>
          )}
          {task.runStatus === "blocked" && (
            <span
              title={`Waiting on: Task${blockedByIds.length > 1 ? "s" : ""} ${blockedByIds.join(", ")}`}
              className="flex items-center justify-center w-7 h-7 rounded-md border border-zinc-800 text-zinc-600 cursor-default"
            >
              <Lock className="h-3 w-3" />
            </span>
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

      {/* Expanded detail panel */}
      {expanded && (
        <div className={`px-4 pb-4 pt-1 bg-zinc-900/40 space-y-3 ${!isLast ? "border-b border-zinc-800/60" : ""}`}>
          {task.description && (
            <p className="text-sm text-zinc-400 leading-relaxed ml-6">{task.description}</p>
          )}

          {task.files.length > 0 && (
            <div className="ml-6 flex flex-wrap gap-1.5">
              {task.files.map((file) => (
                <span key={file} className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
                  {file}
                </span>
              ))}
            </div>
          )}

          {task.dependencies !== "None" && (
            <div className="ml-6 flex items-start gap-2">
              {task.runStatus === "blocked" && <Lock className="h-3 w-3 text-zinc-600 mt-0.5 shrink-0" />}
              <p className="text-xs text-zinc-500">
                {task.runStatus === "blocked" ? (
                  <>
                    <span className="text-zinc-600">Blocked by: </span>
                    {blockedByIds.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <span className="text-zinc-400 font-mono">#{id}</span>
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    <span className="text-zinc-600">Depends on: </span>
                    <span className="text-zinc-600">{task.dependencies}</span>
                  </>
                )}
              </p>
            </div>
          )}

          {task.criteria && (
            <div className="ml-6">
              <p className="text-xs text-zinc-600 mb-1">Acceptance criteria</p>
              <p className="text-xs text-zinc-400 leading-relaxed">{task.criteria}</p>
            </div>
          )}

          <div className="ml-6 flex items-center gap-2">
            <p className="text-xs text-zinc-600">Agent</p>
            <div className="relative">
              <select
                value={task.assignedAgentId}
                onChange={(e) => onAssignAgent(e.target.value)}
                disabled={assigning}
                className="select-flat pl-2 pr-7 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">Default Implementer</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.modelTier})
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
            </div>
            {assigning && <span className="text-[11px] text-zinc-500">Saving…</span>}
          </div>
        </div>
      )}
    </>
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
