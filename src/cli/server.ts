import express from "express";
import cors from "cors";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { GitOperations } from "../git/operations.js";

const API_PORT = 3142;

export async function startServer(projectRoot: string): Promise<void> {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve built web UI static files
  const webDistDir = join(import.meta.dirname, "..", "web");
  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
  }

  // API: Get full project state
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
        brief: context.brief,
        architecture: context.architecture,
        conventions: context.conventions,
        schema: context.schema,
        decisions,
        currentTasks: context.currentTasks,
        completedTasks,
        apiContracts: context.apiContracts,
        config: {
          llm: {
            provider: config.llm.provider,
            models: config.llm.models,
          },
          stack: config.stack,
        },
        git,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Fallback: serve index.html for SPA routes
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
