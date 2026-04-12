import { useState } from "react";
import { useProjectState } from "./hooks/useApi";
import { Sidebar, type View } from "./components/Sidebar";
import { ConsoleView } from "./pages/ConsoleView";
import { PlanView } from "./pages/PlanView";
import { ArchitectureView } from "./pages/ArchitectureView";
import { BriefView } from "./pages/BriefView";
import { ChangesView } from "./pages/ChangesView";
import { SettingsView } from "./pages/SettingsView";

const VIEW_LABELS: Record<View, string> = {
  console: "Console",
  plan: "Tasks",
  architecture: "Architecture",
  brief: "Brief",
  changes: "Changes",
  settings: "Settings",
};

export function App() {
  const [activeView, setActiveView] = useState<View>("console");
  const { state, loading, error, refresh } = useProjectState();

  if (loading && !state) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-zinc-500 mt-3">Connecting...</p>
        </div>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center max-w-md">
          <p className="text-zinc-400">Could not connect to bender</p>
          <p className="text-sm text-zinc-500 mt-2">
            Make sure <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender review</code> is running.
          </p>
          <p className="text-xs text-red-400/60 mt-4 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  // Console and Settings work even without an initialized project
  const needsInit = !state?.initialized && activeView !== "console" && activeView !== "settings";

  return (
    <div className="h-screen flex overflow-hidden bg-zinc-950">
      <Sidebar activeView={activeView} onViewChange={setActiveView} state={state} />

      <main className="flex-1 overflow-y-auto flex flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-800 px-6 py-3 shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-300">{VIEW_LABELS[activeView]}</h2>
            {state?.git && (
              <div className="flex items-center gap-3 text-xs text-zinc-500">
                {state.git.recentCommits[0] && (
                  <span className="font-mono">{state.git.recentCommits[0].hash} {state.git.recentCommits[0].message.slice(0, 50)}</span>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        {needsInit ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <h1 className="text-2xl font-semibold text-zinc-100">bender</h1>
              <p className="text-zinc-500 mt-2">No project initialized</p>
              <p className="text-sm text-zinc-500 mt-4">
                Use the <button onClick={() => setActiveView("console")} className="text-zinc-300 underline underline-offset-2">Console</button> to run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">New Project</code>, or run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender init</code> from the terminal.
              </p>
            </div>
          </div>
        ) : (
          <div className={`${activeView === "console" ? "flex-1 flex flex-col p-6" : "p-6"}`}>
            {activeView === "console" && (
              <ConsoleView state={state} onStateChange={refresh} />
            )}
            {activeView === "plan" && state && <PlanView state={state} />}
            {activeView === "architecture" && state && <ArchitectureView state={state} />}
            {activeView === "brief" && state && <BriefView state={state} />}
            {activeView === "changes" && state && <ChangesView state={state} />}
            {activeView === "settings" && <SettingsView />}
          </div>
        )}
      </main>
    </div>
  );
}
