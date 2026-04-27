import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, X } from "lucide-react";
import { LoadingDots } from "../LoadingDots";
import { SecretInput } from "../SecretInput";

type StackTemplate = "nextjs-saas" | "express-api" | "auto";
type LlmProvider = "anthropic" | "openai" | "google" | "groq" | "ollama" | "local";

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
    if (expanded) { setExpanded(false); return; }
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
          rowSelected ? "bg-zinc-700/70 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/70"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span
          onClick={toggleExpand}
          className="w-4 h-4 flex items-center justify-center text-zinc-500 hover:text-zinc-300"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        {expanded
          ? <FolderOpen className="h-3.5 w-3.5 text-zinc-400" />
          : <Folder className="h-3.5 w-3.5 text-zinc-400" />}
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

interface NewProjectModalProps {
  currentProjectPath: string | null;
  onCancel: () => void;
  onSubmit: (submission: InitModalSubmission) => void;
}

export function NewProjectModal({ currentProjectPath, onCancel, onSubmit }: NewProjectModalProps) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrowser]);

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
        .then((data) => { setDirInspect(data); setDirInspectError(null); })
        .catch((err: Error) => { setDirInspect(null); setDirInspectError(err.message); });
      void fetchLlmStatus(input)
        .then((data) => {
          setLlmStatus(data);
          setLlmStatusError(null);
          setSelectedProvider((prev) => prev || data.activeProvider || "anthropic");
        })
        .catch((err: Error) => { setLlmStatus(null); setLlmStatusError(err.message); });
    }, 220);

    return () => clearTimeout(timeout);
  }, [pathInput]);

  const showLlmSetup = llmStatus ? !llmStatus.hasAnyKey : true;
  const providerNeedsApiKey = selectedProvider !== "ollama" && selectedProvider !== "local";
  const canSubmit =
    pathInput.trim().length > 0
    && description.trim().length > 0
    && (!showLlmSetup || !providerNeedsApiKey || apiKey.trim().length > 0)
    && (!dirInspect || dirInspect.isDirectory || !dirInspect.exists);

  function renderDirectoryStatus() {
    if (dirInspectError) return <p className="text-xs text-red-400">{dirInspectError}</p>;
    if (!pathInput.trim()) return <p className="text-xs text-zinc-500">Choose a directory path for the new project.</p>;
    if (!dirInspect) return <p className="text-xs text-zinc-500">Checking directory status…</p>;
    if (!dirInspect.exists) return <p className="text-xs text-zinc-400">Directory does not exist yet. It will be created on init.</p>;
    if (!dirInspect.isDirectory) return <p className="text-xs text-red-400">This path points to a file. Choose a directory.</p>;
    if (dirInspect.hasBender) return <p className="text-xs text-amber-400">This directory already contains a <code>.bender</code> state.</p>;
    if (dirInspect.empty) return <p className="text-xs text-emerald-400">Empty directory. Great for a clean initialization.</p>;
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
          <button onClick={onCancel} className="rounded-md p-1 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-6 overflow-y-auto">
          {/* Step 1: Directory */}
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
                {showBrowser ? "Hide" : "Explorer"}
              </button>
            </div>
            {renderDirectoryStatus()}
            {dirInspect?.path && (
              <p className="text-[11px] text-zinc-600 font-mono truncate">{dirInspect.path}</p>
            )}
            {showBrowser && (
              <div className="border border-zinc-800 rounded-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
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

          {/* Step 2: Description */}
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

          {/* Step 3: Stack */}
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
            <p className="text-xs text-zinc-600">
              Only <code>nextjs-saas</code> is fully scaffold-aware today. Other picks are saved as planning hints.
            </p>
          </section>

          {/* Step 4: LLM setup (if needed) */}
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
                {(["anthropic", "openai", "google", "groq", "ollama", "local"] as LlmProvider[]).map((provider) => (
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
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors">
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
