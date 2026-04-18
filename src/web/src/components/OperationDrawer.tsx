import { useState, useRef, useEffect, useCallback } from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Folder,
  FolderOpen,
  Terminal as TerminalIcon,
  MessageSquare,
} from "lucide-react";
import type { OutputLine, OperationStatus, OperationModal } from "../hooks/useOperation";
import { LoadingDots } from "./LoadingDots";
import { SecretInput } from "./SecretInput";
import { ChatPanel } from "./ChatPanel";
import { type BaseRole } from "../lib/roleLabels";

type StackTemplate = "nextjs-saas" | "express-api" | "auto";
type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama" | "openai-compatible";

interface DirEntry {
  name: string;
  path: string;
  hasBender: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  hasBender: boolean;
}

interface DirInspectResult {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  empty: boolean;
  hasBender: boolean;
  initialized: boolean;
  entryCount: number;
  fileCount: number;
  dirCount: number;
}

interface LlmStatus {
  hasAnyKey: boolean;
  activeProvider: LlmProvider;
  providers: Record<LlmProvider, { configured: boolean }>;
}

export interface InitModalSubmission {
  path: string;
  description: string;
  template: StackTemplate;
  llmProvider?: LlmProvider;
  llmApiKey?: string;
}

interface TerminalEntry {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TaskCreateSubmission {
  title?: string;
  description: string;
  agentId?: string;
}

interface OperationDrawerProps {
  lines: OutputLine[];
  status: OperationStatus;
  drawerOpen: boolean;
  modal: OperationModal;
  inputText: string;
  currentProjectPath: string | null;
  onSetDrawerOpen: (open: boolean) => void;
  onSetModal: (modal: OperationModal) => void;
  onSetInputText: (text: string) => void;
  onConfirm: (id: string, lineIdx: number, answer: boolean) => void;
  onPromptSubmit: (id: string, lineIdx: number, text: string) => void;
  onClear: () => void;
  onAbort: () => void;
  onSubmitInit: (submission: InitModalSubmission) => void;
  onCreateTask: (submission: TaskCreateSubmission) => Promise<void>;
}

// ── Terminal component ────────────────────────────────────────────────────────

function TerminalPanel({ projectPath }: { projectPath: string | null }) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  useEffect(() => {
    if (!running) {
      inputRef.current?.focus();
    }
  }, [running]);

  const runCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setRunning(true);
    setCommandHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed }),
      });
      const data = await res.json() as { stdout?: string; stderr?: string; exitCode?: number; error?: string };
      if (data.error) {
        setHistory((prev) => [...prev, { command: trimmed, stdout: "", stderr: data.error ?? "", exitCode: 1 }]);
      } else {
        setHistory((prev) => [...prev, {
          command: trimmed,
          stdout: data.stdout ?? "",
          stderr: data.stderr ?? "",
          exitCode: data.exitCode ?? 0,
        }]);
      }
    } catch (err) {
      setHistory((prev) => [...prev, { command: trimmed, stdout: "", stderr: (err as Error).message, exitCode: 1 }]);
    } finally {
      setRunning(false);
    }
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input;
      setInput("");
      void runCommand(cmd);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIndex + 1, commandHistory.length - 1);
      setHistoryIndex(next);
      if (commandHistory[next]) setInput(commandHistory[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(historyIndex - 1, -1);
      setHistoryIndex(next);
      setInput(next === -1 ? "" : (commandHistory[next] ?? ""));
    }
  }

  const cwd = projectPath ? projectPath.split("/").pop() ?? projectPath : "~";

  return (
    <div
      className="h-full overflow-y-auto bg-[#0b0b0d] text-[#d7d7da] font-mono text-[12px] leading-6 p-3"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="space-y-0">
        {history.length === 0 && (
          <p className="text-zinc-600 italic mb-2">Terminal ready. Commands run in project root.</p>
        )}
        {history.map((entry, i) => (
          <div key={i} className="mb-1">
            <div className="flex items-center gap-2 text-zinc-300">
              <span className="text-zinc-500">{cwd}</span>
              <span className="text-zinc-600">$</span>
              <span>{entry.command}</span>
            </div>
            {entry.stdout && (
              <pre className="text-zinc-300 whitespace-pre-wrap leading-relaxed">{entry.stdout}</pre>
            )}
            {entry.stderr && (
              <pre className={`whitespace-pre-wrap leading-relaxed ${entry.exitCode !== 0 ? "text-red-400/90" : "text-zinc-500"}`}>{entry.stderr}</pre>
            )}
          </div>
        ))}
        {!running && (
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">{cwd}</span>
            <span className="text-zinc-600">$</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!projectPath}
              placeholder={projectPath ? "" : "No project selected"}
              className="flex-1 bg-transparent outline-none text-zinc-200 placeholder:text-zinc-600"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        {running && (
          <div className="flex items-center gap-2 text-zinc-500">
            <span className="text-zinc-500">{cwd}</span>
            <span className="text-zinc-600">$</span>
            <span>running…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

async function browseDir(path?: string): Promise<BrowseResult> {
  const query = path && path.trim().length > 0 ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/fs/browse${query}`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to browse directory");
  return res.json();
}

async function inspectDir(path: string): Promise<DirInspectResult> {
  const res = await fetch(`/api/fs/inspect?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to inspect directory");
  return res.json();
}

async function fetchLlmStatus(path?: string): Promise<LlmStatus> {
  const query = path && path.trim().length > 0 ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/llm/status${query}`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to fetch LLM status");
  return res.json();
}

export function OperationDrawer({
  lines,
  status,
  drawerOpen,
  modal,
  inputText,
  currentProjectPath,
  onSetDrawerOpen,
  onSetModal,
  onSetInputText,
  onConfirm,
  onPromptSubmit,
  onClear,
  onAbort,
  onSubmitInit,
  onCreateTask,
}: OperationDrawerProps) {
  const [activeTab, setActiveTab] = useState<"console" | "terminal" | "chat">("console");
  const [chatClearToken, setChatClearToken] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(288);
  const [isResizing, setIsResizing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(288);
  const isRunning = status === "running";

  const visibleLines = lines;

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
    if (!collapsed) {
      if (activeTab === "console") {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [visibleLines, collapsed, activeTab]);

  useEffect(() => {
    if (status === "running") {
      setCollapsed(false);
      setActiveTab("console");
    }
  }, [status]);

  useEffect(() => {
    if (!isResizing) return;

    function onMouseMove(e: MouseEvent) {
      const delta = resizeStartYRef.current - e.clientY;
      setDrawerHeight(clampDrawerHeight(resizeStartHeightRef.current + delta));
    }

    function stopResize() {
      setIsResizing(false);
    }

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
          {isRunning && (
            <LoadingDots size={12} />
          )}
          {statusLabel && (
            <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
          )}

          <div className="ml-2 self-stretch flex items-stretch border-l border-r border-zinc-800/60">
            <button
              onClick={() => setActiveTab("console")}
              className={`px-3 h-full rounded-none text-[11px] transition-colors ${
                activeTab === "console"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              Console
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`px-3 h-full rounded-none text-[11px] transition-colors flex items-center gap-1 ${
                activeTab === "terminal"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              <TerminalIcon className="h-3 w-3" />
              Terminal
            </button>
            <button
              onClick={() => setActiveTab("chat")}
              className={`px-3 h-full rounded-none text-[11px] transition-colors flex items-center gap-1 ${
                activeTab === "chat"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              <MessageSquare className="h-3 w-3" />
              Chat
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
              onClick={() => {
                onClear();
                setCollapsed(true);
              }}
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
            />
          </div>
        )}

        {!collapsed && activeTab === "console" && (
          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-0.5">
            {visibleLines.length === 0 && (
              <p className="text-zinc-600 italic">Starting…</p>
            )}
            {visibleLines.map((line, i) => (
              <OutputLineView
                key={i}
                line={line}
                lineIdx={i}
                onConfirm={onConfirm}
                onPromptSubmit={onPromptSubmit}
                interactivePrompts={modal?.kind !== "plan"}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </>
  );
}

interface NewProjectModalProps {
  currentProjectPath: string | null;
  onCancel: () => void;
  onSubmit: (submission: InitModalSubmission) => void;
}

function NewProjectModal({ currentProjectPath, onCancel, onSubmit }: NewProjectModalProps) {
  const [pathInput, setPathInput] = useState(currentProjectPath ?? "");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<StackTemplate>("nextjs-saas");

  const [showBrowser, setShowBrowser] = useState(false);
  const [browserRoot, setBrowserRoot] = useState<BrowseResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);

  const [dirInspect, setDirInspect] = useState<DirInspectResult | null>(null);
  const [dirInspectError, setDirInspectError] = useState<string | null>(null);

  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [llmStatusError, setLlmStatusError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<LlmProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");

  async function loadBrowserRoot(path?: string) {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const data = await browseDir(path);
      setBrowserRoot(data);
      if (!pathInput.trim()) setPathInput(data.path);
      return data;
    } catch (err) {
      setBrowserError((err as Error).message);
      return null;
    } finally {
      setBrowserLoading(false);
    }
  }

  async function goToParent() {
    if (!browserRoot?.parent) return;
    await loadBrowserRoot(browserRoot.parent);
  }

  useEffect(() => {
    if (!showBrowser) return;
    if (browserRoot) return;
    void loadBrowserRoot(currentProjectPath ?? undefined);
  }, [showBrowser, browserRoot, currentProjectPath]);

  useEffect(() => {
    const input = pathInput.trim();
    if (!input) {
      setDirInspect(null);
      setDirInspectError(null);
      setLlmStatusError(null);
      void fetchLlmStatus(undefined).then((data) => {
        setLlmStatus(data);
        setSelectedProvider(data.activeProvider ?? "anthropic");
      }).catch((err: Error) => {
        setLlmStatus(null);
        setLlmStatusError(err.message);
      });
      return;
    }

    const timeout = setTimeout(() => {
      void inspectDir(input)
        .then((data) => {
          setDirInspect(data);
          setDirInspectError(null);
        })
        .catch((err: Error) => {
          setDirInspect(null);
          setDirInspectError(err.message);
        });

      void fetchLlmStatus(input)
        .then((data) => {
          setLlmStatus(data);
          setLlmStatusError(null);
          setSelectedProvider((prev) => prev || data.activeProvider || "anthropic");
        })
        .catch((err: Error) => {
          setLlmStatus(null);
          setLlmStatusError(err.message);
        });
    }, 220);

    return () => clearTimeout(timeout);
  }, [pathInput]);

  const showLlmSetup = llmStatus ? !llmStatus.hasAnyKey : true;
  const providerNeedsApiKey = selectedProvider !== "ollama" && selectedProvider !== "openai-compatible";

  const canSubmit =
    pathInput.trim().length > 0
    && description.trim().length > 0
    && (!showLlmSetup || !providerNeedsApiKey || apiKey.trim().length > 0)
    && (!dirInspect || dirInspect.isDirectory || !dirInspect.exists);

  function renderDirectoryStatus() {
    if (dirInspectError) {
      return <p className="text-xs text-red-400">{dirInspectError}</p>;
    }
    if (!pathInput.trim()) {
      return <p className="text-xs text-zinc-500">Choose a directory path for the new project.</p>;
    }
    if (!dirInspect) {
      return <p className="text-xs text-zinc-500">Checking directory status…</p>;
    }
    if (!dirInspect.exists) {
      return <p className="text-xs text-zinc-400">Directory does not exist yet. It will be created on init.</p>;
    }
    if (!dirInspect.isDirectory) {
      return <p className="text-xs text-red-400">This path points to a file. Choose a directory.</p>;
    }
    if (dirInspect.hasBender) {
      return <p className="text-xs text-amber-400">This directory already contains a <code>.bender</code> state.</p>;
    }
    if (dirInspect.empty) {
      return <p className="text-xs text-emerald-400">Empty directory. Great for a clean initialization.</p>;
    }
    return (
      <p className="text-xs text-zinc-400">
        Existing directory with {dirInspect.entryCount} item{dirInspect.entryCount === 1 ? "" : "s"}.
      </p>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/65 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">New Project</h3>
          <button onClick={onCancel} className="text-zinc-500 hover:text-zinc-200 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-6 overflow-y-auto">
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">1</span>
              <h4 className="text-sm font-medium text-zinc-200">Directory</h4>
            </div>

            <div className="flex gap-2">
              <input
                autoFocus
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="/path/to/project"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button
                onClick={() => setShowBrowser((v) => !v)}
                className="px-3 py-2 text-xs border border-zinc-700 text-zinc-300 rounded-md hover:bg-zinc-800 transition-colors"
              >
                {showBrowser ? "Hide" : "Browse"}
              </button>
            </div>

            {renderDirectoryStatus()}
            {dirInspect?.path && (
              <p className="text-[11px] text-zinc-600 font-mono truncate">{dirInspect.path}</p>
            )}

            {showBrowser && (
              <div className="border border-zinc-800 rounded-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 bg-zinc-925">
                  <button
                    onClick={() => void goToParent()}
                    disabled={!browserRoot?.parent || browserLoading}
                    className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                  >
                    Up
                  </button>
                  <button
                    onClick={() => void loadBrowserRoot(browserRoot?.path ?? (pathInput.trim() || undefined))}
                    disabled={browserLoading}
                    className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                  >
                    Refresh
                  </button>
                  <span className="text-[11px] text-zinc-500 font-mono truncate">
                    {browserRoot?.path ?? "Loading…"}
                  </span>
                </div>

                <div className="max-h-56 overflow-y-auto px-2 py-2">
                  {browserLoading && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500 px-2 py-2">
                      <LoadingDots size={18} label="Loading directories…" />
                    </div>
                  )}
                  {browserError && <p className="text-xs text-red-400 px-2 py-2">{browserError}</p>}

                  {!browserLoading && browserRoot && (
                    <>
                      <button
                        onClick={() => setPathInput(browserRoot.path)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs text-zinc-300 hover:bg-zinc-800/70"
                      >
                        <FolderOpen className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span className="truncate">. (this directory)</span>
                        {browserRoot.hasBender && <span className="ml-auto text-[10px] text-emerald-500">bender</span>}
                      </button>

                      {browserRoot.dirs.map((entry) => (
                        <DirectoryTreeNode
                          key={entry.path}
                          entry={entry}
                          depth={0}
                          selectedPath={pathInput}
                          onChoose={(path) => setPathInput(path)}
                        />
                      ))}
                    </>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">2</span>
              <h4 className="text-sm font-medium text-zinc-200">Description</h4>
            </div>

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What are you building?"
              rows={5}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">3</span>
              <h4 className="text-sm font-medium text-zinc-200">Stack (Optional)</h4>
            </div>

            <div className="grid sm:grid-cols-3 gap-2">
              {[
                { id: "nextjs-saas" as const, label: "Next.js SaaS", note: "Current default" },
                { id: "express-api" as const, label: "Express API", note: "Forward-looking" },
                { id: "auto" as const, label: "Let AI Decide", note: "Forward-looking" },
              ].map((option) => (
                <button
                  key={option.id}
                  onClick={() => setTemplate(option.id)}
                  className={`text-left border rounded-lg px-3 py-2 transition-colors ${
                    template === option.id
                      ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                      : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  <p className="text-sm font-medium">{option.label}</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">{option.note}</p>
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-600">Only <code>nextjs-saas</code> is fully scaffold-aware today. Other picks are saved as planning hints.</p>
          </section>

          {showLlmSetup && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">4</span>
                <h4 className="text-sm font-medium text-zinc-200">LLM Setup Required</h4>
              </div>

              <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                No API key found for this project/environment. Set one now to avoid init failing immediately.
              </div>

              <div className="flex flex-wrap gap-2">
                {(["anthropic", "openai", "google", "groq", "ollama", "openai-compatible"] as LlmProvider[]).map((provider) => (
                  <button
                    key={provider}
                    onClick={() => setSelectedProvider(provider)}
                    className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                      selectedProvider === provider
                        ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                        : "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {provider}
                    {llmStatus?.providers[provider]?.configured && <span className="ml-1 text-emerald-400">•</span>}
                  </button>
                ))}
              </div>

              {providerNeedsApiKey && (
                <SecretInput
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={`${selectedProvider.toUpperCase()} API key`}
                  inputClassName="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 pr-9 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
                />
              )}

              {llmStatusError && <p className="text-xs text-red-400">{llmStatusError}</p>}
            </section>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => {
              if (!canSubmit) return;
              onSubmit({
                path: pathInput.trim(),
                description: description.trim(),
                template,
                llmProvider: showLlmSetup ? selectedProvider : undefined,
                llmApiKey: showLlmSetup && providerNeedsApiKey ? apiKey.trim() : undefined,
              });
            }}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

interface DirectoryTreeNodeProps {
  entry: DirEntry;
  depth: number;
  selectedPath: string;
  onChoose: (path: string) => void;
}

function DirectoryTreeNode({ entry, depth, selectedPath, onChoose }: DirectoryTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  async function toggleExpand(e: React.MouseEvent) {
    e.stopPropagation();
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);
    if (children !== null) return;

    setLoading(true);
    setError(null);
    try {
      const data = await browseDir(entry.path);
      setChildren(data.dirs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const rowSelected = selectedPath.trim() === entry.path;

  return (
    <div>
      <button
        onClick={() => onChoose(entry.path)}
        className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-xs transition-colors ${
          rowSelected
            ? "bg-zinc-700/70 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800/70"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span
          onClick={toggleExpand}
          className="w-4 h-4 flex items-center justify-center text-zinc-500 hover:text-zinc-300"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        {expanded ? <FolderOpen className="h-3.5 w-3.5 text-zinc-400" /> : <Folder className="h-3.5 w-3.5 text-zinc-400" />}
        <span className="truncate">{entry.name}</span>
        {entry.hasBender && <span className="ml-auto text-[10px] text-emerald-500">bender</span>}
      </button>

      {expanded && (
        <div>
          {loading && (
            <div className="px-2 py-1" style={{ paddingLeft: `${28 + depth * 14}px` }}>
              <LoadingDots size={16} label="Loading…" />
            </div>
          )}
          {error && (
            <p className="text-[11px] text-red-400 px-2 py-1" style={{ paddingLeft: `${28 + depth * 14}px` }}>
              {error}
            </p>
          )}
          {children?.map((child) => (
            <DirectoryTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onChoose={onChoose}
            />
          ))}
          {children && children.length === 0 && !loading && !error && (
            <p className="text-[11px] text-zinc-600 px-2 py-1 italic" style={{ paddingLeft: `${28 + depth * 14}px` }}>
              empty
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface LineProps {
  line: OutputLine;
  lineIdx: number;
  onConfirm: (id: string, idx: number, answer: boolean) => void;
  onPromptSubmit: (id: string, idx: number, text: string) => void;
  interactivePrompts?: boolean;
}

function OutputLineView({ line, lineIdx, onConfirm, onPromptSubmit, interactivePrompts = true }: LineProps) {
  const [promptInput, setPromptInput] = useState("");

  switch (line.kind) {
    case "header":
      return <div className="text-zinc-100 font-bold pt-2 pb-0.5 border-b border-zinc-700 mb-1">=== {line.text} ===</div>;

    case "subheader":
      return <div className="text-zinc-300 font-semibold pt-2">--- {line.text} ---</div>;

    case "output": {
      const colors: Record<string, string> = {
        info: "text-zinc-400",
        success: "text-emerald-400",
        warn: "text-amber-400",
        error: "text-red-400",
      };
      return <div className={colors[line.level] ?? "text-zinc-400"}>{line.text}</div>;
    }

    case "stream":
      return <div className="text-zinc-300 whitespace-pre-wrap">{line.text}</div>;

    case "spinner":
      if (!line.done) return null;
      return (
        <div className="flex items-center gap-2 text-zinc-400">
          <span className={line.success ? "text-emerald-400" : "text-red-400"}>{line.success ? "✓" : "✗"}</span>
          <span>{line.text}</span>
        </div>
      );

    case "files":
      return (
        <div className="pt-1 pb-1 space-y-0.5">
          {line.ops.map((op, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={op.action === "create" ? "text-emerald-400 w-8" : "text-amber-400 w-8"}>{op.action.toUpperCase()}</span>
              <span className="text-zinc-300">{op.path}</span>
            </div>
          ))}
        </div>
      );

    case "confirm":
      return (
        <div className="my-2 p-3 bg-zinc-800/60 rounded-lg border border-zinc-700 space-y-2">
          <p className="text-zinc-200 font-sans">{line.question}</p>
          {line.answered ? (
            <p className={`text-xs font-sans ${line.answer ? "text-emerald-400" : "text-red-400"}`}>
              → {line.answer ? "Approved" : "Declined"}
            </p>
          ) : !interactivePrompts ? (
            <p className="text-xs text-zinc-500 font-sans">Answer this prompt in the active modal.</p>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => onConfirm(line.id, lineIdx, true)}
                className="px-3 py-1 text-xs rounded bg-emerald-900/50 border border-emerald-700 text-emerald-300 hover:bg-emerald-900 transition-colors font-sans"
              >
                Approve
              </button>
              <button
                onClick={() => onConfirm(line.id, lineIdx, false)}
                className="px-3 py-1 text-xs rounded bg-zinc-900 border border-zinc-600 text-zinc-400 hover:bg-zinc-800 transition-colors font-sans"
              >
                Decline
              </button>
            </div>
          )}
        </div>
      );

    case "prompt":
      return (
        <div className="my-2 p-3 bg-zinc-800/60 rounded-lg border border-zinc-700 space-y-2">
          <p className="text-zinc-200 font-sans">{line.question}</p>
          {line.answered ? (
            <p className="text-xs text-zinc-400 italic font-sans">→ {line.answer?.slice(0, 80)}{(line.answer?.length ?? 0) > 80 ? "…" : ""}</p>
          ) : !interactivePrompts ? (
            <p className="text-xs text-zinc-500 font-sans">Answer this prompt in the active modal.</p>
          ) : (
            <div className="space-y-2">
              <textarea
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder="Type your answer…"
                rows={3}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-200 font-sans focus:outline-none focus:border-zinc-400 resize-none"
              />
              <button
                onClick={() => onPromptSubmit(line.id, lineIdx, promptInput)}
                className="px-3 py-1 text-xs rounded bg-zinc-700 border border-zinc-600 text-zinc-200 hover:bg-zinc-600 transition-colors font-sans"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      );

    case "done":
      return (
        <div className={`pt-2 font-semibold font-sans ${line.success ? "text-emerald-400" : "text-red-400"}`}>
          {line.success ? "✓ Operation completed successfully." : "✗ Operation finished with errors."}
        </div>
      );

    case "error":
      return <div className="text-red-400 pt-1 font-sans">Error: {line.message}</div>;

    default:
      return null;
  }
}

interface PlanTaskModalProps {
  initialDescription: string;
  onSubmit: (submission: TaskCreateSubmission) => Promise<void>;
  onCancel: () => void;
}

interface AgentOption {
  id: string;
  name: string;
  baseRole: BaseRole;
  modelTier: "fast" | "default" | "strong";
  isBuiltin?: boolean;
}

function formatAgentOptionLabel(agent: AgentOption, roleOption: BaseRole): string {
  const builtinSuffix = agent.isBuiltin ? " [builtin]" : "";
  const isRoleDefaultBuiltin = agent.id === `default-${roleOption}`;
  if (isRoleDefaultBuiltin || agent.modelTier === "default") {
    return `${agent.name}${builtinSuffix}`;
  }
  return `${agent.name} (${agent.modelTier})${builtinSuffix}`;
}

function PlanTaskModal({
  initialDescription,
  onSubmit,
  onCancel,
}: PlanTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState(initialDescription);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgents((data.agents ?? []) as AgentOption[]))
      .catch(() => setAgents([]));
  }, []);

  const implementerAgents = agents
    .filter((agent) => agent.baseRole === "implementer")
    .sort((a, b) => {
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
      if (a.modelTier !== b.modelTier) {
        const tierOrder = { fast: 0, default: 1, strong: 2 } as const;
        return tierOrder[a.modelTier] - tierOrder[b.modelTier];
      }
      return a.name.localeCompare(b.name);
    });
  const canSubmit = description.trim().length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        description: description.trim(),
        agentId: agentId || undefined,
      });
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">New Task</h3>
        </div>
        <div className="p-5 space-y-5 overflow-y-auto">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Title (optional)</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short task title (auto-derived from description if omitted)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Task Description</label>
            <textarea
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what should be done, expected outcome, and constraints..."
              rows={7}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSubmit();
                }
                if (e.key === "Escape" && !submitting) onCancel();
              }}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Implementer Agent (optional)</label>
            <div className="relative">
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="select-flat w-full pl-3 pr-8 py-2 text-sm"
              >
                <option value="">Use project default implementer</option>
                {implementerAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {formatAgentOptionLabel(agent, "implementer")}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            </div>
          </div>

          {submitError && (
            <p className="text-xs text-red-400">{submitError}</p>
          )}

          <p className="text-xs text-zinc-600">⌘ Enter to create task</p>
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => { void handleSubmit(); }}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            {submitting ? "Creating..." : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
