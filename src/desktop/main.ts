import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const DEFAULT_PORT = 3142;
const DOCS_URL = "https://github.com/aravindvrm/bender";
const IS_MAC = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort: number | null = null;
let shuttingDown = false;
let lastBackendLog = "";
let backendSpawnError: string | null = null;

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function isPortConfiguredExplicitly(): boolean {
  return parsePort(process.env.BENDER_PORT) !== null || parsePort(process.env.PORT) !== null;
}

function resolveRequestedPort(): number {
  return parsePort(process.env.BENDER_PORT) ?? parsePort(process.env.PORT) ?? DEFAULT_PORT;
}

function createStatusHtml(title: string, body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0b0b0b;
        color: #f4f4f5;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
      }
      .card {
        max-width: 640px;
        border: 1px solid #27272a;
        background: #111113;
        border-radius: 12px;
        padding: 20px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 18px;
      }
      p {
        margin: 8px 0;
        color: #d4d4d8;
        white-space: pre-wrap;
        line-height: 1.45;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        background: #18181b;
        border-radius: 6px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
  </body>
</html>`;
}

function createStartupHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Bender</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0b0b0b;
        color: #f4f4f5;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
      }
      .stack {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
      }
      .label {
        font-size: 13px;
        color: #a1a1aa;
        width: 220px;
        text-align: center;
      }
      .bender-loader {
        width: var(--loader-size, 30px);
        aspect-ratio: 1;
        --loader-color: #fff;
        --g1: conic-gradient(from 90deg at top 5.45% left 5.45%, #0000 90deg, var(--loader-color) 0);
        --g2: conic-gradient(from -90deg at bottom 5.45% right 5.45%, #0000 90deg, var(--loader-color) 0);
        background:
          var(--g1), var(--g1), var(--g1), var(--g1),
          var(--g2), var(--g2), var(--g2), var(--g2);
        background-position: 0 0, 100% 0, 100% 100%, 0 100%;
        background-size: 45.45% 45.45%;
        background-repeat: no-repeat;
        animation: bender-loader-frames 1.5s infinite;
      }
      @keyframes bender-loader-frames {
        0%   { background-size: 63.64% 27.27%, 27.27% 27.27%, 27.27% 63.64%, 63.64% 63.64%; }
        25%  { background-size: 63.64% 63.64%, 27.27% 63.64%, 27.27% 27.27%, 63.64% 27.27%; }
        50%  { background-size: 27.27% 63.64%, 63.64% 63.64%, 63.64% 27.27%, 27.27% 27.27%; }
        75%  { background-size: 27.27% 27.27%, 63.64% 27.27%, 63.64% 63.64%, 27.27% 63.64%; }
        100% { background-size: 63.64% 27.27%, 27.27% 27.27%, 27.27% 63.64%, 63.64% 63.64%; }
      }
    </style>
  </head>
  <body>
      <div class="stack">
      <div class="bender-loader" aria-hidden="true"></div>
      <div class="label" id="startup-label">Spinning the wheel</div>
    </div>
    <script>
      (function () {
        const lines = [
          "Spinning the wheel",
          "Dealing the cards",
          "Jacking in",
        ];
        let index = 0;
        const label = document.getElementById("startup-label");
        if (!label) return;
        setInterval(() => {
          index = (index + 1) % lines.length;
          label.textContent = lines[index];
        }, 1400);
      })();
    </script>
  </body>
</html>`;
}

async function loadStatusPage(title: string, message: string): Promise<void> {
  if (!mainWindow) return;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createStatusHtml(title, message))}`);
}

async function loadStartupPage(): Promise<void> {
  if (!mainWindow) return;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createStartupHtml())}`);
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

async function pickBackendPort(): Promise<number> {
  const requested = resolveRequestedPort();
  const explicit = isPortConfiguredExplicitly();
  const requestedOpen = await isPortAvailable(requested);
  if (requestedOpen) return requested;
  if (explicit) {
    throw new Error(`Configured backend port ${requested} is already in use. Set a free BENDER_PORT/PORT and restart.`);
  }

  const fallback = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a free backend port")));
        return;
      }
      const freePort = address.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(freePort);
      });
    });
  });

  return fallback;
}

function backendScriptPath(): string {
  return join(import.meta.dirname, "backend.js");
}

function resolveNodeCommand(): string {
  const configured = (process.env.BENDER_NODE_BIN ?? "").trim();
  if (configured.length > 0) return configured;
  return "node";
}

function appendBackendLog(chunk: Buffer): void {
  const text = chunk.toString("utf-8");
  if (!text.trim()) return;
  lastBackendLog = `${lastBackendLog}\n${text}`.trim().slice(-8000);
}

function stopBackendProcess(): void {
  if (!backendProcess) return;
  const child = backendProcess;
  backendProcess = null;

  if (child.exitCode !== null || child.killed) return;
  try {
    child.kill();
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 3000);
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const healthUrl = `${baseUrl}/api/health`;

  while (Date.now() < deadline) {
    if (backendSpawnError) {
      throw new Error(backendSpawnError);
    }

    if (!backendProcess || backendProcess.exitCode !== null) {
      throw new Error("Backend process exited before becoming healthy.");
    }

    try {
      const res = await fetch(healthUrl, { method: "GET" });
      if (res.ok) {
        const data = await res.json() as { ok?: boolean };
        if (data.ok === true) return;
      }
    } catch {
      // retry until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for backend health at ${healthUrl}.`);
}

async function startBackend(port: number): Promise<void> {
  backendSpawnError = null;
  const child = spawn(resolveNodeCommand(), [backendScriptPath()], {
    env: {
      ...process.env,
      BENDER_PORT: String(port),
      BENDER_DESKTOP_MODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  backendProcess = child;
  child.stdout.on("data", appendBackendLog);
  child.stderr.on("data", appendBackendLog);
  child.once("error", (error: Error) => {
    backendSpawnError = `Failed to spawn backend process (${resolveNodeCommand()}): ${error.message}. `
      + "If Node is not on PATH, set BENDER_NODE_BIN to your Node executable path.";
  });
  child.once("exit", async (code, signal) => {
    const msg = `Backend exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`;
    if (shuttingDown) return;
    await loadStatusPage("Backend Stopped", `${msg}\n\nLast backend logs:\n${lastBackendLog || "(no logs captured)"}`);
  });
}

async function bootDesktop(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: true,
    title: "Bender",
  });

  await loadStartupPage();

  try {
    backendPort = await pickBackendPort();
    await startBackend(backendPort);
    const baseUrl = `http://127.0.0.1:${backendPort}`;
    await waitForHealth(baseUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(baseUrl);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await loadStatusPage(
      "Failed to Start Backend",
      `${message}\n\nLast backend logs:\n${lastBackendLog || "(no logs captured)"}`,
    );
  }
}

function openDashboardInBrowser(): void {
  if (!backendPort) return;
  void shell.openExternal(`http://127.0.0.1:${backendPort}`);
}

function setAppMenu(): void {
  const appSubmenuMac: MenuItemConstructorOptions[] = [
    { role: "about" },
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide" },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    { role: "quit" },
  ];
  const appSubmenuOther: MenuItemConstructorOptions[] = [
    { role: "about" },
    { type: "separator" },
    { role: "quit" },
  ];

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Open Dashboard in Browser",
      accelerator: "CmdOrCtrl+Shift+O",
      click: openDashboardInBrowser,
    },
    ...(IS_MAC ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
  ];
  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "delete" },
    { type: "separator" },
    { role: "selectAll" },
  ];
  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    { type: "separator" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: "minimize" },
    { role: "zoom" },
    ...(IS_MAC
      ? [{ type: "separator" as const }, { role: "front" as const }, { role: "window" as const }]
      : [{ role: "close" as const }]),
  ];
  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Bender Documentation",
      click: () => { void shell.openExternal(DOCS_URL); },
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(IS_MAC
      ? [{
          label: "Bender",
          submenu: appSubmenuMac,
        }]
      : [{
          label: "Bender",
          submenu: appSubmenuOther,
        }]),
    {
      label: "File",
      submenu: fileSubmenu,
    },
    {
      label: "Edit",
      submenu: editSubmenu,
    },
    {
      label: "View",
      submenu: viewSubmenu,
    },
    {
      label: "Window",
      submenu: windowSubmenu,
    },
    {
      label: "Help",
      submenu: helpSubmenu,
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("before-quit", () => {
  shuttingDown = true;
  stopBackendProcess();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(() => {
  app.setName("Bender");
  app.setAboutPanelOptions({
    applicationName: "Bender",
    applicationVersion: app.getVersion(),
  });
  setAppMenu();
  void bootDesktop();
});
