import { resolve } from "node:path";
import type { Socket } from "node:net";
import { startServer } from "./server.js";
import {
  clearDashboardPid,
  clearDashboardPidSync,
  isProcessRunning,
  readDashboardPid,
  writeDashboardPid,
} from "./serverProcess.js";
import * as ui from "./ui.js";

export async function bendCommand(projectDir?: string): Promise<void> {
  const initialProject = projectDir ? resolve(projectDir) : undefined;

  const existingPid = await readDashboardPid();
  if (existingPid && isProcessRunning(existingPid)) {
    ui.warn(`Dashboard already running (pid ${existingPid}). Use 'bender stop' first if needed.\n`);
    return;
  }
  if (existingPid && !isProcessRunning(existingPid)) {
    await clearDashboardPid();
  }

  ui.header("Bender Bend — Dashboard");
  ui.info("Starting local server...\n");

  const server = await startServer(initialProject);
  const address = server.address();
  const runtimePort = typeof address === "object" && address ? address.port : 3142;
  await writeDashboardPid(process.pid);

  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  ui.success(`Server running on http://localhost:${runtimePort}`);
  console.log();
  if (initialProject) {
    ui.info(`Project: ${initialProject}`);
  } else {
    ui.info("No project selected. Open or create one from the dashboard.");
  }
  console.log();
  ui.info("Press Ctrl+C to stop.\n");

  let shuttingDown = false;
  let forceQuitArmed = false;
  let runLoopDone = false;
  let resolveRunLoop: (() => void) | null = null;
  const finishRunLoop = () => {
    if (runLoopDone) return;
    runLoopDone = true;
    resolveRunLoop?.();
  };
  const closeWithTimeout = async (timeoutMs: number): Promise<void> => {
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolveClose();
      };

      const timer = setTimeout(() => {
        // Force-close active keepalive/websocket connections so server.close can finish.
        for (const socket of sockets) {
          try { socket.destroy(); } catch { /* ignore */ }
        }
        if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === "function") {
          try { (server as { closeAllConnections: () => void }).closeAllConnections(); } catch { /* ignore */ }
        }
        done();
      }, timeoutMs);

      server.close(() => {
        clearTimeout(timer);
        done();
      });
    });
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.info(`\nStopping server (${signal})...`);
    await clearDashboardPid();
    await closeWithTimeout(2000);
    finishRunLoop();
  };

  const onSigInt = () => {
    if (shuttingDown && forceQuitArmed) {
      ui.warn("Force exiting.");
      process.exit(130);
    }
    if (shuttingDown) {
      forceQuitArmed = true;
      return;
    }
    forceQuitArmed = true;
    void shutdown("SIGINT");
  };
  const onSigTerm = () => { void shutdown("SIGTERM"); };
  const onStdinData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Fallback for environments where SIGINT is swallowed and Ctrl+C arrives as ^C byte.
    if (text.includes("\u0003")) {
      onSigInt();
    }
  };
  const stdin = process.stdin as NodeJS.ReadStream;
  const canUseRawMode = Boolean(stdin?.isTTY && typeof stdin.setRawMode === "function");
  let rawModeEnabled = false;

  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  if (stdin && stdin.readable) {
    if (canUseRawMode) {
      try {
        stdin.setRawMode(true);
        rawModeEnabled = true;
      } catch {
        rawModeEnabled = false;
      }
    }
    stdin.on("data", onStdinData);
    stdin.resume();
  }
  process.once("exit", () => {
    clearDashboardPidSync();
    if (rawModeEnabled) {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
  });

  await new Promise<void>((resolve) => {
    resolveRunLoop = resolve;
    server.once("close", () => {
      finishRunLoop();
    });
  });

  process.off("SIGINT", onSigInt);
  process.off("SIGTERM", onSigTerm);
  if (stdin && stdin.readable) {
    stdin.off("data", onStdinData);
    if (rawModeEnabled) {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      rawModeEnabled = false;
    }
  }
}

// Backward-compatible alias for older scripts/workflows.
export async function openCommand(projectDir?: string): Promise<void> {
  await bendCommand(projectDir);
}

// Backward-compatible alias for older scripts/workflows.
export async function reviewCommand(projectDir?: string): Promise<void> {
  await bendCommand(projectDir);
}
