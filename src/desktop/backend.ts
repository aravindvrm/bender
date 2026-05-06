import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Server as HttpServer } from "node:http";
import { startServer } from "../cli/server.js";
import { resolveServerPort } from "../cli/server-config.js";
import { readRegistry } from "../state/registry.js";

function resolveInitialProjectFromEnv(): string | undefined {
  const raw = (process.env.BENDER_PROJECT_DIR ?? "").trim();
  if (!raw) return undefined;
  return resolve(raw);
}

/**
 * Pick the most-recently-opened project from the recents registry that
 * still exists on disk. Used by the desktop app on cold launch when the
 * user hasn't passed a project explicitly — without this the UI loads
 * with no project and every project-scoped tab (Brief, Tasks, Workflows,
 * Architecture, Evals) renders empty.
 *
 * Stale entries (deleted directories) are silently skipped and stay in
 * the registry so the user still sees them in the picker.
 */
async function resolveLastOpenedProject(): Promise<string | undefined> {
  try {
    const entries = await readRegistry();
    const sorted = [...entries].sort(
      (a, b) => Date.parse(b.lastOpened) - Date.parse(a.lastOpened),
    );
    for (const entry of sorted) {
      try {
        if (existsSync(entry.path) && statSync(entry.path).isDirectory()) {
          return entry.path;
        }
      } catch {
        // ignore stat errors on individual entries
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bender-desktop-backend] Failed to read project registry: ${message}`);
  }
  return undefined;
}

async function run(): Promise<void> {
  const fromEnv = resolveInitialProjectFromEnv();
  const initialProject = fromEnv ?? await resolveLastOpenedProject();
  const requestedPort = resolveServerPort();

  let server: HttpServer;
  try {
    server = await startServer(initialProject, requestedPort);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bender-desktop-backend] Failed to start backend: ${message}`);
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string) => {
    try {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    } finally {
      if (signal) {
        process.exitCode = 0;
      }
    }
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}

void run();
