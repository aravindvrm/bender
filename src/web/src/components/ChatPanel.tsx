import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DefaultChatTransport,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { Check, ChevronDown, MessageSquarePlus, Pencil, Send, Square, X } from "lucide-react";
// MessageSquarePlus used in ConversationPicker
import { LoadingDots } from "./LoadingDots";

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
}): SlashCommand[] {
  return [
    {
      name: "analyze",
      description: "Re-analyze the codebase structure and refresh architecture",
      kind: "action",
      onAction: () => opts.onRunOperation?.("/api/run/analyze"),
    },
    {
      name: "implement",
      description: "Run the current task plan",
      kind: "action",
      onAction: () => opts.onRunOperation?.("/api/run/implement"),
    },
    {
      name: "plan",
      description: "Describe a change and create a new task plan",
      kind: "prompt",
      prompt: "Create a task plan for: ",
    },
    {
      name: "brief",
      description: "Ask about the project brief and goals",
      kind: "prompt",
      prompt: "Summarize the current project brief — what are the goals, constraints, and key features?",
    },
    {
      name: "architecture",
      description: "Ask about the current architecture",
      kind: "prompt",
      prompt: "Describe the current architecture: stack, key patterns, schema, and any important decisions.",
    },
    {
      name: "tasks",
      description: "Ask about the current task list",
      kind: "prompt",
      prompt: "What tasks are currently in the plan? List them with their status.",
    },
    {
      name: "status",
      description: "Ask about recent changes and project health",
      kind: "prompt",
      prompt: "What is the current project status? Summarize recent changes, open tasks, and anything that needs attention.",
    },
    {
      name: "review",
      description: "Ask for a code review of recent changes",
      kind: "prompt",
      prompt: "Review the most recent changes in this project. Flag any issues with correctness, architecture, or code quality.",
    },
    {
      name: "help",
      description: "List all available slash commands",
      kind: "prompt",
      prompt: "List all available slash commands and what they do.",
    },
    {
      name: "new",
      description: "Start a new conversation (⌘K) — prior conversations are saved and accessible",
      kind: "action",
      onAction: opts.onNewThread,
    },
    {
      name: "clear",
      description: "Hide messages in this conversation (doesn't delete them)",
      kind: "action",
      onAction: opts.onClear,
    },
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

function keyForProject(projectPath: string): string {
  return `bender.chat.activeThread.${projectPath}`;
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
      continue;
    }
    if (isToolUIPart(part)) continue;
  }
  return chunks.join("\n\n").trim();
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

function relativeTime(ts: number): string {
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
}

function ConversationPicker({ threads, activeThreadId, onSelect, onNew, onClose }: ConversationPickerProps) {
  return (
    <>
      {/* Backdrop */}
      <div className="absolute inset-0 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="absolute top-full left-0 right-0 z-50 mt-px bg-zinc-900 border border-zinc-700/80 rounded-b-lg shadow-2xl overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center justify-between">
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
        <ul className="max-h-52 overflow-y-auto py-1">
          {threads.map((thread) => {
            const isActive = thread.id === activeThreadId;
            return (
              <li key={thread.id}>
                <button
                  onClick={() => { onSelect(thread.id); onClose(); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                    isActive ? "bg-zinc-800/60 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                  }`}
                >
                  <span className="flex-1 min-w-0 text-xs truncate">{thread.title}</span>
                  <span className="shrink-0 text-[10px] text-zinc-600">{relativeTime(thread.updatedAt)}</span>
                  {isActive && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                </button>
              </li>
            );
          })}
          {threads.length === 0 && (
            <li className="px-3 py-2 text-[11px] text-zinc-600 italic">No conversations yet</li>
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
    <div className="absolute bottom-full left-0 right-0 mb-1.5 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden z-50">
      <div className="px-3 py-1.5 border-b border-zinc-800/60">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Commands</span>
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
                className={`w-full flex items-start gap-3 px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-zinc-800" : "hover:bg-zinc-800/60"
                }`}
              >
                <span className={`font-mono text-xs shrink-0 pt-px ${isActive ? "text-zinc-100" : "text-zinc-300"}`}>
                  /{cmd.name}
                </span>
                <span className="text-[11px] text-zinc-500 leading-relaxed">{cmd.description}</span>
                {cmd.kind === "action" && (
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-700 border border-zinc-800 rounded px-1 py-px">run</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="px-3 py-1.5 border-t border-zinc-800/60 flex items-center gap-3">
        <span className="text-[10px] text-zinc-700">↑↓ navigate</span>
        <span className="text-[10px] text-zinc-700">↵ select</span>
        <span className="text-[10px] text-zinc-700">esc dismiss</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChatPanel({ projectPath, clearToken = 0, onRunOperation, trigger }: ChatPanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hiddenMessageIdsByThread, setHiddenMessageIdsByThread] = useState<Record<string, Record<string, true>>>({});

  // Slash command menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);

  // Conversation picker
  const [pickerOpen, setPickerOpen] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const userCancelledRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const clearMessages = useCallback(async () => {
    if (!activeThread || sending || messages.length === 0) return;
    setHiddenMessageIdsByThread((prev) => {
      const existing = prev[activeThread.id] ?? {};
      const nextHidden = { ...existing };
      for (const message of messages) { nextHidden[message.id] = true; }
      return { ...prev, [activeThread.id]: nextHidden };
    });
  }, [activeThread, sending, messages]);

  // createNewThread is defined after createThread in the thread management section below.
  // We use a stable ref so the commands memo and keydown handler can reference it without
  // circular dependency issues.
  const createNewThreadRef = useRef<() => Promise<void>>(async () => {});

  const commands = useMemo(
    () => buildCommands({
      onClear: () => void clearMessages(),
      onNewThread: () => void createNewThreadRef.current(),
      onRunOperation,
    }),
    [clearMessages, onRunOperation],
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
    if (!projectPath) return;
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
    if (!projectPath) { setThreads([]); setActiveThreadId(null); return null; }
    setLoadingThreads(true);
    try {
      const data = await fetchJson<{ threads: ChatThread[] }>("/api/chat/threads");
      let nextThreads = data.threads ?? [];
      if (nextThreads.length === 0) {
        const created = await createThread("Chat");
        nextThreads = [created];
      }
      setThreads(nextThreads);
      const selected = nextThreads[0]?.id ?? null;
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

  useEffect(() => { void loadThreads(); }, [loadThreads]);
  useEffect(() => {
    if (!projectPath || !activeThreadId) return;
    localStorage.setItem(keyForProject(projectPath), activeThreadId);
    void loadMessages(activeThreadId);
  }, [activeThreadId, loadMessages, projectPath]);
  useEffect(() => () => { abortControllerRef.current?.abort(); abortControllerRef.current = null; }, []);

  useEffect(() => {
    if (clearToken <= 0) return;
    void clearMessages();
  }, [clearMessages, clearToken]);

  // Auto-scroll to bottom when messages change or while streaming.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  const sendText = useCallback(async (text: string) => {
    if (!activeThread || sending) return;
    if (!text.trim()) return;

    const userMessage: UIMessage = {
      id: safeNowId(),
      role: "user",
      parts: [{ type: "text", text: text.trim() }],
      metadata: {
        provider: activeThread.provider,
        model: activeThread.model,
        toolsEnabled: true,
        createdAt: Date.now(),
      },
    };

    const outgoingMessages = [...messages.filter((m) => msgMeta(m).kind !== "trigger"), userMessage];
    setMessages(outgoingMessages);
    setDraft("");
    setSending(true);
    setError(null);
    userCancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const requestId = safeNowId();
    postClientLog("info", "chat-panel", "Chat request started", {
      requestId, threadId: activeThread.id, messageId: userMessage.id,
      messageLength: text.length, outgoingMessageCount: outgoingMessages.length,
    });

    try {
      const transport = new DefaultChatTransport<UIMessage>({
        api: `/api/chat/threads/${encodeURIComponent(activeThread.id)}/respond`,
      });
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: activeThread.id,
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
          requestId, threadId: activeThread.id, partialCount,
          outgoingMessageCount: outgoingMessages.length,
        });
        const refreshed = await fetchJson<{ messages: UIMessage[] }>(
          `/api/chat/threads/${encodeURIComponent(activeThread.id)}/messages`,
        );
        const refreshedMessages = refreshed.messages ?? [];
        const hasAssistantReply = refreshedMessages.some((m) => m.role === "assistant");
        setMessages(refreshedMessages);
        if (!hasAssistantReply) throw new Error("No assistant response was produced. Check /api/logs for details.");
      } else {
        postClientLog("info", "chat-panel", "Chat stream completed", {
          requestId, threadId: activeThread.id, partialCount, assistantPartialCount,
        });
      }

      await loadThreads();
    } catch (err) {
      if (userCancelledRef.current || isAbortLikeError(err)) {
        postClientLog("info", "chat-panel", "Chat request cancelled", { requestId, threadId: activeThread.id });
        return;
      }
      const errorText = parseErrorMessage(err);
      setError(errorText);
      postClientLog("error", "chat-panel", "Chat request failed", { requestId, threadId: activeThread.id, error: errorText });
    } finally {
      abortControllerRef.current = null;
      userCancelledRef.current = false;
      setSending(false);
    }
  }, [activeThread, loadThreads, messages, sending]);

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

  if (!projectPath) {
    return <div className="h-full p-4 text-sm text-zinc-500">No project selected.</div>;
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-zinc-950 text-zinc-200">
      {/* Conversation bar */}
      <div className="relative shrink-0">
        <div className="flex items-center gap-1 px-3 h-8 border-b border-zinc-800/50">
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
          <button
            onClick={() => void createNewThreadRef.current()}
            disabled={sending || loadingThreads}
            title="New conversation (⌘K)"
            className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-30 px-1 py-0.5 rounded"
          >
            <Pencil className="h-3 w-3" />
            <span className="hidden sm:inline">New</span>
          </button>
        </div>
        {pickerOpen && (
          <ConversationPicker
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={(id) => setActiveThreadId(id)}
            onNew={() => { void createNewThreadRef.current(); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {loadingMessages && <LoadingDots size={18} label="Loading…" textClassName="text-xs text-zinc-500" />}
        {!loadingMessages && visibleMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[80px] gap-2 select-none">
            <p className="text-[11px] text-zinc-600 italic">
              Ask anything about your project, or type <span className="font-mono text-zinc-500">/</span> for commands
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

          const text = messageToText(message);
          if (!text) return null;
          return (
            <div
              key={message.id}
              className={`max-w-[92%] ${
                message.role === "user"
                  ? "ml-auto text-right"
                  : "mr-auto"
              }`}
            >
              <pre className={`whitespace-pre-wrap text-xs leading-relaxed font-sans ${
                message.role === "user" ? "text-zinc-500" : "text-zinc-100"
              }`}>{text}</pre>
            </div>
          );
        })}
        {sending && (
          <div className="mr-auto px-3 py-2 text-zinc-400">
            <LoadingDots size={14} label="Thinking…" textClassName="text-xs text-zinc-500" />
          </div>
        )}
        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="px-3 pt-1.5 pb-2 border-t border-zinc-800 shrink-0 space-y-1.5">
        {error && <p className="text-xs text-red-400">{error}</p>}

        {/* Quick-approve bar — shown when last message is from assistant and draft is empty */}
        {canQuickApprove && (
          <div className="flex items-center gap-2 px-1">
            <button
              onClick={() => void sendText("Looks good. Please proceed.")}
              className="flex items-center gap-1 text-[10px] text-emerald-500 hover:text-emerald-400 border border-emerald-900/60 hover:border-emerald-700 rounded px-2 py-0.5 transition-colors"
              title="Approve (⌘↩)"
            >
              <Check className="h-2.5 w-2.5" />
              Approve
              <kbd className="ml-1 text-[9px] text-emerald-700">⌘↩</kbd>
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
            placeholder={activeThread ? "Message… (/ for commands)" : "Loading…"}
            disabled={!activeThread || sending}
            rows={2}
            className="w-full resize-none bg-zinc-900 border border-zinc-700 rounded-md pl-3 pr-12 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <button
            onClick={() => { if (sending) { stopMessage(); return; } void sendMessage(); }}
            disabled={!sending && (!activeThread || !draft.trim())}
            aria-label={sending ? "Stop response" : "Send message"}
            title={sending ? "Stop (Esc)" : "Send (Enter)"}
            className="absolute right-1.5 bottom-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? <Square className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
