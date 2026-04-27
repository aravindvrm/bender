import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DefaultChatTransport,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { Send, Square } from "lucide-react";
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
      name: "clear",
      description: "Clear this conversation",
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
// Props
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  projectPath: string | null;
  clearToken?: number;
  /** Called when a slash command triggers a backend operation */
  onRunOperation?: (url: string, body?: Record<string, unknown>) => void;
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

export function ChatPanel({ projectPath, clearToken = 0, onRunOperation }: ChatPanelProps) {
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

  const abortControllerRef = useRef<AbortController | null>(null);
  const userCancelledRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const commands = useMemo(
    () => buildCommands({ onClear: () => void clearMessages(), onRunOperation }),
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

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(async () => {
    if (!activeThread || sending) return;
    const text = draft.trim();
    if (!text) return;

    const userMessage: UIMessage = {
      id: safeNowId(),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        provider: activeThread.provider,
        model: activeThread.model,
        toolsEnabled: true,
        createdAt: Date.now(),
      },
    };

    const outgoingMessages = [...messages, userMessage];
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
  }, [activeThread, draft, loadThreads, messages, sending]);

  const stopMessage = useCallback(() => {
    userCancelledRef.current = true;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setSending(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard handler for textarea
  // ---------------------------------------------------------------------------

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = filteredCommands[menuIndex];
        if (cmd) selectCommand(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
    }

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
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {loadingMessages && <LoadingDots size={18} label="Loading chat…" textClassName="text-xs text-zinc-500" />}
        {!loadingMessages && visibleMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[80px] gap-2 select-none">
            <p className="text-[11px] text-zinc-600 italic">Type <span className="font-mono text-zinc-500">/</span> for commands or ask anything about your project…</p>
          </div>
        )}
        {!loadingMessages && visibleMessages.map((message) => {
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
      </div>

      {/* Input area */}
      <div className="px-3 py-2 border-t border-zinc-800 shrink-0">
        {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
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
            placeholder={activeThread ? "Type / for commands…" : "Loading…"}
            disabled={!activeThread || sending}
            rows={2}
            className="w-full resize-none bg-zinc-900 border border-zinc-700 rounded-md pl-3 pr-12 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <button
            onClick={() => { if (sending) { stopMessage(); return; } void sendMessage(); }}
            disabled={!sending && (!activeThread || !draft.trim())}
            aria-label={sending ? "Stop response" : "Send message"}
            title={sending ? "Stop" : "Send"}
            className="absolute right-1.5 bottom-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? <Square className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
