import { resolve } from "node:path";
import type { Server as HttpServer } from "node:http";
import { startServer } from "../cli/server.js";
import { resolveServerPort } from "../cli/server-config.js";

function resolveInitialProjectFromEnv(): string | undefined {
  const raw = (process.env.BENDER_PROJECT_DIR ?? "").trim();
  if (!raw) return undefined;
  return resolve(raw);
}

async function run(): Promise<void> {
  const initialProject = resolveInitialProjectFromEnv();
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
