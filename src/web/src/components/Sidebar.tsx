import type { ProjectState } from "../hooks/useApi";
import { ProjectSelector } from "./ProjectSelector";
import {
  FileText,
  FilePlus,
  FolderTree,
  GitCompareArrows,
  MonitorCog,
  ScanSearch,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type View = "plan" | "architecture" | "brief" | "changes" | "settings";

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  state: ProjectState | null;
  onProjectChange: () => void;
  onGlobalAction: (action: "new-project" | "analyze") => void;
}

const projectNav: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "brief", label: "Overview", icon: FileText },
  { id: "plan", label: "Tasks", icon: MonitorCog },
  { id: "architecture", label: "Architecture", icon: FolderTree },
  { id: "changes", label: "Changes", icon: GitCompareArrows },
];

export function Sidebar({ activeView, onViewChange, state, onProjectChange, onGlobalAction }: SidebarProps) {
  const taskCount = state?.currentTasks?.match(/###\s*Task\s*\d+/g)?.length ?? 0;
  const completedCount = state?.completedTasks?.length ?? 0;
  const decisionCount = state?.decisions?.length ?? 0;
  const projectName = state?.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? "No Project";
  const hasProject = !!state?.projectRoot;

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
          <FilePlus className="h-4 w-4" />
        </button>

        {/* Analyze project */}
        <button
          onClick={() => onGlobalAction("analyze")}
          disabled={!hasProject}
          title="Analyze Project"
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ScanSearch className="h-4 w-4" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Git status */}
        {state?.git && (
          <div
            title={state.git.clean ? "Working tree clean" : `Branch: ${state.git.branch}`}
            className="w-9 h-9 flex items-center justify-center"
          >
            <span className={`w-2 h-2 rounded-full ${state.git.clean ? "bg-emerald-500" : "bg-amber-400"}`} />
          </div>
        )}

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
        <nav className="flex-1 px-2 py-3 space-y-0.5">
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
                className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
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

        {/* Footer info */}
        {state?.config && (
          <div className="px-4 py-3 border-t border-zinc-800/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-600">Stack</span>
              <span className="text-[11px] text-zinc-400">{state.config.stack.framework}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-600">LLM</span>
              <span className="text-[11px] text-zinc-400">{state.config.llm.provider}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-600">Tasks done</span>
              <span className="text-[11px] text-zinc-400">{completedCount}</span>
            </div>
            {state.git && (
              <div className="flex items-center gap-1.5 pt-1 border-t border-zinc-800/60">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state.git.clean ? "bg-emerald-500" : "bg-amber-400"}`} />
                <span className="text-[11px] text-zinc-600 truncate">{state.git.branch}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
