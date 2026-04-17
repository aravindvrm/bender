import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DefaultChatTransport,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { Plus, RefreshCw, Send } from "lucide-react";
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
    if (isToolUIPart(part)) {
      const record = part as unknown as Record<string, unknown>;
      const toolName = typeof record.toolName === "string"
        ? record.toolName
        : String(record.type ?? "tool");
      const output = summarizeValue(record.output);
      const errorText = typeof record.errorText === "string" ? record.errorText.trim() : "";
      const state = typeof record.state === "string" ? record.state : "";
      if (errorText) {
        chunks.push(`[Tool ${toolName}] error: ${errorText}`);
      } else if (output) {
        chunks.push(`[Tool ${toolName}] ${output}`);
      } else if (state) {
        chunks.push(`[Tool ${toolName}] ${state}`);
      } else {
        chunks.push(`[Tool ${toolName}]`);
      }
      continue;
    }
  }
  return chunks.join("\n\n").trim() || "(no text output)";
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
}

export function ChatPanel({ projectPath }: ChatPanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [showCreateThread, setShowCreateThread] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  useEffect(() => {
    if (!activeThread) {
      setRenameTitle("");
      return;
    }
    setRenameTitle(activeThread.title);
  }, [activeThread?.id, activeThread?.title]);

  const loadThreads = useCallback(async (): Promise<string | null> => {
    if (!projectPath) {
      setThreads([]);
      setActiveThreadId(null);
      return null;
    }
    setLoadingThreads(true);
    try {
      const data = await fetchJson<{ threads: ChatThread[] }>("/api/chat/threads");
      const nextThreads = data.threads ?? [];
      setThreads(nextThreads);
      if (nextThreads.length === 0) {
        setActiveThreadId(null);
        setMessages([]);
        return null;
      }
      const stored = localStorage.getItem(keyForProject(projectPath));
      const fallback = nextThreads[0]?.id ?? null;
      const selected = stored && nextThreads.some((thread) => thread.id === stored)
        ? stored
        : fallback;
      setActiveThreadId(selected);
      return selected;
    } catch (err) {
      setError(parseErrorMessage(err));
      return null;
    } finally {
      setLoadingThreads(false);
    }
  }, [projectPath]);

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

  const createThread = useCallback(async (title?: string) => {
    if (!projectPath) return;
    try {
      const data = await fetchJson<{ thread: ChatThread }>("/api/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(title?.trim() ? { title: title.trim() } : {}),
      });
      setThreads((prev) => [data.thread, ...prev]);
      setActiveThreadId(data.thread.id);
      setMessages([]);
      setDraft("");
      setNewThreadTitle("");
      setShowCreateThread(false);
      setError(null);
    } catch (err) {
      setError(parseErrorMessage(err));
    }
  }, [projectPath]);

  const patchActiveThread = useCallback(async (
    updates: Partial<Pick<ChatThread, "toolsEnabled" | "title" | "archived">>,
  ) => {
    if (!activeThread) return;
    try {
      const data = await fetchJson<{ thread: ChatThread }>(
        `/api/chat/threads/${encodeURIComponent(activeThread.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
      );
      setThreads((prev) => prev.map((thread) => (
        thread.id === activeThread.id ? data.thread : thread
      )));
      setError(null);
    } catch (err) {
      setError(parseErrorMessage(err));
    }
  }, [activeThread]);

  const saveRename = useCallback(async () => {
    if (!activeThread) return;
    const next = renameTitle.trim();
    if (!next || next === activeThread.title) return;
    setSavingRename(true);
    try {
      await patchActiveThread({ title: next });
    } finally {
      setSavingRename(false);
    }
  }, [activeThread, patchActiveThread, renameTitle]);

  const archiveActiveThread = useCallback(async () => {
    if (!activeThread) return;
    await patchActiveThread({ archived: true });
    const nextThreadId = await loadThreads();
    if (nextThreadId) {
      await loadMessages(nextThreadId);
    } else {
      setMessages([]);
    }
  }, [activeThread, loadMessages, loadThreads, patchActiveThread]);

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
        toolsEnabled: activeThread.toolsEnabled,
        createdAt: Date.now(),
      },
    };

    const outgoingMessages = [...messages, userMessage];
    setMessages(outgoingMessages);
    setDraft("");
    setSending(true);
    setError(null);
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
        abortSignal: undefined,
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
      const errorText = parseErrorMessage(err);
      setError(errorText);
      postClientLog("error", "chat-panel", "Chat request failed", {
        requestId,
        threadId: activeThread.id,
        error: errorText,
      });
    } finally {
      setSending(false);
    }
  }, [activeThread, draft, loadThreads, messages, sending]);

  if (!projectPath) {
    return (
      <div className="h-full p-4 text-sm text-zinc-500">
        No project selected.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950 text-zinc-200">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
        <button
          onClick={() => setShowCreateThread((prev) => !prev)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <Plus className="h-3 w-3" />
          New Chat
        </button>
        <select
          value={activeThreadId ?? ""}
          onChange={(e) => setActiveThreadId(e.target.value || null)}
          className="min-w-[180px] max-w-[320px] bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
        >
          {!activeThreadId && <option value="">Select thread</option>}
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>{thread.title}</option>
          ))}
        </select>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          Agent: Bender Operator
        </span>
        <div className="flex-1" />
        <button
          onClick={() => {
            void (async () => {
              const selected = await loadThreads();
              if (selected) {
                await loadMessages(selected);
              }
            })();
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
        >
          <RefreshCw className={`h-3 w-3 ${loadingThreads ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {showCreateThread && (
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
          <input
            value={newThreadTitle}
            onChange={(e) => setNewThreadTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void createThread(newThreadTitle);
              }
            }}
            placeholder="Thread name"
            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
          />
          <button
            onClick={() => void createThread(newThreadTitle)}
            className="px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs"
          >
            Create
          </button>
          <button
            onClick={() => {
              setShowCreateThread(false);
              setNewThreadTitle("");
            }}
            className="px-2 py-1 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-300 text-xs"
          >
            Cancel
          </button>
        </div>
      )}

      {activeThread && (
        <div className="px-3 py-2 border-b border-zinc-800 grid grid-cols-1 lg:grid-cols-3 gap-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-400">
            <span className="text-zinc-500">Model</span>
            <span className="font-mono">Strong tier (Settings)</span>
          </div>

          <div className="flex items-center gap-2 text-zinc-400">
            <span className="text-zinc-500">Current</span>
            <span className="font-mono">{activeThread.provider}:{activeThread.model}</span>
          </div>

          <label className="inline-flex items-center gap-2 text-zinc-400">
            <input
              type="checkbox"
              checked={activeThread.toolsEnabled}
              onChange={(e) => {
                void patchActiveThread({ toolsEnabled: e.target.checked });
              }}
            />
            Tools enabled
          </label>

          <div className="lg:col-span-3 flex items-center gap-2">
            <span className="text-zinc-500">Thread</span>
            <input
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveRename();
                }
              }}
              className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs"
            />
            <button
              onClick={() => void saveRename()}
              disabled={savingRename || !renameTitle.trim() || renameTitle.trim() === activeThread.title}
              className="px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => void archiveActiveThread()}
              className="px-2 py-1 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-300 text-xs"
            >
              Archive
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loadingMessages && <LoadingDots size={18} label="Loading chat…" textClassName="text-xs text-zinc-500" />}
        {!loadingMessages && messages.length === 0 && (
          <p className="text-xs text-zinc-500 italic">No messages yet.</p>
        )}
        {!loadingMessages && messages.map((message) => (
          <div
            key={message.id}
            className={`max-w-[90%] rounded-lg px-3 py-2 border ${
              message.role === "user"
                ? "ml-auto bg-zinc-800 border-zinc-700 text-zinc-100"
                : "mr-auto bg-zinc-900 border-zinc-800 text-zinc-200"
            }`}
          >
            <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{message.role}</p>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono">{messageToText(message)}</pre>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-zinc-800">
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
            onClick={() => void sendMessage()}
            disabled={!activeThread || sending || !draft.trim()}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="h-3 w-3" />
            Send
          </button>
        </div>
        <p className="mt-2 text-[10px] text-zinc-500">
          Deterministic commands: <code>/task list</code>, <code>/task add title: ...</code>, <code>/task update 3 title: ...</code>, <code>/task run 3</code>, <code>/audit security</code>, <code>/analyze</code>
        </p>
      </div>
    </div>
  );
}
