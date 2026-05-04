import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DefaultChatTransport,
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  type DynamicToolUIPart,
  type UIMessage,
  type UITools,
  type ToolUIPart,
} from "ai";
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, MessageSquarePlus, Pencil, Send, Square, Trash2, X } from "lucide-react";
// MessageSquarePlus, Trash2 used in ConversationPicker
import { LoadingDots } from "./LoadingDots";
import { OperationBlock, type OperationSummary } from "./OperationBlock";
import { buildOperationMessage, getOperationSummary, isOperationMessage, persistOperationMessage } from "../lib/operation-message";
import type { OutputLine, OperationStatus as OpStatus } from "../hooks/useOperation";

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

type SlashCommandKind = "action" | "prompt";

interface SlashCommand {
  name: string;
  description: string;
  kind: SlashCommandKind;
  /** For "action" commands — called immediately on selection */
  onAction?: () => void;
  /** For "prompt" commands — text that replaces the slash command in the textarea */
  prompt?: string;
}

// Commands are built once inside the component so they can close over props.
function buildCommands(opts: {
  onClear: () => void;
  onNewThread: () => void;
  onRunOperation?: (url: string, body?: Record<string, unknown>) => void;
  isGlobal?: boolean;
}): SlashCommand[] {
  if (opts.isGlobal) {
    return [
      { name: "open",   description: "Open a local project directory", kind: "prompt", prompt: "Open project at path: " },
      { name: "clone",  description: "Clone a GitHub repo and open it", kind: "prompt", prompt: "Clone this repo: " },
      { name: "recent", description: "List recently opened projects", kind: "prompt", prompt: "Show my recent projects" },
      { name: "new",    description: "Start a new conversation (⌘K)", kind: "action", onAction: opts.onNewThread },
      { name: "clear",  description: "Hide messages in this conversation", kind: "action", onAction: opts.onClear },
    ];
  }
  return [
    // Task management — handled by the deterministic operator parser
    { name: "task list",   description: "List all tasks and their status", kind: "prompt", prompt: "/task list" },
    { name: "task add",    description: "Add a new task — type the title after the command", kind: "prompt", prompt: "/task add " },
    { name: "task run",    description: "Run a task by ID — /task run <id>", kind: "prompt", prompt: "/task run " },
    { name: "task update", description: "Update a task — /task update <id> title=… status=…", kind: "prompt", prompt: "/task update " },
    { name: "task delete", description: "Delete a task — /task delete <id>", kind: "prompt", prompt: "/task delete " },

    // Run operations — direct API, no LLM
    { name: "analyze",        description: "Re-analyze codebase and refresh architecture", kind: "action", onAction: () => opts.onRunOperation?.("/api/run/analyze") },
    { name: "run analyze",    description: "Re-analyze codebase and refresh architecture", kind: "action", onAction: () => opts.onRunOperation?.("/api/run/analyze") },
    { name: "run implement",  description: "Execute the current task plan", kind: "action", onAction: () => opts.onRunOperation?.("/api/run/implement") },

    // Audit — deterministic operator parser
    { name: "audit security", description: "Run a security audit on the codebase", kind: "prompt", prompt: "/audit security" },
    { name: "audit tests",    description: "Audit test coverage and quality", kind: "prompt", prompt: "/audit tests" },
    { name: "audit ci",       description: "Audit CI pipeline configuration", kind: "prompt", prompt: "/audit ci" },

    // Planning — LLM prompt templates
    { name: "plan init",    description: "Create an initial task plan from the project brief", kind: "prompt", prompt: "Create an initial task plan for this project. Analyze the codebase and brief, then generate a structured list of tasks needed to reach MVP." },
    { name: "plan feature", description: "Extend the task plan with a new feature", kind: "prompt", prompt: "Add a new feature to the task plan: " },

    // Ask — read-only LLM Q&A
    { name: "ask brief",        description: "Summarize the project brief and goals", kind: "prompt", prompt: "Summarize the current project brief — what are the goals, constraints, and key features?" },
    { name: "ask architecture", description: "Describe the current architecture and stack", kind: "prompt", prompt: "Describe the current architecture: stack, key patterns, schema, and any important decisions." },
    { name: "ask status",       description: "Summarize recent changes and open tasks", kind: "prompt", prompt: "What is the current project status? Summarize recent changes, open tasks, and anything that needs attention." },

    // Conversation utilities
    { name: "new",   description: "Start a new conversation (⌘K)", kind: "action", onAction: opts.onNewThread },
    { name: "clear", description: "Hide messages in this conversation", kind: "action", onAction: opts.onClear },
  ];
}

// ---------------------------------------------------------------------------
// Chat types + helpers
// ---------------------------------------------------------------------------

interface ChatThread {
  id: string;
  title: string;
  provider: string;
  model: string;
  toolsEnabled: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

function scopeKey(projectPath: string | null): string {
  return projectPath ?? "__global__";
}

function keyForProject(projectPath: string | null): string {
  return `bender.chat.activeThread.${scopeKey(projectPath)}`;
}

export function pickUsableThread(
  threads: ChatThread[],
  options: {
    preferredThreadId?: string | null;
    savedThreadId?: string | null;
  },
): ChatThread | null {
  const activeThreads = threads.filter((thread) => !thread.archived);
  if (activeThreads.length === 0) return null;

  const preferred = options.preferredThreadId?.trim();
  if (preferred) {
    const match = activeThreads.find((thread) => thread.id === preferred);
    if (match) return match;
  }

  const saved = options.savedThreadId?.trim();
  if (saved) {
    const match = activeThreads.find((thread) => thread.id === saved);
    if (match) return match;
  }

  return activeThreads[0] ?? null;
}

function hiddenKey(projectPath: string | null): string {
  return `bender.chat.hiddenMessages.${scopeKey(projectPath)}`;
}

function loadHidden(projectPath: string | null): Record<string, Record<string, true>> {
  try {
    const raw = localStorage.getItem(hiddenKey(projectPath));
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, Record<string, true>>;
  } catch {
    return {};
  }
}

function saveHidden(projectPath: string | null, hidden: Record<string, Record<string, true>>): void {
  try {
    localStorage.setItem(hiddenKey(projectPath), JSON.stringify(hidden));
  } catch {
    /* storage quota or private-mode — fail silently */
  }
}

/** Cast UIMessage.metadata (typed as {}) to a looser type for custom fields. */
function msgMeta(message: UIMessage): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>;
}

function safeNowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}`;
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|canceled|cancelled/i.test(error.message);
  }
  return false;
}

type ClientLogLevel = "debug" | "info" | "warn" | "error";

function postClientLog(
  level: ClientLogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  void fetch("/api/logs/client", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, component, message, ...(data ? { data } : {}) }),
  }).catch(() => {});
}

function summarizeValue(value: unknown, maxChars = 320): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string"
    ? value
    : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// Keep TS happy — summarizeValue is used only for logging context
void summarizeValue;

function messageToText(message: UIMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (isTextUIPart(part) || isReasoningUIPart(part)) {
      if (part.text.trim()) chunks.push(part.text.trim());
    }
  }
  return chunks.join("\n\n").trim();
}

export function toolDisplayName(toolName: string): string {
  return toolName.replace(/^bender_/, "").replace(/_/g, " ");
}

/** Best-effort label from a /api/run/* URL. */
function labelFromUrl(url?: string): string {
  if (!url) return "Operation";
  const m = url.match(/\/api\/(?:run|audit|evals)\/([^?#]+)/);
  if (!m) return "Operation";
  const tail = m[1].replace(/\//g, " ").replace(/-/g, " ");
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function ToolCallRow({ part }: { part: ToolUIPart<UITools> | DynamicToolUIPart }) {
  const name = getToolName(part);
  const state = part.state;
  const label = toolDisplayName(name);
  const isDone = state === "output-available" || state === "output-error" || state === "output-denied";
  const isError = state === "output-error";

  return (
    <div className={`flex items-center gap-1.5 py-0.5 text-[10px] select-none ${
      isError ? "text-bender-danger" : isDone ? "text-zinc-500" : "text-zinc-600"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        isError ? "bg-bender-danger" : isDone ? "bg-zinc-600" : "bg-zinc-700 animate-pulse"
      }`} />
      <span className="font-mono">{label}</span>
      {!isDone && <span className="text-zinc-700">…</span>}
      {isDone && !isError && <span className="text-zinc-700">✓</span>}
      {isError && <span>failed</span>}
    </div>
  );
}

/**
 * Collapsible group of tool calls — Claude-Code-style "Ran 8 tools" summary.
 * Auto-expanded if the last tool is still running OR if any tool errored.
 */
function ToolPartsGroup({ parts }: { parts: (ToolUIPart<UITools> | DynamicToolUIPart)[] }) {
  const lastState = parts[parts.length - 1]?.state;
  const isRunning = lastState !== "output-available" && lastState !== "output-error" && lastState !== "output-denied";
  const hasError = parts.some((p) => p.state === "output-error");
  const [expanded, setExpanded] = useState<boolean>(isRunning || hasError);

  const succeeded = parts.filter((p) => p.state === "output-available").length;
  const errored = parts.filter((p) => p.state === "output-error").length;
  const running = parts.filter((p) => {
    const s = p.state;
    return s !== "output-available" && s !== "output-error" && s !== "output-denied";
  }).length;

  const summary: string[] = [];
  if (succeeded) summary.push(`${succeeded} ok`);
  if (running)   summary.push(`${running} running`);
  if (errored)   summary.push(`${errored} failed`);

  return (
    <div className="mt-1 select-none">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {expanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
        <span>
          {parts.length === 1 ? "Used 1 tool" : `Ran ${parts.length} tools`}
          {summary.length > 0 && <span className="text-zinc-600"> · {summary.join(" · ")}</span>}
        </span>
      </button>
      {expanded && (
        <div className="mt-0.5 ml-3.5 space-y-0.5">
          {parts.map((part, i) => (
            <ToolCallRow key={i} part={part} />
          ))}
        </div>
      )}
    </div>
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({})) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

export function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// ConversationPicker sub-component
// ---------------------------------------------------------------------------

interface ConversationPickerProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onClose: () => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onArchiveToggle: (threadId: string, archive: boolean) => void;
}

function ConversationPicker({
  threads, activeThreadId, onSelect, onNew, onClose, onDelete, onRename, onArchiveToggle,
}: ConversationPickerProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const active = threads.filter((t) => !t.archived);
  const archived = threads.filter((t) => t.archived);

  function startRename(thread: ChatThread) {
    setRenamingId(thread.id);
    setRenameValue(thread.title);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }

  function commitRename(threadId: string) {
    const trimmed = renameValue.trim();
    if (trimmed) onRename(threadId, trimmed);
    setRenamingId(null);
  }

  function renderThread(thread: ChatThread, isArchivedSection = false) {
    const isActive = thread.id === activeThreadId;
    const isRenaming = renamingId === thread.id;
    return (
      <li key={thread.id} className="group">
        {isRenaming ? (
          <div className="flex items-center gap-1 px-3 py-1.5">
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(thread.id);
                if (e.key === "Escape") setRenamingId(null);
              }}
              onBlur={() => commitRename(thread.id)}
              className="flex-1 min-w-0 text-xs bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-zinc-100 focus:outline-none focus:border-zinc-400"
            />
            <button
              onMouseDown={(e) => { e.preventDefault(); setRenamingId(null); }}
              className="text-zinc-600 hover:text-zinc-400 shrink-0"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <div
            className={`flex items-center gap-2 px-3 py-2 transition-colors ${isActive ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
            style={isActive ? { background: "var(--bender-overlay-active)" } : undefined}
            onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--bender-overlay-hover)"; }}
            onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = ""; }}
          >
            <button
              onClick={() => { onSelect(thread.id); onClose(); }}
              className="flex-1 min-w-0 flex items-center gap-2 text-left"
            >
              <span className={`flex-1 min-w-0 text-xs truncate ${isArchivedSection ? "opacity-60" : ""}`}>
                {thread.title}
              </span>
              <span className="shrink-0 text-[10px] text-zinc-600">{relativeTime(thread.updatedAt)}</span>
              {isActive && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-bender-success" />}
            </button>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {!isArchivedSection && (
                <button
                  onClick={(e) => { e.stopPropagation(); startRename(thread); }}
                  title="Rename"
                  className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
                >
                  <Pencil className="h-2.5 w-2.5" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onArchiveToggle(thread.id, !isArchivedSection); }}
                title={isArchivedSection ? "Restore" : "Archive"}
                className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
              >
                {isArchivedSection
                  ? <ArchiveRestore className="h-2.5 w-2.5" />
                  : <Archive className="h-2.5 w-2.5" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(thread.id); }}
                title="Delete"
                className="p-0.5 rounded text-zinc-600 hover:text-bender-danger hover:bg-zinc-700/50 transition-colors"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <>
      {/* Backdrop — fixed so it covers the full viewport, not just the header bar */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Panel */}
      <div
        className="absolute top-full left-0 right-0 z-50 mt-px rounded-b-xl overflow-hidden"
        style={{ background: "var(--bender-surface-overlay)", border: "1px solid var(--bender-overlay-border)", boxShadow: "var(--bender-shadow-overlay)" }}
      >
        <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: "1px solid var(--bender-overlay-border)" }}>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Conversations</span>
          <button
            onClick={onNew}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <MessageSquarePlus className="h-3 w-3" />
            New
            <kbd className="ml-0.5 text-[9px] text-zinc-700">⌘K</kbd>
          </button>
        </div>
        <ul className="max-h-64 overflow-y-auto py-1">
          {active.map((t) => renderThread(t, false))}
          {active.length === 0 && (
            <li className="px-3 py-2 text-[11px] text-zinc-600 italic">No conversations yet</li>
          )}
          {archived.length > 0 && (
            <>
              <li>
                <button
                  onClick={() => setShowArchived((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                  style={{ borderTop: "1px solid var(--bender-overlay-border)" }}
                >
                  <Archive className="h-2.5 w-2.5" />
                  <span>Archived ({archived.length})</span>
                  <ChevronDown className={`h-2.5 w-2.5 ml-auto transition-transform ${showArchived ? "rotate-180" : ""}`} />
                </button>
              </li>
              {showArchived && archived.map((t) => renderThread(t, true))}
            </>
          )}
        </ul>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ChatTriggerKind = "analyze" | "new-task" | "new-project";

export interface ChatTrigger {
  /** Increments each time a new trigger fires; ChatPanel uses this to detect changes. */
  token: number;
  kind: ChatTriggerKind;
}

interface ChatPanelProps {
  projectPath: string | null;
  clearToken?: number;
  /** Called when a slash command triggers a backend operation */
  onRunOperation?: (url: string, body?: Record<string, unknown>) => void;
  /** Imperative trigger fired by parent (sidebar buttons, onNewTask, etc.) */
  trigger?: ChatTrigger | null;
  /** Extra icon buttons rendered at the right end of the conversation bar */
  headerActions?: React.ReactNode;
  /**
   * Live operation feed — when present, renders an inline OperationBlock
   * with collapsible event log + approval gates. Persists to the active
   * thread once the operation finishes.
   */
  operation?: {
    lines: OutputLine[];
    status: OpStatus;
    /** Increments each time a new operation is started */
    runId: number;
    /** Optional label override; defaults to URL-derived */
    label?: string;
    url?: string;
    handleConfirm: (id: string, idx: number, answer: boolean) => void;
    handlePromptSubmit: (id: string, idx: number, text: string) => void;
  } | null;
}

// ---------------------------------------------------------------------------
// SlashMenu sub-component
// ---------------------------------------------------------------------------

function SlashMenu({
  commands,
  filter,
  activeIndex,
  onSelect,
  onHover,
}: {
  commands: SlashCommand[];
  filter: string;
  activeIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  const filtered = useMemo(
    () => commands.filter((c) => c.name.startsWith(filter.toLowerCase())),
    [commands, filter],
  );

  const listRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  // Scroll the active item into view whenever it changes via keyboard
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1.5 rounded-xl overflow-hidden z-50"
      style={{ background: "var(--bender-surface-overlay)", border: "1px solid var(--bender-overlay-border)", boxShadow: "var(--bender-shadow-overlay)" }}
    >
      <div className="px-3 py-1.5" style={{ borderBottom: "1px solid var(--bender-overlay-border)" }}>
        <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Commands</span>
      </div>
      <ul ref={listRef} className="max-h-56 overflow-y-auto py-1">
        {filtered.map((cmd, i) => {
          const isActive = i === activeIndex;
          return (
            <li key={cmd.name} ref={isActive ? activeRef : undefined}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
                onMouseEnter={() => onHover(i)}
                className="w-full flex items-start gap-3 px-3 py-2 text-left transition-colors"
                style={{ background: isActive ? "var(--bender-overlay-active)" : undefined }}
              >
                <span className={`font-mono text-xs shrink-0 pt-px ${isActive ? "text-zinc-100" : "text-zinc-300"}`}>
                  /{cmd.name}
                </span>
                <span className="text-[11px] text-zinc-500 leading-relaxed">{cmd.description}</span>
                {cmd.kind === "action" && (
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-600 border rounded px-1 py-px" style={{ borderColor: "var(--bender-overlay-border)" }}>run</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="px-3 py-1.5 flex items-center gap-3" style={{ borderTop: "1px solid var(--bender-overlay-border)" }}>
        <span className="text-[10px] text-zinc-600">↑↓ navigate</span>
        <span className="text-[10px] text-zinc-600">↵ select</span>
        <span className="text-[10px] text-zinc-600">esc dismiss</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChatPanel({ projectPath, clearToken = 0, onRunOperation, trigger, headerActions, operation }: ChatPanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hiddenMessageIdsByThread, setHiddenMessageIdsByThread] = useState<Record<string, Record<string, true>>>(
    () => (projectPath ? loadHidden(projectPath) : {}),
  );

  // Slash command menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);

  // Conversation picker
  const [pickerOpen, setPickerOpen] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const userCancelledRef = useRef(false);
  const scopeRef = useRef(scopeKey(projectPath));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Operation message persistence: track which runIds we've already persisted
  const persistedRunIdsRef = useRef<Set<number>>(new Set());
  // Track operation start time per runId
  const operationStartTimesRef = useRef<Map<number, number>>(new Map());

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const hiddenForActiveThread = useMemo(
    () => (activeThread ? (hiddenMessageIdsByThread[activeThread.id] ?? {}) : {}),
    [activeThread, hiddenMessageIdsByThread],
  );
  const visibleMessages = useMemo(
    () => messages.filter((message) => !hiddenForActiveThread[message.id]),
    [messages, hiddenForActiveThread],
  );

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------

  const clearMessages = useCallback(() => {
    if (!activeThread || sending || messages.length === 0) return;
    setHiddenMessageIdsByThread((prev) => {
      const existing = prev[activeThread.id] ?? {};
      const nextHidden = { ...existing };
      for (const message of messages) { nextHidden[message.id] = true; }
      const next = { ...prev, [activeThread.id]: nextHidden };
      saveHidden(projectPath, next);
      return next;
    });
  }, [activeThread, projectPath, sending, messages]);

  // createNewThread is defined after createThread in the thread management section below.
  // We use a stable ref so the commands memo and keydown handler can reference it without
  // circular dependency issues.
  const createNewThreadRef = useRef<() => Promise<void>>(async () => {});

  const commands = useMemo(
    () => buildCommands({
      onClear: () => void clearMessages(),
      onNewThread: () => void createNewThreadRef.current(),
      onRunOperation,
      isGlobal: projectPath === null,
    }),
    [clearMessages, onRunOperation, projectPath],
  );

  // Derive slash filter from draft — menu opens when entire draft is /word
  const slashFilter = useMemo(() => {
    const m = draft.match(/^\/(\w*)$/);
    return m ? m[1] : null;
  }, [draft]);

  const filteredCommands = useMemo(
    () => slashFilter !== null
      ? commands.filter((c) => c.name.startsWith(slashFilter.toLowerCase()))
      : [],
    [commands, slashFilter],
  );

  // Sync menu open state
  useEffect(() => {
    if (slashFilter !== null && filteredCommands.length > 0) {
      setMenuOpen(true);
      setMenuIndex(0);
    } else {
      setMenuOpen(false);
    }
  }, [slashFilter, filteredCommands.length]);

  function selectCommand(cmd: SlashCommand) {
    setMenuOpen(false);
    if (cmd.kind === "action") {
      setDraft("");
      cmd.onAction?.();
    } else {
      setDraft(cmd.prompt ?? "");
      // Focus and move cursor to end
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Global prefill / new-thread events (from HomeView, drawer header)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail ?? "";
      if (!text) return;
      setDraft(text);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    };
    window.addEventListener("bender:prefill-chat", handler);
    return () => window.removeEventListener("bender:prefill-chat", handler);
  }, []);

  useEffect(() => {
    const handler = () => { void createNewThreadRef.current(); };
    window.addEventListener("bender:new-thread", handler);
    return () => window.removeEventListener("bender:new-thread", handler);
  }, []);

  // ---------------------------------------------------------------------------
  // Operation message persistence — when an op completes, append a synthetic
  // assistant message carrying the full event log to the active thread.
  // Survives reload, shows up in scrollback, LLM sees the summary on next turn.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!operation) return;
    if (operation.status !== "done" && operation.status !== "error") return;
    if (!activeThreadId) return;
    if (operation.lines.length === 0) return;
    if (persistedRunIdsRef.current.has(operation.runId)) return;

    persistedRunIdsRef.current.add(operation.runId);

    const startedAt = operationStartTimesRef.current.get(operation.runId) ?? Date.now();
    const finishedAt = Date.now();
    operationStartTimesRef.current.delete(operation.runId);

    const opMessage = buildOperationMessage({
      id: `op-${operation.runId}-${Date.now()}`,
      label: operation.label ?? labelFromUrl(operation.url),
      url: operation.url,
      status: operation.status === "done" ? "done" : "error",
      startedAt,
      finishedAt,
      events: operation.lines,
    });

    // Optimistic local insert + persist
    setMessages((prev) => [...prev, opMessage]);
    void persistOperationMessage(activeThreadId, opMessage);
  }, [operation, activeThreadId]);

  // ---------------------------------------------------------------------------
  // Trigger handling (sidebar buttons / onNewTask)
  // ---------------------------------------------------------------------------

  const prevTriggerTokenRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!trigger) return;
    if (trigger.token === prevTriggerTokenRef.current) return;
    prevTriggerTokenRef.current = trigger.token;

    if (trigger.kind === "analyze") {
      // Run analyze op + inject a notification row
      onRunOperation?.("/api/run/analyze");
      const note: UIMessage = {
        id: safeNowId(),
        role: "user",
        parts: [{ type: "text", text: "🔍 Analyzing project…" }],
        metadata: { kind: "trigger", label: "Analyzing project…" },
      };
      setMessages((prev) => [...prev, note]);
    } else if (trigger.kind === "new-task") {
      setDraft("Add a new task to the plan: ");
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    } else if (trigger.kind === "new-project") {
      // Send as a user message — the LLM will call bender_clarify_project
      setDraft("I want to set up a new project. Help me get started.");
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  // ---------------------------------------------------------------------------
  // Thread management
  // ---------------------------------------------------------------------------

  const createThread = useCallback(async (title?: string): Promise<ChatThread> => {
    const data = await fetchJson<{ thread: ChatThread }>("/api/chat/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title?.trim() ? { title: title.trim() } : {}),
    });
    return data.thread;
  }, []);

  // Create a fresh thread and switch to it (⌘K).
  const createNewThread = useCallback(async () => {
    try {
      const thread = await createThread("Chat");
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setMessages([]);
      setDraft("");
      setError(null);
    } catch (err) {
      setError(parseErrorMessage(err));
    }
  }, [createThread, projectPath]);

  // Keep the ref in sync so commands/keydown can call it without stale closures.
  useEffect(() => { createNewThreadRef.current = createNewThread; }, [createNewThread]);

  const loadThreads = useCallback(async (): Promise<string | null> => {
    setLoadingThreads(true);
    try {
      const data = await fetchJson<{ threads: ChatThread[] }>("/api/chat/threads?includeArchived=true");
      let nextThreads = data.threads ?? [];
      const nonArchived = nextThreads.filter((t) => !t.archived);
      if (nonArchived.length === 0) {
        const created = await createThread("Chat");
        nextThreads = [created, ...nextThreads];
      }
      setThreads(nextThreads);
      const savedId = localStorage.getItem(keyForProject(projectPath));
      const restoredId = savedId ? nextThreads.find((t) => t.id === savedId && !t.archived)?.id : undefined;
      const selected = restoredId ?? nextThreads.find((t) => !t.archived)?.id ?? null;
      setActiveThreadId(selected);
      if (selected) localStorage.setItem(keyForProject(projectPath), selected);
      return selected;
    } catch (err) {
      setError(parseErrorMessage(err));
      return null;
    } finally {
      setLoadingThreads(false);
    }
  }, [createThread, projectPath]);

  const loadMessages = useCallback(async (threadId: string) => {
    setLoadingMessages(true);
    try {
      const data = await fetchJson<{ messages: UIMessage[] }>(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`);
      setMessages(data.messages ?? []);
    } catch (err) {
      setError(parseErrorMessage(err));
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const deleteThread = useCallback(async (threadId: string) => {
    try {
      await fetchJson<Record<string, never>>(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      const nextThreads = threads.filter((t) => t.id !== threadId);
      if (nextThreads.length === 0) {
        const created = await createThread("Chat");
        setThreads([created]);
        setActiveThreadId(created.id);
        setMessages([]);
      } else {
        setThreads(nextThreads);
        if (activeThreadId === threadId) {
          setActiveThreadId(nextThreads[0].id);
        }
      }
    } catch (err) {
      setError(parseErrorMessage(err));
    }
  }, [activeThreadId, createThread, projectPath, threads]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    try {
      const data = await fetchJson<{ thread: ChatThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setThreads((prev) => prev.map((t) => t.id === threadId ? data.thread : t));
    } catch (err) {
      setError(parseErrorMessage(err));
    }
  }, []);

  const archiveThread = useCallback(async (threadId: string, archive: boolean) => {
    try {
      const data = await fetchJson<{ thread: ChatThread }>(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: archive }),
      });
      const updated = data.thread;
      setThreads((prev) => {
        const next = prev.map((t) => t.id === threadId ? updated : t);
        return next;
      });
      // If we archived the active thread, switch to the next non-archived one
      if (archive && activeThreadId === threadId) {
        const nextActive = threads.find((t) => t.id !== threadId && !t.archived);
        if (nextActive) {
          setActiveThreadId(nextActive.id);
        }
      }
    } catch (err) {
      setError(parseErrorMessage(err));
    }
  }, [activeThreadId, threads]);

  useEffect(() => {
    setHiddenMessageIdsByThread(projectPath ? loadHidden(projectPath) : {});
  }, [projectPath]);

  useEffect(() => {
    const nextScope = scopeKey(projectPath);
    if (scopeRef.current === nextScope) return;
    scopeRef.current = nextScope;

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    userCancelledRef.current = false;
    setSending(false);
    setThreads([]);
    setActiveThreadId(null);
    setMessages([]);
    setError(null);
    setMenuOpen(false);
    setPickerOpen(false);
  }, [projectPath]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);
  useEffect(() => {
    if (!activeThreadId) return;
    localStorage.setItem(keyForProject(projectPath), activeThreadId);
    void loadMessages(activeThreadId);
  }, [activeThreadId, loadMessages, projectPath]);
  useEffect(() => () => { abortControllerRef.current?.abort(); abortControllerRef.current = null; }, []);

  useEffect(() => {
    if (clearToken <= 0) return;
    void clearMessages();
  }, [clearMessages, clearToken]);

  // Instant scroll while streaming (avoid janky smooth-scroll on every token chunk);
  // switch to smooth only when a send completes.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: sending ? "instant" : "smooth" });
  }, [messages, sending]);

  const resolveSendThreadContext = useCallback(async (): Promise<{ thread: ChatThread; baseMessages: UIMessage[] }> => {
    const data = await fetchJson<{ threads: ChatThread[] }>("/api/chat/threads?includeArchived=true");
    let nextThreads = data.threads ?? [];

    const savedThreadId = localStorage.getItem(keyForProject(projectPath));
    let selected = pickUsableThread(nextThreads, {
      preferredThreadId: activeThreadId,
      savedThreadId,
    });

    if (!selected) {
      selected = await createThread("Chat");
      nextThreads = [selected, ...nextThreads];
    }

    setThreads(nextThreads);
    setActiveThreadId(selected.id);
    localStorage.setItem(keyForProject(projectPath), selected.id);

    if (selected.id !== activeThreadId) {
      const loaded = await fetchJson<{ messages: UIMessage[] }>(`/api/chat/threads/${encodeURIComponent(selected.id)}/messages`);
      const baseMessages = loaded.messages ?? [];
      setMessages(baseMessages);
      return { thread: selected, baseMessages };
    }

    return { thread: selected, baseMessages: messages };
  }, [activeThreadId, createThread, messages, projectPath]);

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  const sendText = useCallback(async (text: string) => {
    if (sending) return;
    if (!text.trim()) return;

    let sendContext: { thread: ChatThread; baseMessages: UIMessage[] };
    try {
      sendContext = await resolveSendThreadContext();
    } catch (err) {
      setError(parseErrorMessage(err));
      return;
    }

    const { thread: sendThread, baseMessages } = sendContext;

    const userMessage: UIMessage = {
      id: safeNowId(),
      role: "user",
      parts: [{ type: "text", text: text.trim() }],
      metadata: {
        provider: sendThread.provider,
        model: sendThread.model,
        toolsEnabled: true,
        createdAt: Date.now(),
      },
    };

    const outgoingMessages = [...baseMessages.filter((m) => msgMeta(m).kind !== "trigger"), userMessage];
    setMessages(outgoingMessages);
    setDraft("");
    setSending(true);
    setError(null);
    userCancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const requestId = safeNowId();
    postClientLog("info", "chat-panel", "Chat request started", {
      requestId, threadId: sendThread.id, messageId: userMessage.id,
      messageLength: text.length, outgoingMessageCount: outgoingMessages.length,
    });

    try {
      const transport = new DefaultChatTransport<UIMessage>({
        api: `/api/chat/threads/${encodeURIComponent(sendThread.id)}/respond`,
      });
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: sendThread.id,
        messageId: userMessage.id,
        messages: outgoingMessages,
        abortSignal: controller.signal,
      });

      let partialCount = 0;
      let assistantPartialCount = 0;
      for await (const partial of readUIMessageStream<UIMessage>({ stream })) {
        partialCount += 1;
        if (partial.role === "assistant") assistantPartialCount += 1;
        setMessages((prev) => {
          const existingIdx = prev.findIndex((message) => message.id === partial.id);
          if (existingIdx === -1) return [...prev, partial];
          const next = [...prev];
          next[existingIdx] = partial;
          return next;
        });
      }

      if (assistantPartialCount === 0) {
        postClientLog("warn", "chat-panel", "Chat stream ended without assistant output", {
          requestId, threadId: sendThread.id, partialCount,
          outgoingMessageCount: outgoingMessages.length,
        });
        const refreshed = await fetchJson<{ messages: UIMessage[] }>(
          `/api/chat/threads/${encodeURIComponent(sendThread.id)}/messages`,
        );
        const refreshedMessages = refreshed.messages ?? [];
        const hasAssistantReply = refreshedMessages.some((m) => m.role === "assistant");
        setMessages(refreshedMessages);
        if (!hasAssistantReply) throw new Error("No assistant response was produced. Check /api/logs for details.");
      } else {
        postClientLog("info", "chat-panel", "Chat stream completed", {
          requestId, threadId: sendThread.id, partialCount, assistantPartialCount,
        });
      }

      await loadThreads();
      // Signal App.tsx to refresh project state (e.g. after global-mode open/clone)
      window.dispatchEvent(new CustomEvent("bender:chat-stream-finished"));
    } catch (err) {
      if (userCancelledRef.current || isAbortLikeError(err)) {
        postClientLog("info", "chat-panel", "Chat request cancelled", { requestId, threadId: sendThread.id });
        return;
      }
      const errorText = parseErrorMessage(err);
      setError(errorText);
      postClientLog("error", "chat-panel", "Chat request failed", { requestId, threadId: sendThread.id, error: errorText });
    } finally {
      abortControllerRef.current = null;
      userCancelledRef.current = false;
      setSending(false);
    }
  }, [loadThreads, resolveSendThreadContext, sending]);

  /** Send the current draft text. */
  const sendMessage = useCallback(async () => {
    await sendText(draft);
  }, [draft, sendText]);

  const stopMessage = useCallback(() => {
    userCancelledRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setSending(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  // Approve shortcut: send a quick "yes, proceed" when the last visible message
  // is from the assistant and the draft is empty.
  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1] ?? null;
  const canQuickApprove =
    !sending &&
    !draft.trim() &&
    lastVisibleMessage?.role === "assistant";

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const meta = e.metaKey || e.ctrlKey;

    // Slash-menu navigation
    if (menuOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex((i) => Math.min(i + 1, filteredCommands.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setMenuIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = filteredCommands[menuIndex];
        if (cmd) selectCommand(cmd);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setMenuOpen(false); return; }
    }

    // Escape — stop streaming if active, else dismiss menu
    if (e.key === "Escape") {
      e.preventDefault();
      if (sending) { stopMessage(); return; }
      setMenuOpen(false);
      return;
    }

    // ⌘K — new thread
    if (meta && e.key === "k") {
      e.preventDefault();
      void createNewThreadRef.current();
      return;
    }

    // ⌘Enter — quick approve (send "Looks good." when draft is empty and last msg is assistant)
    if (meta && e.key === "Enter" && !draft.trim() && canQuickApprove) {
      e.preventDefault();
      void sendText("Looks good. Please proceed.");
      return;
    }

    // ⌘⇧⌫ — open a revision prompt
    if (meta && e.shiftKey && e.key === "Backspace" && !draft.trim() && canQuickApprove) {
      e.preventDefault();
      setDraft("Let me revise this: ");
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
      return;
    }

    // Enter — send
    if (e.key === "Enter" && !e.shiftKey && !menuOpen) {
      e.preventDefault();
      void sendMessage();
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full min-h-0 flex flex-col text-zinc-200">
      {/* Conversation bar — thread picker left, injected controls right */}
      <div className="relative shrink-0">
        <div className="relative z-50 flex items-center gap-1 px-3 h-8" style={{ borderBottom: "1px solid var(--bender-overlay-border)" }}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="flex items-center gap-1 min-w-0 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Switch conversation"
          >
            <span className="truncate max-w-[220px]">
              {activeThread?.title ?? (loadingThreads ? "Loading…" : "Chat")}
            </span>
            <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
          </button>
          <div className="flex-1" />
          {headerActions}
        </div>
        {pickerOpen && (
          <ConversationPicker
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={(id) => setActiveThreadId(id)}
            onNew={() => { void createNewThreadRef.current(); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
            onDelete={(id) => void deleteThread(id)}
            onRename={(id, title) => void renameThread(id, title)}
            onArchiveToggle={(id, archive) => void archiveThread(id, archive)}
          />
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {loadingMessages && <LoadingDots size={18} label="Loading…" textClassName="text-xs text-zinc-500" />}
        {!loadingMessages && visibleMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[80px] gap-2 select-none">
            <p className="text-[11px] text-zinc-600 italic">
              {projectPath
                ? <>Ask anything about your project, or type <span className="font-mono text-zinc-500">/</span> for commands</>
                : <>Open a project, clone a repo, or just ask — type <span className="font-mono text-zinc-500">/</span> for commands</>}
            </p>
          </div>
        )}
        {!loadingMessages && visibleMessages.map((message) => {
          // Trigger notification rows — slim system event style, not a chat bubble.
          const meta = msgMeta(message);
          if (meta.kind === "trigger") {
            const label = typeof meta.label === "string"
              ? meta.label
              : messageToText(message);
            if (!label) return null;
            return (
              <div key={message.id} className="flex items-center gap-2 py-1 select-none">
                <div className="flex-1 h-px bg-zinc-800/60" />
                <span className="text-[10px] text-zinc-600 shrink-0">{label}</span>
                <div className="flex-1 h-px bg-zinc-800/60" />
              </div>
            );
          }

          // Operation messages — persisted /analyze, /audit, etc.
          if (isOperationMessage(message)) {
            const summary = getOperationSummary(message);
            if (!summary) return null;
            return (
              <div key={message.id} className="mr-auto w-full">
                <OperationBlock op={summary} interactiveApprovals={false} />
              </div>
            );
          }

          const text = messageToText(message);
          const toolParts = message.parts.filter(isToolUIPart) as (ToolUIPart<UITools> | DynamicToolUIPart)[];
          if (!text && toolParts.length === 0) return null;
          return (
            <div
              key={message.id}
              className={`max-w-[92%] ${
                message.role === "user"
                  ? "ml-auto text-right"
                  : "mr-auto"
              }`}
            >
              {text && (
                <pre className={`whitespace-pre-wrap text-xs leading-relaxed font-sans ${
                  message.role === "user" ? "text-zinc-500" : "text-zinc-100"
                }`}>{text}</pre>
              )}
              {toolParts.length > 0 && <ToolPartsGroup parts={toolParts} />}
            </div>
          );
        })}
        {/* Live operation block — rendered while operation is running */}
        {operation && operation.status === "running" && operation.lines.length > 0 && (() => {
          if (!operationStartTimesRef.current.has(operation.runId)) {
            operationStartTimesRef.current.set(operation.runId, Date.now());
          }
          const startedAt = operationStartTimesRef.current.get(operation.runId) ?? Date.now();
          const liveSummary: OperationSummary = {
            label: operation.label ?? labelFromUrl(operation.url),
            url: operation.url,
            status: "running",
            startedAt,
            events: operation.lines,
          };
          return (
            <div className="mr-auto w-full">
              <OperationBlock
                op={liveSummary}
                defaultExpanded
                interactiveApprovals
                onConfirm={operation.handleConfirm}
                onPromptSubmit={operation.handlePromptSubmit}
              />
            </div>
          );
        })()}
        {sending && (
          <div className="mr-auto py-2 px-1">
            <LoadingDots size={16} />
          </div>
        )}
        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-3 pt-1.5 pb-2 shrink-0 space-y-1.5" style={{ borderTop: "1px solid var(--bender-overlay-border)" }}>
        {error && <p className="text-xs text-bender-danger">{error}</p>}

        {/* Quick-approve bar — shown when last message is from assistant and draft is empty */}
        {canQuickApprove && (
          <div className="flex items-center gap-2 px-1">
            <button
              onClick={() => void sendText("Looks good. Please proceed.")}
              className="flex items-center gap-1 text-[10px] text-bender-success hover:text-bender-success/80 border border-bender-success/20 hover:border-bender-success/40 rounded px-2 py-0.5 transition-colors"
              title="Approve (⌘↩)"
            >
              <Check className="h-2.5 w-2.5" />
              Approve
              <kbd className="ml-1 text-[9px] text-bender-success/50">⌘↩</kbd>
            </button>
            <button
              onClick={() => { setDraft("Let me revise this: "); textareaRef.current?.focus(); }}
              className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400 border border-zinc-800 hover:border-zinc-600 rounded px-2 py-0.5 transition-colors"
              title="Revise (⌘⇧⌫)"
            >
              <X className="h-2.5 w-2.5" />
              Revise
              <kbd className="ml-1 text-[9px] text-zinc-700">⌘⇧⌫</kbd>
            </button>
          </div>
        )}

        <div className="relative">
          {/* Slash command menu */}
          {menuOpen && filteredCommands.length > 0 && (
            <SlashMenu
              commands={commands}
              filter={slashFilter ?? ""}
              activeIndex={menuIndex}
              onSelect={selectCommand}
              onHover={setMenuIndex}
            />
          )}

          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeThread ? (projectPath ? "Message… (/ for commands)" : "Open a project or ask for help… (/ for commands)") : "Loading…"}
            disabled={!activeThread || sending}
            rows={2}
            className="w-full resize-none rounded-lg pl-3 pr-12 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none transition-colors"
            style={{ background: "var(--bender-input-bg)", border: "1px solid var(--bender-input-border)" }}
            onFocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--bender-input-border-focus)"; }}
            onBlur={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = "var(--bender-input-border)"; }}
          />
          <button
            onClick={() => { if (sending) { stopMessage(); return; } void sendMessage(); }}
            disabled={!sending && (!activeThread || !draft.trim())}
            aria-label={sending ? "Stop response" : "Send message"}
            title={sending ? "Stop (Esc)" : "Send (Enter)"}
            className="absolute right-1.5 bottom-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors hover:bg-bender-overlay-hover"
            style={{ border: "1px solid var(--bender-input-border)" }}
          >
            {sending ? <Square className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
