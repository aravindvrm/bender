import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { SpinnerAdapter, UIAdapter } from "../adapter.js";

export type SSEEvent =
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

function sendSSE(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createSseOperationRunner() {
  const pendingAnswers = new Map<string, (answer: string) => void>();

  function resolvePendingAnswer(id: string, answer: string): boolean {
    const resolver = pendingAnswers.get(id);
    if (!resolver) return false;
    pendingAnswers.delete(id);
    resolver(answer);
    return true;
  }

  function createWebAdapter(res: Response): UIAdapter {
    function send(event: SSEEvent) {
      try { sendSSE(res, event); } catch { /* connection closed */ }
    }

    function waitForAnswer(id: string): Promise<string> {
      return new Promise((resolve, reject) => {
        pendingAnswers.set(id, resolve);
        res.once("close", () => {
          if (pendingAnswers.has(id)) {
            pendingAnswers.delete(id);
            reject(new Error("Connection closed"));
          }
        });
      });
    }

    return {
      header(text) { send({ type: "header", text }); },
      subheader(text) { send({ type: "subheader", text }); },
      info(text) { send({ type: "output", text, level: "info" }); },
      success(text) { send({ type: "output", text, level: "success" }); },
      error(text) { send({ type: "output", text, level: "error" }); },
      warn(text) { send({ type: "output", text, level: "warn" }); },
      streamWriter() {
        return (chunk: string) => send({ type: "stream", chunk });
      },
      spinner(text: string): SpinnerAdapter {
        send({ type: "spinner", text, state: "start" });
        let currentText = text;
        return {
          get text() { return currentText; },
          set text(v: string) { currentText = v; send({ type: "spinner", text: v, state: "start" }); },
          start() { send({ type: "spinner", text: currentText, state: "start" }); },
          stop() { send({ type: "spinner", text: currentText, state: "stop" }); },
          succeed(t) { send({ type: "spinner", text: t ?? currentText, state: "succeed" }); },
          fail(t) { send({ type: "spinner", text: t ?? currentText, state: "fail" }); },
        };
      },
      async confirm(question, defaultYes = true): Promise<boolean> {
        const id = randomUUID();
        send({ type: "confirm", id, question, default: defaultYes });
        return (await waitForAnswer(id)) === "true";
      },
      async promptMultiline(question): Promise<string> {
        const id = randomUUID();
        send({ type: "prompt", id, question });
        return waitForAnswer(id);
      },
      showFileOperations(ops) { send({ type: "files", ops }); },
      cleanup() { /* no-op */ },
    };
  }

  async function runOperation(
    res: Response,
    operation: (adapter: UIAdapter) => Promise<void>,
  ): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const adapter = createWebAdapter(res);
    try {
      await operation(adapter);
      sendSSE(res, { type: "done", success: true });
    } catch (err) {
      sendSSE(res, { type: "error", message: (err as Error).message });
      sendSSE(res, { type: "done", success: false });
    } finally {
      res.end();
      for (const [id] of pendingAnswers) pendingAnswers.delete(id);
    }
  }

  return {
    runOperation,
    resolvePendingAnswer,
  };
}

