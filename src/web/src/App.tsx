import { useState } from "react";
import { useProjectState } from "./hooks/useApi";
import { useOperation } from "./hooks/useOperation";
import { Sidebar, type View } from "./components/Sidebar";
import { OperationDrawer } from "./components/OperationDrawer";
import { PlanView } from "./pages/PlanView";
import { ArchitectureView } from "./pages/ArchitectureView";
import { BriefView } from "./pages/BriefView";
import { ChangesView } from "./pages/ChangesView";
import { SettingsView } from "./pages/SettingsView";

const VIEW_LABELS: Record<View, string> = {
  plan: "Tasks",
  architecture: "Architecture",
  brief: "Overview",
  changes: "Changes",
  settings: "Settings",
};

export function App() {
  const [activeView, setActiveView] = useState<View>("brief");
  const { state, loading, error, refresh } = useProjectState();
  const op = useOperation(refresh);

  if (loading && !state) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-zinc-500 mt-3">Connecting…</p>
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
            Make sure <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender bend</code> is running.
          </p>
          <p className="text-xs text-red-400/60 mt-4 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  const hasProject = !!state?.projectRoot;
  const isInitialized = state?.initialized ?? false;
  const needsProject = !hasProject && activeView !== "settings";
  const needsInit = hasProject && !isInitialized && activeView !== "settings";

  function handleGlobalAction(action: "new-project" | "analyze") {
    if (action === "new-project") {
      op.setModal({ kind: "init" });
      op.setDrawerOpen(true);
    } else {
      op.startOperation("/api/run/analyze", {});
    }
  }

  function handleSubmitModal(kind: "init" | "plan", text: string) {
    if (kind === "init") {
      op.startOperation("/api/run/init", { description: text });
    } else {
      op.startOperation("/api/run/plan", { feature: text });
    }
  }

  return (
    <div className="h-screen flex overflow-hidden bg-zinc-950">
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        state={state}
        onProjectChange={refresh}
        onGlobalAction={handleGlobalAction}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-800 px-6 py-3 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-medium text-zinc-300">{VIEW_LABELS[activeView]}</h2>
            <div className="flex-1" />
            {state?.git?.recentCommits[0] && (
              <span className="text-xs text-zinc-600 font-mono hidden lg:block">
                {state.git.recentCommits[0].hash} {state.git.recentCommits[0].message.slice(0, 40)}
              </span>
            )}
          </div>
        </header>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {needsProject ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-sm space-y-3">
                <p className="text-zinc-400 font-medium">No project selected</p>
                <p className="text-sm text-zinc-500">
                  Use the folder icon in the left rail to open a project.
                </p>
              </div>
            </div>
          ) : needsInit ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-sm space-y-4">
                <p className="text-zinc-400 font-medium">Project not initialized</p>
                <p className="text-sm text-zinc-500">
                  Click <strong className="text-zinc-300">New Project</strong> in the left rail to initialize this directory with Bender.
                </p>
                <button
                  onClick={() => handleGlobalAction("new-project")}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-200 transition-colors"
                >
                  New Project
                </button>
              </div>
            </div>
          ) : (
            <div className="p-6">
              {activeView === "brief" && state && (
                <BriefView
                  state={state}
                  onPlanFeature={() => { op.setModal({ kind: "plan" }); op.setDrawerOpen(true); }}
                />
              )}
              {activeView === "plan" && state && (
                <PlanView
                  state={state}
                  onImplement={() => op.startOperation("/api/run/implement", {})}
                />
              )}
              {activeView === "architecture" && state && <ArchitectureView state={state} />}
              {activeView === "changes" && state && <ChangesView state={state} />}
              {activeView === "settings" && <SettingsView />}
            </div>
          )}
        </div>

        {/* Operation drawer — sits at the bottom of the main column */}
        <OperationDrawer
          lines={op.lines}
          status={op.status}
          drawerOpen={op.drawerOpen}
          modal={op.modal}
          inputText={op.inputText}
          onSetDrawerOpen={op.setDrawerOpen}
          onSetModal={op.setModal}
          onSetInputText={op.setInputText}
          onConfirm={op.handleConfirm}
          onPromptSubmit={op.handlePromptSubmit}
          onClear={op.clearOutput}
          onAbort={op.abort}
          onSubmitModal={handleSubmitModal}
        />
      </main>
    </div>
  );
}
