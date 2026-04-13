import { useState, useRef, useEffect } from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import type { OutputLine, OperationStatus, OperationModal } from "../hooks/useOperation";

type StackTemplate = "nextjs-saas" | "express-api" | "auto";
type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama";

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
  onSubmitPlan: (text: string) => void;
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
  onSubmitPlan,
}: OperationDrawerProps) {
  const [activeTab, setActiveTab] = useState<"console" | "review">("console");
  const [collapsed, setCollapsed] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(288);
  const [isResizing, setIsResizing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const resizeStartYRef = useRef(0);
  const resizeStartHeightRef = useRef(288);
  const isRunning = status === "running";

  function lineText(line: OutputLine): string {
    if (line.kind === "header" || line.kind === "subheader" || line.kind === "stream") return line.text;
    if (line.kind === "output") return line.text;
    if (line.kind === "spinner") return line.text;
    if (line.kind === "error") return line.message;
    if (line.kind === "confirm") return line.question;
    if (line.kind === "prompt") return line.question;
    if (line.kind === "done") return line.success ? "done" : "failed";
    if (line.kind === "files") return line.ops.map((op) => `${op.action} ${op.path}`).join(" ");
    return "";
  }

  function collectReviewLineIndexes(allLines: OutputLine[]): Set<number> {
    const indexes = new Set<number>();
    let inReviewSection = false;

    for (let i = 0; i < allLines.length; i += 1) {
      const line = allLines[i];

      if (line.kind === "subheader") {
        if (line.text.trim().toLowerCase() === "reviewer gate") {
          inReviewSection = true;
          indexes.add(i);
          continue;
        }
        if (inReviewSection) {
          inReviewSection = false;
        }
      }

      if (line.kind === "header" && inReviewSection) {
        inReviewSection = false;
      }

      const text = lineText(line).toLowerCase();
      const looksReviewerSpecific =
        text.includes("reviewer status")
        || text.includes("using reviewer agent")
        || text.includes("reviewer checks")
        || text.includes("reviewer returned")
        || text.includes("reviewer provided")
        || text.includes("reviewer observations")
        || text.includes("reviewer found");

      if (inReviewSection || looksReviewerSpecific) {
        indexes.add(i);
      }
    }

    return indexes;
  }

  const reviewIndexes = collectReviewLineIndexes(lines);
  const reviewCount = reviewIndexes.size;
  const visibleLines = activeTab === "review"
    ? lines.filter((_, i) => reviewIndexes.has(i))
    : lines;

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
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [visibleLines, collapsed]);

  useEffect(() => {
    if (status === "running") setCollapsed(false);
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
        <InputModal
          title="New Task"
          placeholder="Describe the feature, fix, or change…"
          value={inputText}
          onChange={onSetInputText}
          onSubmit={() => {
            const text = inputText.trim();
            if (!text) return;
            onSetInputText("");
            onSetModal(null);
            onSubmitPlan(text);
          }}
          onCancel={() => { onSetModal(null); onSetInputText(""); }}
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
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse shrink-0" />
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
              onClick={() => setActiveTab("review")}
              className={`px-3 h-full rounded-none text-[11px] transition-colors ${
                activeTab === "review"
                  ? "text-zinc-100 bg-zinc-900"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60"
              }`}
            >
              Review{reviewCount > 0 ? ` (${reviewCount})` : ""}
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
          <button
            onClick={() => setCollapsed(true)}
            className="text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Minimize"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {!collapsed && (
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
              />
            ))}
            {isRunning && (
              <div className="flex items-center gap-1.5 text-zinc-500 pt-1">
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" />
                <span>running</span>
              </div>
            )}
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
  const providerNeedsApiKey = selectedProvider !== "ollama";

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
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Loading directories…</span>
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
                {(["anthropic", "openai", "google", "groq", "ollama"] as LlmProvider[]).map((provider) => (
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
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={`${selectedProvider.toUpperCase()} API key`}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
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
            <p className="text-[11px] text-zinc-500 px-2 py-1" style={{ paddingLeft: `${28 + depth * 14}px` }}>
              Loading…
            </p>
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
}

function OutputLineView({ line, lineIdx, onConfirm, onPromptSubmit }: LineProps) {
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
      return (
        <div className="flex items-center gap-2 text-zinc-400">
          {line.done ? (
            <span className={line.success ? "text-emerald-400" : "text-red-400"}>{line.success ? "✓" : "✗"}</span>
          ) : (
            <span className="animate-spin inline-block">⟳</span>
          )}
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

interface InputModalProps {
  title: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function InputModal({ title, placeholder, value, onChange, onSubmit, onCancel }: InputModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        </div>
        <div className="p-5 space-y-4">
          <textarea
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={5}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
          />
          <p className="text-xs text-zinc-600">⌘ Enter to start</p>
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
