import { useState } from "react";
import { useProjectState } from "./hooks/useApi";
import { Sidebar } from "./components/Sidebar";
import { PlanView } from "./pages/PlanView";
import { ArchitectureView } from "./pages/ArchitectureView";
import { BriefView } from "./pages/BriefView";

type View = "plan" | "architecture" | "brief";

export function App() {
  const [activeView, setActiveView] = useState<View>("plan");
  const { state, loading, error } = useProjectState();

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

  if (!state?.initialized) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-semibold text-zinc-100">bender</h1>
          <p className="text-zinc-500 mt-2">No project initialized</p>
          <p className="text-sm text-zinc-500 mt-4">
            Run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender init</code> to create a project.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden bg-zinc-950">
      <Sidebar activeView={activeView} onViewChange={setActiveView} state={state} />

      <main className="flex-1 overflow-y-auto">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-800 px-6 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-300 capitalize">{activeView}</h2>
            {state.git && (
              <div className="flex items-center gap-3 text-xs text-zinc-500">
                {state.git.recentCommits[0] && (
                  <span className="font-mono">{state.git.recentCommits[0].hash} {state.git.recentCommits[0].message.slice(0, 50)}</span>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <div className="p-6">
          {activeView === "plan" && <PlanView state={state} />}
          {activeView === "architecture" && <ArchitectureView state={state} />}
          {activeView === "brief" && <BriefView state={state} />}
        </div>
      </main>
    </div>
  );
}
