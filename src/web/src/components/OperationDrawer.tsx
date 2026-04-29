import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  History,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { OperationStatus, OperationModal } from "../hooks/useOperation";
import { LoadingDots } from "./LoadingDots";
import { ChatPanel, type ChatTrigger } from "./ChatPanel";
import { TerminalPanel } from "./drawer/TerminalPanel";
import { RunHistoryPanel } from "./RunHistoryPanel";
import { NewProjectModal } from "./drawer/NewProjectModal";

export type { InitModalSubmission } from "./drawer/NewProjectModal";

type RightPanel = "none" | "console" | "terminal";

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
}

const MIN_DRAWER_HEIGHT = 160;
const MIN_RIGHT_PANEL_WIDTH = 220;
const DEFAULT_RIGHT_PANEL_WIDTH = 360;

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

  // Right panel (console / terminal) — slides in from the right.
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
      ? Math.floor(window.innerHeight * 0.78)
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
      ? Math.floor(window.innerWidth * 0.6)
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
  // Expand on running
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (status === "running") setCollapsed(false);
  }, [status]);

  // -------------------------------------------------------------------------
  // Trigger: auto-uncollapse and focus chat
  // -------------------------------------------------------------------------

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

  function toggleRight(panel: "console" | "terminal") {
    setRightPanel((prev) => (prev === panel ? "none" : panel));
  }

  const statusLabel =
    status === "running" ? "Running…" :
    status === "done" ? "Done" :
    status === "error" ? "Error" : "";

  const statusColor =
    status === "running" ? "text-zinc-400" :
    status === "done" ? "text-bender-success" :
    status === "error" ? "text-bender-danger" : "";

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

      <div
        className={`shrink-0 border-t border-zinc-800 bg-zinc-950 flex flex-col ${
          isResizingH || isResizingV ? "" : "transition-[height] duration-150"
        } ${collapsed ? "h-10" : ""}`}
        style={!collapsed ? { height: `${drawerHeight}px` } : undefined}
      >
        {/* Horizontal resize handle */}
        {!collapsed && (
          <div
            onMouseDown={startResizeH}
            className="h-2 shrink-0 cursor-ns-resize flex items-center justify-center group"
          >
            <div className={`w-8 h-0.5 rounded-full transition-all duration-200 ${
              isResizingH ? "bg-zinc-500" : "bg-transparent group-hover:bg-zinc-600/70"
            }`} />
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-zinc-800/60">
          {/* Status */}
          <div className="flex items-center gap-1.5 min-w-0">
            {isRunning && <LoadingDots size={11} />}
            {statusLabel && (
              <span className={`text-[11px] font-medium shrink-0 ${statusColor}`}>
                {statusLabel}
              </span>
            )}
          </div>

          <div className="flex-1" />

          {/* Right-panel toggles */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => toggleRight("console")}
              title="Toggle run console (⌘J)"
              className={`flex items-center gap-1 px-2 h-6 rounded text-[11px] transition-colors ${
                rightPanel === "console"
                  ? "bg-zinc-800 text-zinc-200 border border-zinc-700"
                  : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900"
              }`}
            >
              <History className="h-3 w-3" />
              <span className="hidden sm:inline">Console</span>
            </button>
            <button
              onClick={() => toggleRight("terminal")}
              title="Toggle terminal (⌘`)"
              className={`flex items-center gap-1 px-2 h-6 rounded text-[11px] transition-colors ${
                rightPanel === "terminal"
                  ? "bg-zinc-800 text-zinc-200 border border-zinc-700"
                  : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900"
              }`}
            >
              <TerminalIcon className="h-3 w-3" />
              <span className="hidden sm:inline">Terminal</span>
            </button>
          </div>

          {/* Stop / clear */}
          {isRunning && (
            <button
              onClick={onAbort}
              className="text-[11px] text-bender-danger/70 hover:text-bender-danger transition-colors px-2 py-0.5 rounded border border-bender-danger/20 hover:border-bender-danger/40"
            >
              Stop
            </button>
          )}
          {(status === "done" || status === "error") && (
            <button
              onClick={() => { onClear(); setCollapsed(true); }}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors px-2 py-0.5 rounded"
            >
              Dismiss
            </button>
          )}

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="text-zinc-600 hover:text-zinc-400 transition-colors ml-0.5"
            title={collapsed ? "Expand (⌘↑)" : "Collapse (⌘↓)"}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Body — chat + optional right panel */}
        {!collapsed && (
          <div className="flex-1 min-h-0 flex">
            {/* Chat — always the primary panel */}
            <div className="flex-1 min-w-0">
              <ChatPanel
                projectPath={currentProjectPath}
                onRunOperation={onRunOperation}
                trigger={chatTrigger}
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

            {/* Right panel: console or terminal */}
            {showRight && (
              <div
                className="shrink-0 border-l border-zinc-800/60 flex flex-col overflow-hidden"
                style={{ width: `${rightPanelWidth}px` }}
              >
                {rightPanel === "console" && (
                  <RunHistoryPanel
                    projectPath={currentProjectPath}
                    operationStatus={status}
                  />
                )}
                {rightPanel === "terminal" && (
                  <TerminalPanel projectPath={currentProjectPath} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
