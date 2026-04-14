import { useState, useRef, useCallback } from "react";

// ── SSE event types ───────────────────────────────────────────────────────────

type SSEEvent =
  | { type: "header"; text: string }
  | { type: "subheader"; text: string }
  | { type: "output"; text: string; level: "info" | "success" | "warn" | "error" }
  | { type: "stream"; chunk: string }
  | { type: "spinner"; text: string; state: "start" | "succeed" | "fail" | "stop" }
  | { type: "files"; ops: { path: string; action: string }[] }
  | { type: "confirm"; id: string; question: string; default: boolean }
  | { type: "prompt"; id: string; question: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };

// ── Output line types ─────────────────────────────────────────────────────────

export type OutputLine =
  | { kind: "header"; text: string }
  | { kind: "subheader"; text: string }
  | { kind: "output"; text: string; level: "info" | "success" | "warn" | "error" }
  | { kind: "stream"; text: string }
  | { kind: "spinner"; text: string; done: boolean; success?: boolean }
  | { kind: "files"; ops: { path: string; action: string }[] }
  | { kind: "confirm"; id: string; question: string; default: boolean; answered?: boolean; answer?: boolean }
  | { kind: "prompt"; id: string; question: string; answered?: boolean; answer?: string }
  | { kind: "done"; success: boolean }
  | { kind: "error"; message: string };

export type OperationStatus = "idle" | "running" | "done" | "error";
export type OperationModal = { kind: "init" } | { kind: "plan" } | null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSSEChunk(chunk: string, onEvent: (e: SSEEvent) => void, bufferRef: { current: string }) {
  const combined = bufferRef.current + chunk;
  const lines = combined.split("\n");
  bufferRef.current = lines.pop() ?? "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ }
    }
  }
}

async function streamOperation(
  url: string,
  body: Record<string, unknown>,
  onEvent: (e: SSEEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.text();
    onEvent({ type: "error", message: err || "Request failed" });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const bufferRef = { current: "" };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parseSSEChunk(decoder.decode(value, { stream: true }), onEvent, bufferRef);
  }

  // Flush any final buffered line after stream closes.
  if (bufferRef.current.trim().length > 0) {
    parseSSEChunk("\n", onEvent, bufferRef);
  }
}

async function sendAnswer(id: string, answer: string) {
  await fetch("/api/run/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, answer }),
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useOperation(onStateChange?: () => void) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState<OperationStatus>("idle");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [modal, setModal] = useState<OperationModal>(null);
  const [inputText, setInputText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const addLine = useCallback((line: OutputLine) => {
    setLines((prev) => [...prev, line]);
  }, []);

  const updateLastSpinner = useCallback((text: string, done: boolean, success?: boolean) => {
    setLines((prev) => {
      const idx = [...prev].reverse().findIndex((l) => l.kind === "spinner" && !l.done);
      if (idx === -1) return [...prev, { kind: "spinner", text, done, success }];
      const realIdx = prev.length - 1 - idx;
      const next = [...prev];
      next[realIdx] = { kind: "spinner", text, done, success };
      return next;
    });
  }, []);

  const appendStream = useCallback((chunk: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "stream") {
        return [...prev.slice(0, -1), { kind: "stream", text: last.text + chunk }];
      }
      return [...prev, { kind: "stream", text: chunk }];
    });
  }, []);

  const handleEvent = useCallback(
    (event: SSEEvent) => {
      switch (event.type) {
        case "header":
          addLine({ kind: "header", text: event.text });
          break;
        case "subheader":
          addLine({ kind: "subheader", text: event.text });
          break;
        case "output":
          addLine({ kind: "output", text: event.text, level: event.level });
          break;
        case "stream":
          appendStream(event.chunk);
          break;
        case "spinner":
          if (event.state === "start") {
            setLines((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "spinner" && !last.done) {
                return [...prev.slice(0, -1), { kind: "spinner", text: event.text, done: false }];
              }
              return [...prev, { kind: "spinner", text: event.text, done: false }];
            });
          } else {
            updateLastSpinner(event.text, true, event.state === "succeed");
          }
          break;
        case "files":
          addLine({ kind: "files", ops: event.ops });
          break;
        case "confirm":
          addLine({ kind: "confirm", id: event.id, question: event.question, default: event.default });
          break;
        case "prompt":
          addLine({ kind: "prompt", id: event.id, question: event.question });
          break;
        case "done":
          addLine({ kind: "done", success: event.success });
          setStatus("done");
          onStateChange?.();
          break;
        case "error":
          addLine({ kind: "error", message: event.message });
          setStatus("error");
          break;
      }
    },
    [addLine, appendStream, updateLastSpinner, onStateChange],
  );

  const startOperation = useCallback(async (
    url: string,
    body: Record<string, unknown>,
    options?: { onSuccess?: () => void; onFinish?: (success: boolean) => void },
  ) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLines([]);
    setStatus("running");
    setDrawerOpen(true);
    let succeeded = false;
    const wrappedHandleEvent = (event: SSEEvent) => {
      if (event.type === "done" && event.success) succeeded = true;
      handleEvent(event);
    };
    try {
      await streamOperation(url, body, wrappedHandleEvent, ctrl.signal);
      if (succeeded) options?.onSuccess?.();
      options?.onFinish?.(succeeded);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        addLine({ kind: "error", message: (err as Error).message });
        setStatus("error");
        options?.onFinish?.(false);
      }
    }
  }, [handleEvent, addLine]);

  const handleConfirm = useCallback(async (id: string, lineIdx: number, answer: boolean) => {
    setLines((prev) => {
      const next = [...prev];
      const line = next[lineIdx];
      if (line.kind === "confirm") next[lineIdx] = { ...line, answered: true, answer };
      return next;
    });
    await sendAnswer(id, String(answer));
  }, []);

  const handlePromptSubmit = useCallback(async (id: string, lineIdx: number, text: string) => {
    setLines((prev) => {
      const next = [...prev];
      const line = next[lineIdx];
      if (line.kind === "prompt") next[lineIdx] = { ...line, answered: true, answer: text };
      return next;
    });
    await sendAnswer(id, text);
  }, []);

  const clearOutput = useCallback(() => {
    setLines([]);
    setStatus("idle");
    setDrawerOpen(true);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
  }, []);

  return {
    lines,
    status,
    drawerOpen,
    setDrawerOpen,
    modal,
    setModal,
    inputText,
    setInputText,
    startOperation,
    handleConfirm,
    handlePromptSubmit,
    clearOutput,
    abort,
  };
}
