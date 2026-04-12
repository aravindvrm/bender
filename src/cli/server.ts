import express, { type Response } from "express";
import cors from "cors";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readConfig, writeConfig } from "../state/config.js";
import { createModelSet } from "../llm/provider.js";
import { StateManager } from "../state/manager.js";
import { GitOperations } from "../git/operations.js";
import { readRegistry, addToRegistry, removeFromRegistry } from "../state/registry.js";
import { initCommand } from "./init.js";
import { planCommand } from "./plan.js";
import { implementCommand } from "./implement.js";
import { analyzeCommand } from "./analyze.js";
import { generateFlows } from "../roles/flowcharter.js";
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

// ── Mutable server state ─────────────────────────────────────────────────────

let currentProject: string | null = null;

function getProject(): string {
  if (!currentProject) throw new Error("No project selected. Open a project first.");
  return currentProject;
}

// ── Pending answers ──────────────────────────────────────────────────────────

const pendingAnswers = new Map<string, (answer: string) => void>();

function sendSSE(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Web adapter factory ───────────────────────────────────────────────────────

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

// ── SSE operation runner ──────────────────────────────────────────────────────

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
  } finally {
    res.end();
    for (const [id] of pendingAnswers) pendingAnswers.delete(id);
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function startServer(initialProject?: string): Promise<void> {
  if (initialProject) {
    currentProject = initialProject;
    await addToRegistry(initialProject);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  const webDistDir = join(import.meta.dirname, "..", "web");
  if (existsSync(webDistDir)) app.use(express.static(webDistDir));

  // ── Project management ────────────────────────────────────────────────────

  // Current project info
  app.get("/api/project", (_req, res) => {
    res.json({ path: currentProject });
  });

  // Recent projects list
  app.get("/api/projects", async (_req, res) => {
    try {
      const projects = await readRegistry();
      res.json(projects);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Select (switch to) an existing project
  app.post("/api/project/select", async (req, res) => {
    const { path } = req.body as { path: string };
    if (!path) { res.status(400).json({ error: "path required" }); return; }
    if (!existsSync(path)) { res.status(400).json({ error: "Directory does not exist" }); return; }
    currentProject = path;
    await addToRegistry(path);
    res.json({ ok: true, path });
  });

  // Open a directory (create if needed, don't init .bender yet)
  app.post("/api/project/open", async (req, res) => {
    const { path } = req.body as { path: string };
    if (!path) { res.status(400).json({ error: "path required" }); return; }
    if (!existsSync(path)) {
      await mkdir(path, { recursive: true });
    }
    currentProject = path;
    await addToRegistry(path);
    res.json({ ok: true, path });
  });

  // Remove from recents
  app.delete("/api/projects/:encodedPath", async (req, res) => {
    const path = decodeURIComponent(req.params.encodedPath);
    await removeFromRegistry(path);
    res.json({ ok: true });
  });

  // ── Filesystem browser ───────────────────────────────────────────────────

  app.get("/api/fs/browse", async (req, res) => {
    try {
      const queryPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
      let targetPath = queryPath;

      if (!targetPath || targetPath === "~") {
        targetPath = homedir();
      } else if (targetPath.startsWith("~/")) {
        targetPath = join(homedir(), targetPath.slice(2));
      }

      targetPath = resolve(targetPath);

      if (!existsSync(targetPath)) {
        res.status(400).json({ error: "Path does not exist" });
        return;
      }

      const targetStat = await stat(targetPath);
      if (!targetStat.isDirectory()) {
        res.status(400).json({ error: "Path is not a directory" });
        return;
      }

      const entries = await readdir(targetPath, { withFileTypes: true });
      const dirs = (
        await Promise.all(
          entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map(async (e) => {
              const fullPath = join(targetPath, e.name);
              const hasBender = existsSync(join(fullPath, ".bender"));
              return { name: e.name, path: fullPath, hasBender };
            }),
        )
      ).sort((a, b) => a.name.localeCompare(b.name));

      // Also include hidden dirs that are bender projects
      const hiddenDirs = (
        await Promise.all(
          entries
            .filter((e) => e.isDirectory() && e.name.startsWith("."))
            .map(async (e) => {
              const fullPath = join(targetPath, e.name);
              const hasBender = existsSync(join(fullPath, ".bender"));
              return hasBender ? { name: e.name, path: fullPath, hasBender } : null;
            }),
        )
      ).filter(Boolean) as { name: string; path: string; hasBender: boolean }[];

      res.json({
        path: targetPath,
        parent: dirname(targetPath) !== targetPath ? dirname(targetPath) : null,
        dirs: [...dirs, ...hiddenDirs],
        hasBender: existsSync(join(targetPath, ".bender")),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Project state ─────────────────────────────────────────────────────────

  app.get("/api/state", async (_req, res) => {
    if (!currentProject) {
      res.json({ initialized: false, projectRoot: null });
      return;
    }
    try {
      const projectRoot = currentProject;
      const state = new StateManager(projectRoot);

      if (!state.isInitialized()) {
        res.json({ initialized: false, projectRoot });
        return;
      }

      const config = await readConfig(projectRoot);
      const context = await state.gatherContext();
      const decisions = await state.readDecisions();
      const completedTasks = await state.readCompletedTasks();
      const flows = await state.readFlows();

      let git = null;
      try {
        const gitOps = new GitOperations(projectRoot);
        if (await gitOps.isRepo()) {
          const branch = await gitOps.getCurrentBranch();
          const clean = !(await gitOps.hasChanges());
          const recentCommits = await gitOps.log(5);
          git = { branch, clean, recentCommits };
        }
      } catch { /* not a git repo */ }

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
        flows,
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
      const projectRoot = getProject();
      const config = await readConfig(projectRoot);
      const MASK = "••••••••";
      res.json({
        ...config,
        llm: { ...config.llm, apiKey: config.llm.apiKey ? MASK : undefined },
        providers: config.providers
          ? Object.fromEntries(
              Object.entries(config.providers).map(([name, p]) => [name, { apiKey: p.apiKey ? MASK : "" }]),
            )
          : {},
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/config", async (req, res) => {
    try {
      const projectRoot = getProject();
      const current = await readConfig(projectRoot);
      const updates = req.body as Partial<typeof current>;
      const MASK = "••••••••";

      const mergedProviders: { [k: string]: { apiKey?: string } } = { ...current.providers };
      if (updates.providers) {
        for (const [name, p] of Object.entries(updates.providers)) {
          if (p.apiKey && p.apiKey !== MASK) mergedProviders[name] = { apiKey: p.apiKey };
          else if (!p.apiKey) mergedProviders[name] = { apiKey: undefined };
        }
      }

      await writeConfig(projectRoot, {
        ...current,
        ...updates,
        llm: {
          ...current.llm, ...updates.llm,
          apiKey: updates.llm?.apiKey && updates.llm.apiKey !== MASK ? updates.llm.apiKey : current.llm.apiKey,
          models: { ...current.llm.models, ...updates.llm?.models },
        },
        providers: mergedProviders,
        stack: { ...current.stack, ...updates.stack },
        deploy: { ...current.deploy, ...updates.deploy },
        test: { ...current.test, ...updates.test },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Git diff ──────────────────────────────────────────────────────────────

  app.get("/api/git/diff", async (req, res) => {
    try {
      const projectRoot = getProject();
      const gitOps = new GitOperations(projectRoot);
      if (!(await gitOps.isRepo())) { res.json({ diff: null }); return; }
      const commits = parseInt((req.query.commits as string) ?? "1", 10);
      const diff = await gitOps.getDiffRange(`HEAD~${commits}..HEAD`);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Sessions ──────────────────────────────────────────────────────────────

  app.get("/api/sessions", async (_req, res) => {
    try {
      const projectRoot = getProject();
      const state = new StateManager(projectRoot);
      res.json(state.isInitialized() ? await state.readSessions() : []);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Run operations (SSE) ──────────────────────────────────────────────────

  app.post("/api/run/answer", (req, res) => {
    const { id, answer } = req.body as { id: string; answer: string };
    const resolver = pendingAnswers.get(id);
    if (resolver) { pendingAnswers.delete(id); resolver(answer); res.json({ ok: true }); }
    else res.status(404).json({ error: "No pending question with that id" });
  });

  app.post("/api/run/init", async (req, res) => {
    const { description } = req.body as { description?: string };
    await runOperation(res, async (adapter) => {
      const projectRoot = getProject();
      let firstPrompt = true;
      const originalPrompt = adapter.promptMultiline.bind(adapter);
      adapter.promptMultiline = async (q: string) => {
        if (firstPrompt && description) { firstPrompt = false; adapter.info(`> ${description}`); return description; }
        return originalPrompt(q);
      };
      await initCommand(projectRoot, adapter);
      await addToRegistry(projectRoot);
    });
  });

  app.post("/api/run/plan", async (req, res) => {
    const { feature } = req.body as { feature?: string };
    if (!feature) { res.status(400).json({ error: "feature is required" }); return; }
    await runOperation(res, (adapter) => planCommand(getProject(), feature, adapter));
  });

  app.post("/api/run/implement", async (_req, res) => {
    await runOperation(res, (adapter) => implementCommand(getProject(), adapter));
  });

  app.post("/api/run/analyze", async (_req, res) => {
    await runOperation(res, (adapter) => analyzeCommand(getProject(), adapter));
  });

  app.post("/api/run/flows", async (_req, res) => {
    await runOperation(res, async (adapter) => {
      const projectRoot = getProject();
      const state = new StateManager(projectRoot);
      const context = await state.gatherContext();

      if (!context.brief || !context.architecture) {
        throw new Error("Project needs a brief and architecture before flows can be generated. Run init or analyze first.");
      }

      let models;
      try {
        const config = await readConfig(projectRoot);
        models = createModelSet(config);
      } catch (err: unknown) {
        throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
      }

      adapter.subheader("Generating user flow diagrams...");
      const flows = await generateFlows(
        models.default,
        context.brief,
        context.architecture,
        context.schema,
        adapter.streamWriter(),
      );

      await state.writeFlows(flows);
      adapter.success("Flow diagrams saved to .bender/flows.md");
    });
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────

  app.get("/{*path}", (_req, res) => {
    const indexPath = join(webDistDir, "index.html");
    if (existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send("Web UI not built. Run: npm run build:web");
  });

  app.listen(API_PORT, () => { /* logged by CLI */ });
}
