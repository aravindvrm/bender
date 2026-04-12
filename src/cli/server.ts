import express, { type Response } from "express";
import cors from "cors";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readConfig, writeConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { GitOperations } from "../git/operations.js";
import { initCommand } from "./init.js";
import { planCommand } from "./plan.js";
import { implementCommand } from "./implement.js";
import type { UIAdapter, SpinnerAdapter } from "./adapter.js";

const API_PORT = 3142;

// ── SSE event types ──────────────────────────────────────────────────────────

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

// ── Pending answers (per active connection) ──────────────────────────────────

// Only one operation can run at a time (single-user local tool)
const pendingAnswers = new Map<string, (answer: string) => void>();

function sendSSE(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Web adapter factory ───────────────────────────────────────────────────────

function createWebAdapter(res: Response, onCancel: () => void): UIAdapter {
  function send(event: SSEEvent) {
    try {
      sendSSE(res, event);
    } catch {
      // Connection closed
    }
  }

  function waitForAnswer(id: string): Promise<string> {
    return new Promise((resolve, reject) => {
      pendingAnswers.set(id, resolve);
      // Clean up if connection is closed before answering
      res.once("close", () => {
        if (pendingAnswers.has(id)) {
          pendingAnswers.delete(id);
          reject(new Error("Connection closed"));
        }
      });
    });
  }

  return {
    header(text) {
      send({ type: "header", text });
    },
    subheader(text) {
      send({ type: "subheader", text });
    },
    info(text) {
      send({ type: "output", text, level: "info" });
    },
    success(text) {
      send({ type: "output", text, level: "success" });
    },
    error(text) {
      send({ type: "output", text, level: "error" });
    },
    warn(text) {
      send({ type: "output", text, level: "warn" });
    },
    streamWriter() {
      return (chunk: string) => send({ type: "stream", chunk });
    },
    spinner(text: string): SpinnerAdapter {
      send({ type: "spinner", text, state: "start" });
      let currentText = text;
      return {
        get text() { return currentText; },
        set text(v: string) {
          currentText = v;
          send({ type: "spinner", text: v, state: "start" });
        },
        start() { send({ type: "spinner", text: currentText, state: "start" }); },
        stop() { send({ type: "spinner", text: currentText, state: "stop" }); },
        succeed(t) { send({ type: "spinner", text: t ?? currentText, state: "succeed" }); },
        fail(t) { send({ type: "spinner", text: t ?? currentText, state: "fail" }); },
      };
    },
    async confirm(question, defaultYes = true): Promise<boolean> {
      const id = randomUUID();
      send({ type: "confirm", id, question, default: defaultYes });
      const answer = await waitForAnswer(id);
      return answer === "true";
    },
    async promptMultiline(question): Promise<string> {
      const id = randomUUID();
      send({ type: "prompt", id, question });
      return waitForAnswer(id);
    },
    showFileOperations(ops) {
      send({ type: "files", ops });
    },
    cleanup() {
      // No-op for web adapter — connection managed by SSE lifecycle
    },
  };
}

// ── Run an operation as SSE ───────────────────────────────────────────────────

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

  let cancelled = false;
  const adapter = createWebAdapter(res, () => { cancelled = true; });

  try {
    await operation(adapter);
    if (!cancelled) sendSSE(res, { type: "done", success: true });
  } catch (err) {
    if (!cancelled) sendSSE(res, { type: "error", message: (err as Error).message });
  } finally {
    res.end();
    // Clean up any dangling pending answers
    for (const [id] of pendingAnswers) {
      pendingAnswers.delete(id);
    }
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function startServer(projectRoot: string): Promise<void> {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve built web UI static files
  const webDistDir = join(import.meta.dirname, "..", "web");
  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
  }

  // ── Project state ─────────────────────────────────────────────────────────

  app.get("/api/state", async (_req, res) => {
    try {
      const state = new StateManager(projectRoot);

      if (!state.isInitialized()) {
        res.json({ initialized: false });
        return;
      }

      const config = await readConfig(projectRoot);
      const context = await state.gatherContext();
      const decisions = await state.readDecisions();
      const completedTasks = await state.readCompletedTasks();

      let git = null;
      try {
        const gitOps = new GitOperations(projectRoot);
        if (await gitOps.isRepo()) {
          const branch = await gitOps.getCurrentBranch();
          const clean = !(await gitOps.hasChanges());
          const recentCommits = await gitOps.log(5);
          git = { branch, clean, recentCommits };
        }
      } catch {
        // Not a git repo
      }

      res.json({
        initialized: true,
        projectRoot,
        brief: context.brief,
        architecture: context.architecture,
        conventions: context.conventions,
        schema: context.schema,
        decisions,
        currentTasks: context.currentTasks,
        completedTasks,
        apiContracts: context.apiContracts,
        config: {
          llm: { provider: config.llm.provider, models: config.llm.models },
          stack: config.stack,
        },
        git,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Config ────────────────────────────────────────────────────────────────

  app.get("/api/config", async (_req, res) => {
    try {
      const config = await readConfig(projectRoot);
      // Mask API keys
      const masked = {
        ...config,
        llm: { ...config.llm, apiKey: config.llm.apiKey ? "••••••••" : undefined },
        providers: config.providers
          ? Object.fromEntries(
              Object.entries(config.providers).map(([name, p]) => [
                name,
                { apiKey: p.apiKey ? "••••••••" : "" },
              ]),
            )
          : {},
      };
      res.json(masked);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/config", async (req, res) => {
    try {
      const current = await readConfig(projectRoot);
      const updates = req.body as Partial<typeof current>;
      const MASK = "••••••••";

      // Merge providers: preserve existing keys unless a new (non-masked) value is sent
      const mergedProviders: { [k: string]: { apiKey?: string } } = { ...current.providers };
      if (updates.providers) {
        for (const [name, p] of Object.entries(updates.providers)) {
          if (p.apiKey && p.apiKey !== MASK) {
            mergedProviders[name] = { apiKey: p.apiKey };
          } else if (!p.apiKey) {
            // Explicit blank = remove key
            mergedProviders[name] = { apiKey: undefined };
          }
          // Otherwise keep existing
        }
      }

      const merged = {
        ...current,
        ...updates,
        llm: {
          ...current.llm,
          ...updates.llm,
          apiKey: updates.llm?.apiKey && updates.llm.apiKey !== MASK
            ? updates.llm.apiKey
            : current.llm.apiKey,
          models: { ...current.llm.models, ...updates.llm?.models },
        },
        providers: mergedProviders,
        stack: { ...current.stack, ...updates.stack },
        deploy: { ...current.deploy, ...updates.deploy },
        test: { ...current.test, ...updates.test },
      };
      await writeConfig(projectRoot, merged);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Git diff ──────────────────────────────────────────────────────────────

  app.get("/api/git/diff", async (req, res) => {
    try {
      const gitOps = new GitOperations(projectRoot);
      if (!(await gitOps.isRepo())) {
        res.json({ diff: null });
        return;
      }
      const commits = parseInt((req.query.commits as string) ?? "1", 10);
      const range = commits > 0 ? `HEAD~${commits}..HEAD` : "HEAD~1..HEAD";
      const diff = await gitOps.getDiffRange(range);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Sessions ──────────────────────────────────────────────────────────────

  app.get("/api/sessions", async (_req, res) => {
    try {
      const state = new StateManager(projectRoot);
      if (!state.isInitialized()) {
        res.json([]);
        return;
      }
      const sessions = await state.readSessions();
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Run operations (SSE) ──────────────────────────────────────────────────

  // Answer a pending confirm/prompt
  app.post("/api/run/answer", (req, res) => {
    const { id, answer } = req.body as { id: string; answer: string };
    const resolver = pendingAnswers.get(id);
    if (resolver) {
      pendingAnswers.delete(id);
      resolver(answer);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: "No pending question with that id" });
    }
  });

  // Init: POST { description: string }
  app.post("/api/run/init", async (req, res) => {
    const { description } = req.body as { description?: string };
    await runOperation(res, async (adapter) => {
      // Pre-fill the description so promptMultiline isn't needed
      const originalPrompt = adapter.promptMultiline.bind(adapter);
      let firstPrompt = true;
      adapter.promptMultiline = async (question: string) => {
        if (firstPrompt && description) {
          firstPrompt = false;
          adapter.info(`> ${description}`);
          return description;
        }
        return originalPrompt(question);
      };
      await initCommand(projectRoot, adapter);
    });
  });

  // Plan: POST { feature: string }
  app.post("/api/run/plan", async (req, res) => {
    const { feature } = req.body as { feature?: string };
    if (!feature) {
      res.status(400).json({ error: "feature is required" });
      return;
    }
    await runOperation(res, (adapter) => planCommand(projectRoot, feature, adapter));
  });

  // Implement: POST {}
  app.post("/api/run/implement", async (_req, res) => {
    await runOperation(res, (adapter) => implementCommand(projectRoot, adapter));
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────

  app.get("/{*path}", (_req, res) => {
    const indexPath = join(webDistDir, "index.html");
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send("Web UI not built. Run: npm run build:web");
    }
  });

  app.listen(API_PORT, () => {
    // Logged by the CLI command
  });
}
