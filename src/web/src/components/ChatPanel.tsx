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
    body: JSON.stringify({
      level,
      component,
      message,
      ...(data ? { data } : {}),
    }),
  }).catch(() => {
    // Best-effort diagnostics only.
  });
}

function summarizeValue(value: unknown, maxChars = 320): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

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
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

interface ChatPanelProps {
  projectPath: string | null;
  clearToken?: number;
}

export function ChatPanel({ projectPath, clearToken = 0 }: ChatPanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hiddenMessageIdsByThread, setHiddenMessageIdsByThread] = useState<Record<string, Record<string, true>>>({});
  const abortControllerRef = useRef<AbortController | null>(null);
  const userCancelledRef = useRef(false);

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

  const createThread = useCallback(async (title?: string): Promise<ChatThread> => {
    const data = await fetchJson<{ thread: ChatThread }>("/api/chat/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title?.trim() ? { title: title.trim() } : {}),
    });
    return data.thread;
  }, []);

  const loadThreads = useCallback(async (): Promise<string | null> => {
    if (!projectPath) {
      setThreads([]);
      setActiveThreadId(null);
      return null;
    }
    setLoadingThreads(true);
    try {
      const data = await fetchJson<{ threads: ChatThread[] }>("/api/chat/threads");
      let nextThreads = data.threads ?? [];
      if (nextThreads.length === 0) {
        const created = await createThread("Chat");
        nextThreads = [created];
      }
      setThreads(nextThreads);
      const fallback = nextThreads[0]?.id ?? null;
      const selected = fallback;
      setActiveThreadId(selected);
      if (selected) {
        localStorage.setItem(keyForProject(projectPath), selected);
      }
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

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!projectPath || !activeThreadId) return;
    localStorage.setItem(keyForProject(projectPath), activeThreadId);
    void loadMessages(activeThreadId);
  }, [activeThreadId, loadMessages, projectPath]);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

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
      requestId,
      threadId: activeThread.id,
      messageId: userMessage.id,
      messageLength: text.length,
      outgoingMessageCount: outgoingMessages.length,
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
          if (existingIdx === -1) {
            return [...prev, partial];
          }
          const next = [...prev];
          next[existingIdx] = partial;
          return next;
        });
      }

      if (assistantPartialCount === 0) {
        postClientLog("warn", "chat-panel", "Chat stream ended without assistant output", {
          requestId,
          threadId: activeThread.id,
          partialCount,
          outgoingMessageCount: outgoingMessages.length,
        });
        const refreshed = await fetchJson<{ messages: UIMessage[] }>(
          `/api/chat/threads/${encodeURIComponent(activeThread.id)}/messages`,
        );
        const refreshedMessages = refreshed.messages ?? [];
        const hasAssistantReply = refreshedMessages.some((message) => message.role === "assistant");
        setMessages(refreshedMessages);
        if (!hasAssistantReply) {
          throw new Error("No assistant response was produced. Check /api/logs for details.");
        }
      } else {
        postClientLog("info", "chat-panel", "Chat stream completed", {
          requestId,
          threadId: activeThread.id,
          partialCount,
          assistantPartialCount,
        });
      }

      await loadThreads();
    } catch (err) {
      if (userCancelledRef.current || isAbortLikeError(err)) {
        postClientLog("info", "chat-panel", "Chat request cancelled", {
          requestId,
          threadId: activeThread.id,
        });
        return;
      }
      const errorText = parseErrorMessage(err);
      setError(errorText);
      postClientLog("error", "chat-panel", "Chat request failed", {
        requestId,
        threadId: activeThread.id,
        error: errorText,
      });
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

  const clearMessages = useCallback(async () => {
    if (!activeThread || sending || messages.length === 0) return;
    setHiddenMessageIdsByThread((prev) => {
      const existing = prev[activeThread.id] ?? {};
      const nextHidden = { ...existing };
      for (const message of messages) {
        nextHidden[message.id] = true;
      }
      return {
        ...prev,
        [activeThread.id]: nextHidden,
      };
    });
  }, [activeThread, sending, messages]);

  useEffect(() => {
    if (clearToken <= 0) return;
    void clearMessages();
  }, [clearMessages, clearToken]);

  if (!projectPath) {
    return (
      <div className="h-full p-4 text-sm text-zinc-500">
        No project selected.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-zinc-950 text-zinc-200">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {loadingMessages && <LoadingDots size={18} label="Loading chat…" textClassName="text-xs text-zinc-500" />}
        {!loadingMessages && visibleMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full min-h-[80px] gap-2 select-none">
            <p className="text-[11px] text-zinc-600 italic">Ask anything about your project…</p>
          </div>
        )}
        {!loadingMessages && visibleMessages.map((message) => {
          const text = messageToText(message);
          if (!text) return null;
          return (
            <div
              key={message.id}
              className={`max-w-[90%] px-3 py-2 ${
                message.role === "user"
                  ? "ml-auto rounded-lg border bg-zinc-800 border-zinc-700 text-zinc-100"
                  : "mr-auto text-zinc-200"
              }`}
            >
              <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono">{text}</pre>
            </div>
          );
        })}
        {sending && (
          <div className="mr-auto px-3 py-2 text-zinc-400">
            <LoadingDots size={14} label="Thinking…" textClassName="text-xs text-zinc-500" />
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-zinc-800 shrink-0">
        {error && (
          <p className="text-xs text-red-400 mb-2">{error}</p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={activeThread ? "Ask Bender…" : "Create a chat thread first"}
            disabled={!activeThread || sending}
            rows={2}
            className="flex-1 resize-none bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <button
            onClick={() => {
              if (sending) {
                stopMessage();
                return;
              }
              void sendMessage();
            }}
            disabled={!sending && (!activeThread || !draft.trim())}
            aria-label={sending ? "Stop response" : "Send message"}
            title={sending ? "Stop" : "Send"}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? <Square className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
