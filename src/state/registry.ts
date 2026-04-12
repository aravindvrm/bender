import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string; // ISO date
}

const REGISTRY_DIR = join(homedir(), ".bender");
const REGISTRY_FILE = join(REGISTRY_DIR, "projects.json");

export async function readRegistry(): Promise<ProjectEntry[]> {
  if (!existsSync(REGISTRY_FILE)) return [];
  try {
    const raw = await readFile(REGISTRY_FILE, "utf-8");
    return JSON.parse(raw) as ProjectEntry[];
  } catch {
    return [];
  }
}

export async function addToRegistry(projectPath: string): Promise<void> {
  const entries = await readRegistry();
  const existing = entries.findIndex((e) => e.path === projectPath);
  const entry: ProjectEntry = {
    path: projectPath,
    name: basename(projectPath),
    lastOpened: new Date().toISOString(),
  };
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.unshift(entry);
  }
  // Keep last 20
  const trimmed = entries.slice(0, 20);
  if (!existsSync(REGISTRY_DIR)) await mkdir(REGISTRY_DIR, { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
}

export async function removeFromRegistry(projectPath: string): Promise<void> {
  const entries = await readRegistry();
  const filtered = entries.filter((e) => e.path !== projectPath);
  if (!existsSync(REGISTRY_DIR)) await mkdir(REGISTRY_DIR, { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(filtered, null, 2), "utf-8");
}
