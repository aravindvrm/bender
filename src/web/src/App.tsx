import { useState } from "react";
import { useProjectState } from "./hooks/useApi";
import { Sidebar, type View } from "./components/Sidebar";
import { ProjectSelector } from "./components/ProjectSelector";
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
  brief: "Plan",
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
            Make sure <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender bend</code> (or <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">npm run bend</code>) is running.
          </p>
          <p className="text-xs text-red-400/60 mt-4 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  const hasProject = !!state?.projectRoot;
  const isInitialized = state?.initialized ?? false;

  // Views that need a project to be useful
  const needsProject = !hasProject && activeView !== "settings";
  const needsInit = hasProject && !isInitialized && activeView !== "console" && activeView !== "settings";

  return (
    <div className="h-screen flex overflow-hidden bg-zinc-950">
      <Sidebar activeView={activeView} onViewChange={setActiveView} state={state} />

      <main className="flex-1 overflow-y-auto flex flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-800 px-6 py-3 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-medium text-zinc-300 w-28 shrink-0">{VIEW_LABELS[activeView]}</h2>
            <ProjectSelector
              currentPath={state?.projectRoot ?? null}
              onProjectChange={refresh}
            />
            <div className="flex-1" />
            {state?.git?.recentCommits[0] && (
              <span className="text-xs text-zinc-600 font-mono hidden lg:block">
                {state.git.recentCommits[0].hash} {state.git.recentCommits[0].message.slice(0, 40)}
              </span>
            )}
          </div>
        </header>

        {/* Content */}
        {needsProject ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm space-y-4">
              <p className="text-zinc-400 font-medium">No project selected</p>
              <p className="text-sm text-zinc-500">
                Use the project picker above to open an existing project or create a new one.
              </p>
              <p className="text-sm text-zinc-600">
                Or run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-400">bender bend --dir /your/project</code> (or <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-400">npm run start -- bend --dir /your/project</code>)
              </p>
            </div>
          </div>
        ) : needsInit ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm space-y-4">
              <p className="text-zinc-400 font-medium">Project not initialized</p>
              <p className="text-sm text-zinc-500">
                <button onClick={() => setActiveView("console")} className="text-zinc-300 underline underline-offset-2">
                  Go to Console
                </button>{" "}
                and run <strong>New Project</strong> to set up this directory.
              </p>
            </div>
          </div>
        ) : (
          <div className={`${activeView === "console" ? "flex-1 flex flex-col p-6" : "p-6"}`}>
            {activeView === "console" && <ConsoleView state={state} onStateChange={refresh} />}
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
