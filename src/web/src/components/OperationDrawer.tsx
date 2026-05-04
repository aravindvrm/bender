import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  MessageSquarePlus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { OperationStatus, OperationModal, OutputLine } from "../hooks/useOperation";
import { ChatPanel, type ChatTrigger } from "./ChatPanel";
import { TerminalPanel } from "./drawer/TerminalPanel";
import { NewProjectModal } from "./drawer/NewProjectModal";

export type { InitModalSubmission } from "./drawer/NewProjectModal";

type RightPanel = "none" | "terminal";

interface OperationDrawerProps {
  status: OperationStatus;
  drawerOpen: boolean;
  modal: OperationModal;
  currentProjectPath: string | null;
  onSetDrawerOpen: (open: boolean) => void;
  onSetModal: (modal: OperationModal) => void;
  onClear: () => void;
  onAbort: () => void;
  onSubmitInit: (submission: import("./drawer/NewProjectModal").InitModalSubmission) => void;
  onRunOperation?: (url: string, body?: Record<string, unknown>) => void;
  /** Trigger fired by sidebar / onNewTask buttons — auto-switches to chat tab. */
  chatTrigger?: ChatTrigger | null;
  /** Live operation feed — passed through to ChatPanel for inline rendering. */
  operation?: {
    lines: OutputLine[];
    status: OperationStatus;
    runId: number;
    currentUrl?: string;
    handleConfirm: (id: string, idx: number, answer: boolean) => void;
    handlePromptSubmit: (id: string, idx: number, text: string) => void;
  } | null;
}

const MIN_DRAWER_HEIGHT = 160;
const MIN_RIGHT_PANEL_WIDTH = 240;
const DEFAULT_RIGHT_PANEL_WIDTH = 380;
const COLLAPSED_HEIGHT = 44;

export function OperationDrawer({
  status,
  drawerOpen,
  modal,
  currentProjectPath,
  onSetDrawerOpen: _onSetDrawerOpen,
  onSetModal,
  onClear,
  onAbort,
  onSubmitInit,
  onRunOperation,
  chatTrigger,
  operation,
}: OperationDrawerProps) {
  const initialDrawerHeight = (() => {
    if (typeof window === "undefined") return 320;
    return Math.floor(window.innerHeight / 3);
  })();

  const [collapsed, setCollapsed] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(initialDrawerHeight);
  const [isResizingH, setIsResizingH] = useState(false);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(220);

  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [isResizingV, setIsResizingV] = useState(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(DEFAULT_RIGHT_PANEL_WIDTH);

  const isRunning = status === "running";

  // -------------------------------------------------------------------------
  // Horizontal resize (drawer height)
  // -------------------------------------------------------------------------

  function clampDrawerHeight(height: number): number {
    const maxHeight = typeof window !== "undefined"
      ? Math.floor(window.innerHeight * 0.75)
      : 640;
    return Math.max(MIN_DRAWER_HEIGHT, Math.min(height, maxHeight));
  }

  function startResizeH(e: React.MouseEvent<HTMLDivElement>) {
    if (collapsed) return;
    e.preventDefault();
    resizeStartYRef.current = e.clientY;
    resizeStartHeightRef.current = drawerHeight;
    setIsResizingH(true);
  }

  useEffect(() => {
    if (!isResizingH) return;
    function onMouseMove(e: MouseEvent) {
      const delta = resizeStartYRef.current - e.clientY;
      setDrawerHeight(clampDrawerHeight(resizeStartHeightRef.current + delta));
    }
    function stopResize() { setIsResizingH(false); }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopResize);
    window.addEventListener("mouseleave", stopResize);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopResize);
      window.removeEventListener("mouseleave", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingH]);

  // -------------------------------------------------------------------------
  // Vertical resize (right panel width)
  // -------------------------------------------------------------------------

  function clampRightWidth(width: number): number {
    const maxWidth = typeof window !== "undefined"
      ? Math.floor(window.innerWidth * 0.55)
      : 800;
    return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(width, maxWidth));
  }

  function startResizeV(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = rightPanelWidth;
    setIsResizingV(true);
  }

  useEffect(() => {
    if (!isResizingV) return;
    function onMouseMove(e: MouseEvent) {
      const delta = resizeStartXRef.current - e.clientX;
      setRightPanelWidth(clampRightWidth(resizeStartWidthRef.current + delta));
    }
    function stopResize() { setIsResizingV(false); }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopResize);
    window.addEventListener("mouseleave", stopResize);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopResize);
      window.removeEventListener("mouseleave", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingV]);

  // -------------------------------------------------------------------------
  // Auto-expand on running / trigger
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (status === "running") setCollapsed(false);
  }, [status]);

  const prevTriggerTokenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!chatTrigger) return;
    if (chatTrigger.token === prevTriggerTokenRef.current) return;
    prevTriggerTokenRef.current = chatTrigger.token;
    setCollapsed(false);
  }, [chatTrigger]);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function toggleRight(panel: "terminal") {
    setRightPanel((prev) => (prev === panel ? "none" : panel));
  }

  const statusLabel =
    status === "done" ? "Done" :
    status === "error" ? "Error" : "";

  const statusColor =
    status === "running" ? "text-zinc-400" :
    status === "done" ? "text-emerald-400" :
    status === "error" ? "text-red-400" : "";

  if (!drawerOpen) return null;

  const showRight = rightPanel !== "none";

  return (
    <>
      {modal?.kind === "init" && (
        <NewProjectModal
          currentProjectPath={currentProjectPath}
          onCancel={() => onSetModal(null)}
          onSubmit={(submission) => {
            onSetModal(null);
            onSubmitInit(submission);
          }}
        />
      )}

      {/* Floating card wrapper */}
      <div className="shrink-0 px-4 pb-4 pt-0">
        <div
          className={`
            relative flex flex-col overflow-hidden
            rounded-2xl
            ring-1 ring-white/[0.06]
            ${isResizingH || isResizingV ? "" : "transition-[height] duration-150"}
          `}
          style={{
            background: "var(--bender-surface-float)",
            boxShadow: "var(--bender-shadow-float)",
            height: !collapsed ? `${drawerHeight}px` : `${COLLAPSED_HEIGHT}px`,
          }}
        >
          {/* Collapsed bar */}
          {collapsed && (
            <div className="h-full flex items-center gap-1 px-3">
              {statusLabel && (
                <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
              )}
              <div className="flex-1" />
              {isRunning && (
                <button onClick={onAbort} className="p-1 px-1.5 rounded-md text-[10px] font-medium text-red-400/70 hover:text-red-400 hover:bg-zinc-800/60 transition-colors">
                  Stop
                </button>
              )}
              <button
                onClick={() => setCollapsed(false)}
                title="Expand"
                className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Resize handle — pill at top of card */}
          {!collapsed && (
            <div
              onMouseDown={startResizeH}
              className="h-3 shrink-0 cursor-ns-resize flex items-center justify-center group"
            >
              <div className={`w-8 h-0.5 rounded-full transition-all duration-200 ${
                isResizingH ? "bg-zinc-500" : "bg-transparent group-hover:bg-zinc-600/80"
              }`} />
            </div>
          )}

          {/* Body — chat + optional right panel. ChatPanel owns the single header bar. */}
          {!collapsed && (
            <div className="flex-1 min-h-0 flex overflow-hidden">
              {/* Chat */}
              <div className="flex-1 min-w-0 overflow-hidden">
                <ChatPanel
                  projectPath={currentProjectPath}
                  onRunOperation={onRunOperation}
                  trigger={chatTrigger}
                  operation={operation
                    ? {
                        lines: operation.lines,
                        status: operation.status,
                        runId: operation.runId,
                        url: operation.currentUrl,
                        handleConfirm: operation.handleConfirm,
                        handlePromptSubmit: operation.handlePromptSubmit,
                      }
                    : null}
                  headerActions={
                    <div className="flex items-center gap-0.5">
                      {/* Status */}
                      {statusLabel && (
                        <span className={`text-[10px] font-medium mr-1 ${statusColor}`}>
                          {statusLabel}
                        </span>
                      )}
                      {/* New thread */}
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent("bender:new-thread"))}
                        title="New conversation (⌘K)"
                        className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
                      >
                        <MessageSquarePlus className="h-3.5 w-3.5" />
                      </button>
                      {/* Terminal */}
                      <button
                        onClick={() => toggleRight("terminal")}
                        title="Terminal"
                        className={`p-1 rounded-md transition-colors ${
                          rightPanel === "terminal"
                            ? "text-zinc-200 bg-zinc-700/60"
                            : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60"
                        }`}
                      >
                        <TerminalIcon className="h-3.5 w-3.5" />
                      </button>
                      {/* Stop */}
                      {isRunning && (
                        <button
                          onClick={onAbort}
                          title="Stop"
                          className="p-1 px-1.5 rounded-md text-[10px] font-medium text-red-400/70 hover:text-red-400 hover:bg-zinc-800/60 transition-colors"
                        >
                          Stop
                        </button>
                      )}
                      {/* Dismiss */}
                      {(status === "done" || status === "error") && (
                        <button
                          onClick={() => { onClear(); setCollapsed(true); }}
                          title="Dismiss"
                          className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* Collapse */}
                      <button
                        onClick={() => setCollapsed((v) => !v)}
                        title="Collapse"
                        className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  }
                />
              </div>

              {/* Vertical resize handle */}
              {showRight && (
                <div
                  onMouseDown={startResizeV}
                  className="w-2 shrink-0 cursor-ew-resize flex items-center justify-center group"
                >
                  <div className={`h-8 w-0.5 rounded-full transition-all duration-200 ${
                    isResizingV ? "bg-zinc-500" : "bg-transparent group-hover:bg-zinc-600/70"
                  }`} />
                </div>
              )}

              {/* Right panel */}
              {showRight && (
                <div
                  className="shrink-0 border-l border-white/[0.05] flex flex-col overflow-hidden"
                  style={{ width: `${rightPanelWidth}px` }}
                >
                  {rightPanel === "terminal" && (
                    <TerminalPanel projectPath={currentProjectPath} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
