import { existsSync, unlinkSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const BENDER_DIR = join(homedir(), ".bender");
const DASHBOARD_PID_FILE = join(BENDER_DIR, "dashboard.pid");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readDashboardPid(): Promise<number | null> {
  if (!existsSync(DASHBOARD_PID_FILE)) return null;
  try {
    const raw = (await readFile(DASHBOARD_PID_FILE, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writeDashboardPid(pid: number): Promise<void> {
  const dir = dirname(DASHBOARD_PID_FILE);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(DASHBOARD_PID_FILE, String(pid), "utf-8");
}

export async function clearDashboardPid(): Promise<void> {
  if (!existsSync(DASHBOARD_PID_FILE)) return;
  try {
    await unlink(DASHBOARD_PID_FILE);
  } catch {
    // ignore
  }
}

export function clearDashboardPidSync(): void {
  if (!existsSync(DASHBOARD_PID_FILE)) return;
  try {
    unlinkSync(DASHBOARD_PID_FILE);
  } catch {
    // ignore
  }
}

export async function stopProcessGracefully(pid: number, timeoutMs = 3000): Promise<{ stopped: boolean; forced: boolean }> {
  if (!isProcessRunning(pid)) return { stopped: true, forced: false };

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { stopped: !isProcessRunning(pid), forced: false };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return { stopped: true, forced: false };
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return { stopped: !isProcessRunning(pid), forced: false };
  }

  await sleep(100);
  return { stopped: !isProcessRunning(pid), forced: true };
}

export async function findPidsListeningOnPort(port: number): Promise<number[]> {
  return await new Promise<number[]>((resolve) => {
    const child = spawn("lsof", ["-ti", `tcp:${port}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve([]);
    }, 1500);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve([]);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && stdout.trim().length === 0) {
        resolve([]);
        return;
      }
      const pids = stdout
        .split(/\s+/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      resolve([...new Set(pids)]);
    });
  });
}
