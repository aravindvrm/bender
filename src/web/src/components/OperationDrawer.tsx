import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { OperationStatus, OperationModal } from "../hooks/useOperation";
import { LoadingDots } from "./LoadingDots";
import { ChatPanel } from "./ChatPanel";
import { TerminalPanel } from "./drawer/TerminalPanel";
import { RunHistoryPanel } from "./RunHistoryPanel";
import { NewProjectModal } from "./drawer/NewProjectModal";
import { PlanTaskModal } from "./drawer/PlanTaskModal";

export type { InitModalSubmission } from "./drawer/NewProjectModal";
export type { TaskCreateSubmission } from "./drawer/PlanTaskModal";

interface OperationDrawerProps {
  status: OperationStatus;
  drawerOpen: boolean;
  modal: OperationModal;
  inputText: string;
  currentProjectPath: string | null;
  onSetDrawerOpen: (open: boolean) => void;
  onSetModal: (modal: OperationModal) => void;
  onSetInputText: (text: string) => void;
  onClear: () => void;
  onAbort: () => void;
  onSubmitInit: (submission: import("./drawer/NewProjectModal").InitModalSubmission) => void;
  onCreateTask: (submission: import("./drawer/PlanTaskModal").TaskCreateSubmission) => Promise<void>;
  onRunOperation?: (url: string, body?: Record<string, unknown>) => void;
}

export function OperationDrawer({
  status,
  drawerOpen,
  modal,
  inputText,
  currentProjectPath,
  onSetDrawerOpen: _onSetDrawerOpen,
  onSetModal,
  onSetInputText,
  onClear,
  onAbort,
  onSubmitInit,
  onCreateTask,
  onRunOperation,
}: OperationDrawerProps) {
  const initialDrawerHeight = (() => {
    if (typeof window === "undefined") return 320;
    return Math.floor(window.innerHeight / 3);
  })();
  const [activeTab, setActiveTab] = useState<"console" | "terminal" | "chat">("chat");
  const [chatClearToken, setChatClearToken] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(initialDrawerHeight);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(220);
  const isRunning = status === "running";

  function clampDrawerHeight(height: number): number {
    const minHeight = 160;
    const maxHeight = typeof window !== "undefined"
      ? Math.floor(window.innerHeight * 0.78)
      : 640;
    return Math.max(minHeight, Math.min(height, maxHeight));
  }

  function startResize(e: React.MouseEvent<HTMLDivElement>) {
    if (collapsed) return;
    e.preventDefault();
    resizeStartYRef.current = e.clientY;
    resizeStartHeightRef.current = drawerHeight;
    setIsResizing(true);
  }

  useEffect(() => {
    if (status === "running") {
      setCollapsed(false);
    }
  }, [status]);

  useEffect(() => {
    if (!isResizing) return;
    function onMouseMove(e: MouseEvent) {
      const delta = resizeStartYRef.current - e.clientY;
      setDrawerHeight(clampDrawerHeight(resizeStartHeightRef.current + delta));
    }
    function stopResize() { setIsResizing(false); }
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
  }, [isResizing]);

  const statusLabel =
    status === "running" ? "Running…" :
    status === "done" ? "Done" :
    status === "error" ? "Error" : "";

  const statusColor =
    status === "running" ? "text-zinc-400" :
    status === "done" ? "text-emerald-400" :
    status === "error" ? "text-red-400" : "text-zinc-500";

  if (!drawerOpen) return null;

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

      {modal?.kind === "plan" && (
        <PlanTaskModal
          initialDescription={inputText}
          onCancel={() => { onSetModal(null); onSetInputText(""); }}
          onSubmit={async (submission) => {
            await onCreateTask(submission);
            onSetInputText("");
            onSetModal(null);
          }}
        />
      )}

      <div
        className={`shrink-0 border-t border-zinc-800 bg-zinc-950 flex flex-col ${isResizing ? "" : "transition-[height] duration-150"} ${collapsed ? "h-10" : ""}`}
        style={!collapsed ? { height: `${drawerHeight}px` } : undefined}
      >
        {!collapsed && (
          <div
            onMouseDown={startResize}
            className={`h-1.5 shrink-0 cursor-ns-resize transition-colors ${isResizing ? "bg-zinc-700/80" : "bg-zinc-900 hover:bg-zinc-800"}`}
            title="Drag to resize console"
          />
        )}
        <div className="flex items-center gap-2 px-4 h-10 shrink-0 border-b border-zinc-800/60">
          {isRunning && <LoadingDots size={12} />}
          {statusLabel && (
            <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
          )}

          <div className="ml-2 self-stretch flex items-stretch border border-zinc-800/60 rounded-md overflow-hidden">
            <button
              onClick={() => setActiveTab("chat")}
              className={`px-3 h-full text-[11px] transition-colors flex items-center gap-1 ${
                activeTab === "chat"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              <MessageSquare className="h-3 w-3" />
              Chat
            </button>
            <button
              onClick={() => setActiveTab("console")}
              className={`px-3 h-full text-[11px] transition-colors border-l border-zinc-800/60 ${
                activeTab === "console"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              Console
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-3 h-full text-[11px] transition-colors flex items-center gap-1 border-l border-zinc-800/60 ${
                activeTab === "terminal"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              <TerminalIcon className="h-3 w-3" />
              Terminal
            </button>
          </div>

          <div className="flex-1" />

          {isRunning && (
            <button
              onClick={onAbort}
              className="text-xs text-red-400/70 hover:text-red-400 transition-colors px-2 py-0.5 rounded border border-red-900/50 hover:border-red-700"
            >
              Stop
            </button>
          )}
          {activeTab === "chat" && (
            <button
              onClick={() => setChatClearToken((prev) => prev + 1)}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-0.5 rounded border border-zinc-800 hover:border-zinc-600"
            >
              Clear
            </button>
          )}
          {(status === "done" || status === "error") && (
            <button
              onClick={() => { onClear(); setCollapsed(true); }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-0.5 rounded border border-zinc-800 hover:border-zinc-600"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="text-zinc-600 hover:text-zinc-400 transition-colors ml-1"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {!collapsed && activeTab === "terminal" && (
          <div className="flex-1 min-h-0">
            <TerminalPanel projectPath={currentProjectPath} />
          </div>
        )}

        {!collapsed && activeTab === "chat" && (
          <div className="flex-1 min-h-0">
            <ChatPanel
              projectPath={currentProjectPath}
              clearToken={chatClearToken}
              onRunOperation={onRunOperation}
            />
          </div>
        )}

        {!collapsed && activeTab === "console" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <RunHistoryPanel
              projectPath={currentProjectPath}
              operationStatus={status}
            />
          </div>
        )}
      </div>
    </>
  );
}
