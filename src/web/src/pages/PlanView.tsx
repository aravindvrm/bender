import type { ProjectState } from "../hooks/useApi";
import { Play } from "lucide-react";

interface PlanViewProps {
  state: ProjectState;
  onImplement: () => void;
}

interface ParsedTask {
  id: number;
  title: string;
  description: string;
  files: string[];
  dependencies: string;
  criteria: string;
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

export function PlanView({ state, onImplement }: PlanViewProps) {
  if (!state.currentTasks) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <div className="text-center">
          <p className="text-lg">No task plan</p>
          <p className="text-sm mt-1">Run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender init</code> or <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender plan</code></p>
        </div>
      </div>
    );
  }

  const tasks = parseTasks(state.currentTasks);
  const summaryMatch = state.currentTasks.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##)/);
  const riskMatch = state.currentTasks.match(/##\s*Risk Notes\s*\n([\s\S]*?)$/);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Action bar */}
      <div className="flex items-center justify-end mb-6">
        <button
          onClick={onImplement}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-200 transition-colors"
        >
          <Play className="h-4 w-4 text-zinc-400" />
          Implement Tasks
        </button>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-zinc-100">Task Plan</h2>
        {summaryMatch && (
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">{summaryMatch[1].trim()}</p>
        )}
        <div className="flex items-center gap-4 mt-4">
          <span className="text-xs text-zinc-500">
            {tasks.length} tasks
          </span>
          <span className="text-xs text-zinc-500">
            {state.completedTasks.length} completed
          </span>
          <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500/80 rounded-full transition-all duration-500"
              style={{ width: `${tasks.length > 0 ? (state.completedTasks.length / tasks.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-3">
        {tasks.map((task) => {
          const completed = isTaskCompleted(task.id, state.completedTasks);
          return (
            <TaskCard key={task.id} task={task} completed={completed} />
          );
        })}
      </div>

      {/* Risk notes */}
      {riskMatch && (
        <div className="mt-8 p-4 bg-amber-500/5 border border-amber-500/20 rounded-lg">
          <h3 className="text-sm font-medium text-amber-400 mb-2">Risk Notes</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">{riskMatch[1].trim()}</p>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, completed }: { task: ParsedTask; completed: boolean }) {
  return (
    <div className={`border rounded-lg p-4 transition-colors ${
      completed
        ? "border-zinc-800 bg-zinc-900/30"
        : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"
    }`}>
      <div className="flex items-start gap-3">
        {/* Status indicator */}
        <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
          completed
            ? "border-emerald-500 bg-emerald-500/10"
            : "border-zinc-600"
        }`}>
          {completed && (
            <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Title */}
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-zinc-500 font-mono">#{task.id}</span>
            <h3 className={`text-sm font-medium ${completed ? "text-zinc-500 line-through" : "text-zinc-200"}`}>
              {task.title}
            </h3>
          </div>

          {/* Description */}
          {task.description && (
            <p className={`text-sm mt-1 leading-relaxed ${completed ? "text-zinc-600" : "text-zinc-400"}`}>
              {task.description}
            </p>
          )}

          {/* Files */}
          {task.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {task.files.map((file) => (
                <span
                  key={file}
                  className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono"
                >
                  {file}
                </span>
              ))}
            </div>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-4 mt-2">
            {task.dependencies !== "None" && (
              <span className="text-xs text-zinc-500">
                Depends: {task.dependencies}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
