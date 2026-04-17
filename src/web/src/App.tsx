import { useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useProjectState } from "./hooks/useApi";
import { useOperation } from "./hooks/useOperation";
import { Sidebar, type View } from "./components/Sidebar";
import { OperationDrawer, type InitModalSubmission } from "./components/OperationDrawer";
import { LoadingDots } from "./components/LoadingDots";
import { GitDiffSidebar } from "./components/GitDiffSidebar";
import { PlanView } from "./pages/PlanView";
import { ArchitectureView } from "./pages/ArchitectureView";
import { BriefView } from "./pages/BriefView";
import { GitView } from "./pages/ChangesView";
import { SettingsView } from "./pages/SettingsView";
import { AgentsView } from "./pages/AgentsView";
import { EvalsView } from "./pages/EvalsView";

interface PlanRunSubmission {
  feature: string;
  role: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
  agentId?: string;
  officeHoursMode?: "pressure-test" | "execution-plan";
  askClarifyingQuestions: boolean;
  requireArchitectureApproval: boolean;
  requirePlanApproval: boolean;
}

const VIEW_LABELS: Record<View, string> = {
  plan: "Tasks",
  architecture: "Architecture",
  brief: "Overview",
  evals: "Evals",
  git: "Git",
  agents: "Agents",
  settings: "Settings",
};

export function App() {
  const [activeView, setActiveView] = useState<View>("brief");
  const [diffSidebarOpen, setDiffSidebarOpen] = useState(false);
  const { state, loading, error, refresh } = useProjectState();
  const op = useOperation(refresh);
  const operationLabel = op.lines.find((line) => line.kind === "header")?.text ?? null;
  const projectTitle = state?.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? "No Project";

  if (loading && !state) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center">
          <LoadingDots className="justify-center" size={34} label="Connecting…" textClassName="text-sm text-zinc-500" />
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
  const allowsNoProject = activeView === "settings" || activeView === "agents";
  const needsProject = !hasProject && !allowsNoProject;
  const needsInit = hasProject && !isInitialized && !allowsNoProject;

  function handleGlobalAction(action: "new-project" | "analyze") {
    if (action === "new-project") {
      op.setModal({ kind: "init" });
      op.setDrawerOpen(true);
    } else {
      op.startOperation("/api/run/analyze", {}, { onSuccess: () => setActiveView("architecture") });
    }
  }

  function handleSubmitInit(submission: InitModalSubmission) {
    op.startOperation("/api/run/init", submission);
  }

  function handleSubmitPlan(submission: PlanRunSubmission) {
    op.startOperation("/api/run/plan", submission);
  }

  return (
    <div className="h-screen flex overflow-hidden bg-zinc-950">
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        state={state}
        onProjectChange={refresh}
        onGlobalAction={handleGlobalAction}
        operationStatus={op.status}
        operationLabel={operationLabel}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-800 px-6 h-10 shrink-0">
          <div className="relative flex items-center gap-4 h-full">
            <h2 className="text-xs font-medium text-zinc-300">{VIEW_LABELS[activeView]}</h2>
            <div className="absolute left-1/2 -translate-x-1/2 max-w-[45vw] truncate text-xs font-medium text-zinc-500 text-center pointer-events-none">
              {projectTitle}
            </div>
            <div className="flex-1" />
            {state?.git?.recentCommits[0] && (
              <span className="text-[11px] text-zinc-600 font-mono hidden lg:block">
                {state.git.recentCommits[0].hash} {state.git.recentCommits[0].message.slice(0, 40)}
              </span>
            )}
            {hasProject && (
              <button
                onClick={() => setDiffSidebarOpen((v) => !v)}
                title={diffSidebarOpen ? "Close review panel" : "Open review panel"}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                {diffSidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto text-[13px]">
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
                      This looks like an existing codebase. Run <strong className="text-zinc-300">Analyze Project</strong> to generate the initial Bender brief and architecture.
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => handleGlobalAction("analyze")}
                        className="px-4 py-2 bg-zinc-100 hover:bg-white border border-zinc-200 rounded-lg text-sm text-zinc-900 transition-colors"
                      >
                        Analyze Project
                      </button>
                      <button
                        onClick={() => handleGlobalAction("new-project")}
                        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-200 transition-colors"
                      >
                        New Project
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-5">
                  {activeView === "brief" && state && (
                    <BriefView state={state} />
                  )}
                  {activeView === "evals" && state && (
                    <EvalsView
                      state={state}
                      onNewTask={() => { op.setModal({ kind: "plan" }); op.setDrawerOpen(true); }}
                      runOperation={(url, body, options) => op.startOperation(url, body, options)}
                    />
                  )}
                  {activeView === "plan" && state && (
                    <PlanView
                      state={state}
                      onImplement={() => op.startOperation("/api/run/implement", {})}
                      onNewTask={() => { op.setModal({ kind: "plan" }); op.setDrawerOpen(true); }}
                      onRunTask={(taskId) => op.startOperation("/api/run/implement", { taskId })}
                      onTasksChanged={refresh}
                    />
                  )}
                  {activeView === "architecture" && state && (
                    <ArchitectureView
                      state={state}
                      runOperation={(url, body, options) => op.startOperation(url, body, options)}
                    />
                  )}
                  {activeView === "git" && state && <GitView state={state} onStateChange={refresh} />}
                  {activeView === "agents" && <AgentsView />}
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
              currentProjectPath={state?.projectRoot ?? null}
              onSetDrawerOpen={op.setDrawerOpen}
              onSetModal={op.setModal}
              onSetInputText={op.setInputText}
              onConfirm={op.handleConfirm}
              onPromptSubmit={op.handlePromptSubmit}
              onClear={op.clearOutput}
              onAbort={op.abort}
              onSubmitInit={handleSubmitInit}
              onSubmitPlan={handleSubmitPlan}
            />
          </section>

          <GitDiffSidebar
            open={diffSidebarOpen}
            projectPath={state?.projectRoot ?? null}
            operationStatus={op.status}
            onClose={() => setDiffSidebarOpen(false)}
          />
        </div>
      </main>
    </div>
  );
}
