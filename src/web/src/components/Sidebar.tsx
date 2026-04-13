import { useState, useEffect } from "react";
import type { ProjectState } from "../hooks/useApi";
import type { OperationStatus } from "../hooks/useOperation";
import { ProjectSelector } from "./ProjectSelector";
import {
  FileText,
  CirclePlus,
  FolderTree,
  GitCompareArrows,
  MonitorCog,
  ScanEye,
  Settings,
  Bot,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type View = "plan" | "architecture" | "brief" | "git" | "agents" | "settings";

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

interface TokenStats {
  inputTokens: number;
  outputTokens: number;
}

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  state: ProjectState | null;
  onProjectChange: () => void;
  onGlobalAction: (action: "new-project" | "analyze") => void;
  operationStatus?: OperationStatus;
  operationLabel?: string | null;
}

const projectNav: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "brief", label: "Overview", icon: FileText },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "plan", label: "Tasks", icon: MonitorCog },
  { id: "architecture", label: "Architecture", icon: FolderTree },
  { id: "git", label: "Git", icon: GitCompareArrows },
];

export function Sidebar({ activeView, onViewChange, state, onProjectChange, onGlobalAction, operationStatus, operationLabel }: SidebarProps) {
  const taskCount = state?.currentTasks?.match(/###\s*Task\s*\d+/g)?.length ?? 0;
  const completedCount = state?.completedTasks?.length ?? 0;
  const decisionCount = state?.decisions?.length ?? 0;
  const projectName = state?.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? "No Project";
  const hasProject = !!state?.projectRoot;
  const isRunning = operationStatus === "running";

  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null);

  // Load token usage from logs periodically
  useEffect(() => {
    if (!hasProject) return;

    function loadTokens() {
      fetch("/api/logs?limit=500")
        .then((r) => r.json())
        .then((data: { entries?: Array<{ data?: { inputTokens?: number; outputTokens?: number } }> }) => {
          let input = 0;
          let output = 0;
          for (const entry of data.entries ?? []) {
            if (entry.data?.inputTokens) input += entry.data.inputTokens;
            if (entry.data?.outputTokens) output += entry.data.outputTokens;
          }
          if (input + output > 0) setTokenStats({ inputTokens: input, outputTokens: output });
        })
        .catch(() => { /* ignore */ });
    }

    loadTokens();
    const id = setInterval(loadTokens, 30000);
    return () => clearInterval(id);
  }, [hasProject, operationStatus]); // re-fetch after operations

  return (
    <aside className="w-[280px] shrink-0 border-r border-zinc-800 bg-zinc-950 flex overflow-visible">

      {/* Narrow icon rail — global controls */}
      <div className="w-[52px] shrink-0 border-r border-zinc-800/60 flex flex-col items-center py-3 gap-1">

        {/* Project switcher */}
        <ProjectSelector
          compact
          currentPath={state?.projectRoot ?? null}
          onProjectChange={onProjectChange}
        />

        {/* New project */}
        <button
          onClick={() => onGlobalAction("new-project")}
          title="New Project"
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
        >
          <CirclePlus className="h-4 w-4" />
        </button>

        {/* Analyze project */}
        <button
          onClick={() => onGlobalAction("analyze")}
          disabled={!hasProject}
          title="Analyze Project"
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ScanEye className="h-4 w-4" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings */}
        <button
          onClick={() => onViewChange("settings")}
          title="Settings"
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
            activeView === "settings"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
          }`}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Main panel — project-specific */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Project header */}
        <div className="px-4 pt-2 pb-2 border-b border-zinc-800/60">
          <img src="/bender_logo_alpha.png" alt="Bender" className="h-6 w-auto mb-1" />
          <p className="text-[10px] font-medium text-zinc-600 uppercase tracking-widest mb-1">Project</p>
          <p className="text-sm font-semibold text-zinc-100 truncate">{projectName}</p>
        </div>

        {/* Project nav */}
        <nav className="flex-1 py-3">
          {projectNav.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            const badge =
              item.id === "plan"
                ? taskCount
                : item.id === "architecture"
                  ? decisionCount
                  : null;

            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`w-full flex items-center gap-2.5 rounded-none px-4 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-zinc-800/80 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${isActive ? "text-zinc-300" : "text-zinc-500"}`} />
                <span className="flex-1 text-left text-[13px]">{item.label}</span>
                {badge !== null && badge > 0 && (
                  <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
                    isActive ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"
                  }`}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Running task notification */}
        {isRunning && (
          <div className="px-4 py-2 border-t border-zinc-800/60 bg-zinc-900/40">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse shrink-0" />
              <span className="text-[11px] text-zinc-400 truncate">
                {operationLabel ?? "Running…"}
              </span>
            </div>
            {/* Indeterminate progress bar */}
            <div className="h-0.5 w-full bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-zinc-500 rounded-full animate-[progress-slide_1.5s_ease-in-out_infinite]"
                style={{ width: "40%", animation: "progressSlide 1.5s ease-in-out infinite" }}
              />
            </div>
          </div>
        )}

        {/* Footer info */}
        <div className="px-4 py-3 border-t border-zinc-800/60 space-y-1.5">
          {state?.config ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">Stack</span>
                <span className="text-[11px] text-zinc-400 truncate max-w-[120px] text-right">
                  {state.config.stack.framework || "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">LLM</span>
                <span className="text-[11px] text-zinc-400 capitalize">
                  {state.config.llm.provider || "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">Tasks done</span>
                <span className={`text-[11px] font-medium ${completedCount > 0 ? "text-emerald-400/80" : "text-zinc-500"}`}>
                  {completedCount}
                </span>
              </div>
            </>
          ) : hasProject ? (
            <p className="text-[11px] text-zinc-600 italic">Loading config…</p>
          ) : null}

          {tokenStats && (
            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
              <span className="text-[11px] text-zinc-600 flex items-center gap-1">
                <Zap className="h-2.5 w-2.5" /> Tokens
              </span>
              <span className="text-[11px] text-zinc-500 tabular-nums">
                {formatTokenCount(tokenStats.inputTokens + tokenStats.outputTokens)}
              </span>
            </div>
          )}

          {state?.git && (
            <div className="flex items-center gap-1.5 pt-1 border-t border-zinc-800/60">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state.git.clean ? "bg-emerald-500" : "bg-amber-400"}`} />
              <span className="text-[11px] text-zinc-600 truncate">{state.git.branch || "main"}</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
