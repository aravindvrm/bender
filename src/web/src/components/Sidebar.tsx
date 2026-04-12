import type { ProjectState } from "../hooks/useApi";

export type View = "console" | "plan" | "architecture" | "brief" | "changes" | "settings";

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  state: ProjectState | null;
}

const navItems: { id: View; label: string; icon: string }[] = [
  { id: "console", label: "Console", icon: "▶" },
  { id: "plan", label: "Tasks", icon: "◎" },
  { id: "architecture", label: "Architecture", icon: "△" },
  { id: "brief", label: "Brief", icon: "◻" },
  { id: "changes", label: "Changes", icon: "±" },
  { id: "settings", label: "Settings", icon: "⊙" },
];

export function Sidebar({ activeView, onViewChange, state }: SidebarProps) {
  const taskCount = state?.currentTasks?.match(/###\s*Task\s*\d+/g)?.length ?? 0;
  const completedCount = state?.completedTasks?.length ?? 0;
  const decisionCount = state?.decisions?.length ?? 0;

  return (
    <aside className="w-56 shrink-0 border-r border-zinc-800 bg-zinc-925 flex flex-col">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-zinc-800">
        <img
          src="/bender_logo_alpha.png"
          alt="Bender"
          className="h-7 w-auto"
        />
        <p className="text-xs text-zinc-500 mt-0.5">software factory</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              activeView === item.id
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            }`}
          >
            <span className="text-base leading-none">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === "plan" && taskCount > 0 && (
              <span className="ml-auto text-xs text-zinc-500">{taskCount}</span>
            )}
            {item.id === "architecture" && decisionCount > 0 && (
              <span className="ml-auto text-xs text-zinc-500">{decisionCount} ADR</span>
            )}
          </button>
        ))}
      </nav>

      {/* Status footer */}
      <div className="px-4 py-4 border-t border-zinc-800 space-y-2">
        {state?.config && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">Stack</span>
              <span className="text-xs text-zinc-400">{state.config.stack.framework}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">LLM</span>
              <span className="text-xs text-zinc-400">{state.config.llm.provider}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">Tasks done</span>
              <span className="text-xs text-zinc-400">{completedCount}</span>
            </div>
          </div>
        )}
        {state?.git && (
          <div className="flex items-center gap-2 pt-1">
            <span className={`w-1.5 h-1.5 rounded-full ${state.git.clean ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span className="text-xs text-zinc-500">{state.git.branch}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
