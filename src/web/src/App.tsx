import { lazy, Suspense, useEffect, useState } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useProjectState } from "./hooks/useApi";
import { useOperation } from "./hooks/useOperation";
import { Sidebar, type View } from "./components/Sidebar";
import { OperationDrawer, type InitModalSubmission } from "./components/OperationDrawer";
import { LoadingDots } from "./components/LoadingDots";
import { GitDiffSidebar } from "./components/GitDiffSidebar";
import type { ChatTrigger } from "./components/ChatPanel";
import { applyBenderTheme, type BenderThemePayload } from "./theme";
import { HomeView } from "./pages/HomeView";

interface GitDiffSummaryResponse {
  additions?: number;
  deletions?: number;
}

interface ActiveThemeResponse {
  themeId?: string;
  source?: string;
  theme?: BenderThemePayload;
}

// Lazy-load all page views so their heavy vendor deps (mermaid, katex, cytoscape)
// are only fetched when the user first navigates to that view.
const PlanView = lazy(() => import("./pages/PlanView").then((m) => ({ default: m.PlanView })));
const ArchitectureView = lazy(() => import("./pages/ArchitectureView").then((m) => ({ default: m.ArchitectureView })));
const BriefView = lazy(() => import("./pages/BriefView").then((m) => ({ default: m.BriefView })));
const SettingsView = lazy(() => import("./pages/SettingsView").then((m) => ({ default: m.SettingsView })));
const AgentsView = lazy(() => import("./pages/AgentsView").then((m) => ({ default: m.AgentsView })));
const EvalsView = lazy(() => import("./pages/EvalsView").then((m) => ({ default: m.EvalsView })));
const WorkflowsView = lazy(() => import("./pages/WorkflowsView").then((m) => ({ default: m.WorkflowsView })));

const VIEW_LABELS: Record<View, string> = {
  plan: "Tasks",
  workflows: "Workflows",
  architecture: "Architecture",
  brief: "Overview",
  evals: "Evals",
  agents: "Agents",
  settings: "Settings",
};

export function App() {
  const [activeView, setActiveView] = useState<View>("brief");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("bender.ui.leftSidebarCollapsed");
      // Default to collapsed if the user has never set a preference
      return stored === null ? true : stored === "1";
    } catch {
      return true;
    }
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [diffSummary, setDiffSummary] = useState<{ additions: number; deletions: number } | null>(null);
  const [chatTrigger, setChatTrigger] = useState<ChatTrigger | null>(null);
  const { state, loading, error, refresh } = useProjectState();
  const op = useOperation(refresh);
  const operationLabel = op.lines.find((line) => line.kind === "header")?.text ?? null;
  const projectTitle = state?.projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? "No Project";

  useEffect(() => {
    let cancelled = false;
    async function loadTheme(): Promise<void> {
      try {
        const res = await fetch("/api/themes/active");
        const body = await res.json();
        if (!res.ok || cancelled) return;
        const payload = body as ActiveThemeResponse;
        if (payload.theme) {
          applyBenderTheme(payload.theme);
        }
      } catch {
        // Keep existing CSS defaults on failure.
      }
    }

    void loadTheme();
    const handleRefresh = () => {
      void loadTheme();
    };
    window.addEventListener("bender:theme-refresh", handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("bender:theme-refresh", handleRefresh);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("bender.ui.leftSidebarCollapsed", leftSidebarCollapsed ? "1" : "0");
    } catch {
      // Ignore storage errors.
    }
  }, [leftSidebarCollapsed]);

  // Fetch git diff summary (additions/deletions for the last commit) to show in top bar
  useEffect(() => {
    if (!state?.projectRoot) { setDiffSummary(null); return; }
    let cancelled = false;
    fetch("/api/git/diff-summary?commits=1")
      .then(async (res) => {
        const data = await res.json().catch(() => ({})) as GitDiffSummaryResponse;
        if (!res.ok || cancelled) return;
        setDiffSummary({
          additions: Number.isFinite(data.additions) ? Number(data.additions) : 0,
          deletions: Number.isFinite(data.deletions) ? Number(data.deletions) : 0,
        });
      })
      .catch(() => { if (!cancelled) setDiffSummary(null); });
    return () => { cancelled = true; };
  }, [state?.projectRoot, op.status]);

  // Refresh project state immediately after any chat stream finishes (e.g. after
  // a global-mode tool opens/clones a project).
  useEffect(() => {
    const handleChatFinished = () => void refresh();
    window.addEventListener("bender:chat-stream-finished", handleChatFinished);
    return () => window.removeEventListener("bender:chat-stream-finished", handleChatFinished);
  }, [refresh]);

  // HomeView tile actions
  useEffect(() => {
    const handleNewProject = () => {
      op.setModal({ kind: "init" });
      op.setDrawerOpen(true);
    };
    window.addEventListener("bender:new-project", handleNewProject);
    return () => window.removeEventListener("bender:new-project", handleNewProject);
  }, [op]);

  useEffect(() => {
    const handleFocusChat = (e: Event) => {
      const text = (e as CustomEvent<string>).detail ?? "";
      op.setDrawerOpen(true);
      // Small delay to let the drawer open before firing the trigger
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("bender:prefill-chat", { detail: text }));
      }, 50);
    };
    window.addEventListener("bender:focus-chat", handleFocusChat);
    return () => window.removeEventListener("bender:focus-chat", handleFocusChat);
  }, [op]);

  if (loading && !state) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-6">
        <p className="font-bender-brand text-[18px] leading-none tracking-[0.08em] select-none">
          <span className="text-[var(--bender-text-primary)]">Bender</span>
          <span className="text-[var(--bender-text-muted)]">.desktop</span>
        </p>
        <LoadingDots className="justify-center" size={6} label="Connecting…" textClassName="text-xs text-[var(--bender-text-muted)]" />
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-6">
        <p className="font-bender-brand text-[18px] leading-none tracking-[0.08em] select-none">
          <span className="text-[var(--bender-text-primary)]">Bender</span>
          <span className="text-[var(--bender-text-muted)]">.desktop</span>
        </p>
        <div className="text-center max-w-sm space-y-2">
          <p className="text-sm text-[var(--bender-text-secondary)]">Could not connect to bender</p>
          <p className="text-xs text-[var(--bender-text-muted)]">
            Make sure <code className="bg-[var(--bender-code-inline-bg)] px-1.5 py-0.5 rounded text-[var(--bender-code-inline-fg)]">bender bend</code> is running.
          </p>
          <p className="text-xs text-[var(--bender-danger)] opacity-60 mt-3 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  const hasProject = !!state?.projectRoot;
  const isInitialized = state?.initialized ?? false;
  const allowsNoProject = activeView === "settings" || activeView === "agents";
  // Workflows self-initialise their SQLite store on first access; no full bender init needed.
  const allowsUninitialized = activeView === "workflows";
  const needsProject = !hasProject && !allowsNoProject;
  const needsInit = hasProject && !isInitialized && !allowsNoProject && !allowsUninitialized;
  function fireChatTrigger(kind: ChatTrigger["kind"]) {
    setChatTrigger((prev) => ({ token: (prev?.token ?? 0) + 1, kind }));
    op.setDrawerOpen(true);
  }

  function handleGlobalAction(action: "new-project") {
    if (action === "new-project") {
      op.setModal({ kind: "init" });
      op.setDrawerOpen(true);
    }
  }

  function handleAnalyze() {
    fireChatTrigger("analyze");
    op.startOperation("/api/run/analyze", {}, { onSuccess: () => setActiveView("architecture") });
  }

  function handleSubmitInit(submission: InitModalSubmission) {
    op.startOperation("/api/run/init", submission as unknown as Record<string, unknown>);
  }

  return (
    <div className="h-screen flex overflow-hidden bg-[var(--bender-app-bg)]">
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        state={state}
        onProjectChange={refresh}
        onGlobalAction={handleGlobalAction}
        collapsed={leftSidebarCollapsed}
        onToggleCollapsed={() => setLeftSidebarCollapsed((v) => !v)}
        operationStatus={op.status}
        operationLabel={operationLabel}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar — hidden when no project is open */}
        <header className={`sticky top-0 z-10 bg-[var(--bender-app-bg)] px-4 h-10 shrink-0 ${needsProject ? "hidden" : ""}`}>
          <div className="relative flex items-center gap-3 h-full">
            <h2 className="text-xs font-semibold text-zinc-300 tracking-wide shrink-0">{needsProject ? "Home" : VIEW_LABELS[activeView]}</h2>
            {hasProject && (
              <div className="absolute left-1/2 -translate-x-1/2 max-w-[40vw] truncate text-xs text-zinc-500 text-center pointer-events-none">
                {projectTitle}
              </div>
            )}
            <div className="flex-1" />
            {state?.git?.recentCommits[0] && (() => {
              const commit = state.git.recentCommits[0];
              const shortHash = commit.hash.slice(0, 7);
              const msg = commit.message.length > 52
                ? commit.message.slice(0, 49).replace(/\s+\S*$/, "") + "…"
                : commit.message;
              return (
                <span
                  title={`${commit.hash} ${commit.message}`}
                  className="text-[11px] text-zinc-600 font-mono hidden lg:flex items-center gap-1.5 cursor-default select-none"
                >
                  <span className="text-zinc-700">{shortHash}</span>
                  <span className="text-zinc-700">·</span>
                  <span>{msg}</span>
                </span>
              );
            })()}
            {hasProject && (
              <button
                onClick={() => setReviewOpen((v) => !v)}
                title={reviewOpen ? "Close review panel" : "Open review panel"}
                className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded transition-colors ${
                  reviewOpen
                    ? "text-zinc-300 bg-zinc-800"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                {reviewOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
                {diffSummary ? (
                  <span className="font-mono flex items-center gap-1">
                    <span className="text-emerald-400">+{diffSummary.additions.toLocaleString()}</span>
                    <span className="text-red-400">-{diffSummary.deletions.toLocaleString()}</span>
                  </span>
                ) : (
                  <span className="hidden xl:inline">Review</span>
                )}
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          <section className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
            {/* Scrollable content */}
            <div className="text-[13px] flex-1 overflow-y-auto">
              {needsProject ? (
                <HomeView onProjectOpened={refresh} />
              ) : needsInit ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center max-w-sm space-y-4">
                    <div className="mx-auto w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
                      <svg className="w-5 h-5 text-zinc-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
                      </svg>
                    </div>
                    <p className="text-[13px] font-medium text-zinc-300">Ready to analyze</p>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Bender will scan your codebase and generate a project brief, architecture overview, and initial task plan.
                    </p>
                    <div className="flex items-center justify-center gap-2 pt-1">
                      <button
                        onClick={handleAnalyze}
                        className="px-4 py-2 bg-zinc-100 hover:bg-white border border-zinc-200 rounded-lg text-xs font-medium text-zinc-900 transition-colors"
                      >
                        Analyze Project
                      </button>
                      <button
                        onClick={() => handleGlobalAction("new-project")}
                        className="px-4 py-2 bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 transition-colors"
                      >
                        New Project
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <Suspense fallback={
                  <div className="flex items-center justify-center h-full min-h-[200px]">
                    <LoadingDots size={20} label="Loading…" textClassName="text-xs text-zinc-600" />
                  </div>
                }>
                  <div className="p-5">
                    {activeView === "brief" && state && (
                      <BriefView state={state} onAnalyze={handleAnalyze} />
                    )}
                    {activeView === "evals" && state && (
                      <EvalsView
                        state={state}
                        onNewTask={() => fireChatTrigger("new-task")}
                        runOperation={(url, body, options) => op.startOperation(url, body, options)}
                      />
                    )}
                    {activeView === "plan" && state && (
                      <PlanView
                        state={state}
                        onImplement={() => op.startOperation("/api/run/implement", {})}
                        onNewTask={() => fireChatTrigger("new-task")}
                        onRunTask={(taskId) => op.startOperation("/api/run/implement", { taskId })}
                        onTasksChanged={refresh}
                      />
                    )}
                    {activeView === "workflows" && (
                      <WorkflowsView />
                    )}
                    {activeView === "architecture" && state && (
                      <ArchitectureView
                        state={state}
                        runOperation={(url, body, options) => op.startOperation(url, body, options)}
                      />
                    )}
                    {activeView === "agents" && <AgentsView />}
                    {activeView === "settings" && <SettingsView />}
                  </div>
                </Suspense>
              )}
            </div>

            {/* Operation drawer — sits at the bottom of the main column */}
            <OperationDrawer
              status={op.status}
              drawerOpen={op.drawerOpen}
              modal={op.modal}
              currentProjectPath={state?.projectRoot ?? null}
              onSetDrawerOpen={op.setDrawerOpen}
              onSetModal={op.setModal}
              onClear={op.clearOutput}
              onAbort={op.abort}
              onSubmitInit={handleSubmitInit}
              onRunOperation={(url, body) => op.startOperation(url, body ?? {})}
              chatTrigger={chatTrigger}
              operation={{
                lines: op.lines,
                status: op.status,
                runId: op.runId,
                currentUrl: op.currentUrl,
                handleConfirm: op.handleConfirm,
                handlePromptSubmit: op.handlePromptSubmit,
              }}
            />
          </section>

          {hasProject && (
            <GitDiffSidebar
              open={reviewOpen}
              projectPath={state?.projectRoot ?? null}
              operationStatus={op.status}
              onClose={() => setReviewOpen(false)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
