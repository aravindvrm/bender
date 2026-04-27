import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { SpinnerAdapter, UIAdapter } from "../adapter.js";
import { createLogger, logError } from "../../logger.js";
import { RunHistoryStore, wrapAdapterWithHistory, labelFromRoutePath } from "./run-history.js";

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

export function createSseOperationRunner(deps?: {
  getCurrentProject?: () => string | null;
  /** Raw project root (not wrapped with resolveExistingProjectLogRoot) — used for run-history writes. */
  getProjectRoot?: () => string | null;
}) {
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
    const startedAt = Date.now();
    const logger = createLogger("api:sse", deps?.getCurrentProject?.() ?? null);
    const requestPath = res.req?.path ?? "(unknown)";
    logger.info("SSE operation started", {
      method: res.req?.method ?? "POST",
      path: requestPath,
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // ------------------------------------------------------------------
    // Set up run-history recording (best-effort — never blocks operation)
    // ------------------------------------------------------------------
    const projectRoot = deps?.getProjectRoot?.() ?? null;
    let runHandle = null as Awaited<ReturnType<RunHistoryStore["startRun"]>> | null;
    if (projectRoot) {
      try {
        const { operationType, label } = labelFromRoutePath(requestPath);
        const store = new RunHistoryStore(projectRoot);
        await store.init();
        runHandle = await store.startRun(operationType, label);
      } catch {
        // History init failure must never abort an operation.
      }
    }

    const baseAdapter = createWebAdapter(res);
    const adapter = runHandle ? wrapAdapterWithHistory(baseAdapter, runHandle) : baseAdapter;

    let succeeded = false;
    try {
      await operation(adapter);
      succeeded = true;
      logger.info("SSE operation completed", {
        method: res.req?.method ?? "POST",
        path: requestPath,
        elapsedMs: Date.now() - startedAt,
      });
      sendSSE(res, { type: "done", success: true });
    } catch (err) {
      logError(logger, "SSE operation failed", err, {
        method: res.req?.method ?? "POST",
        path: requestPath,
        elapsedMs: Date.now() - startedAt,
      });
      sendSSE(res, { type: "error", message: (err as Error).message });
      sendSSE(res, { type: "done", success: false });
    } finally {
      res.end();
      for (const [id] of pendingAnswers) pendingAnswers.delete(id);
      if (runHandle) {
        runHandle.finish(succeeded ? "done" : "error").catch(() => {/* best effort */});
      }
    }
  }

  return {
    runOperation,
    resolvePendingAnswer,
  };
}
