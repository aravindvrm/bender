import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { getBenderHomeDir } from "./paths.js";
import { HomeDb } from "./home-db.js";

export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string; // ISO date
}

const REGISTRY_DB_KEY = "state.registry.projects.v1";

function getRegistryDir(): string {
  return getBenderHomeDir();
}

function getRegistryFile(): string {
  return join(getRegistryDir(), "projects.json");
}

export async function readRegistry(): Promise<ProjectEntry[]> {
  const db = HomeDb.current();
  await db.init();
  const fromDb = db.getJson<ProjectEntry[]>(REGISTRY_DB_KEY);
  if (Array.isArray(fromDb)) {
    return fromDb
      .filter((entry) => entry && typeof entry.path === "string" && typeof entry.name === "string" && typeof entry.lastOpened === "string");
  }

  const registryFile = getRegistryFile();
  if (!existsSync(registryFile)) return [];
  try {
    const raw = await readFile(registryFile, "utf-8");
    const parsed = JSON.parse(raw) as ProjectEntry[];
    db.setJson(REGISTRY_DB_KEY, parsed);
    return parsed;
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
  const db = HomeDb.current();
  await db.init();
  db.setJson(REGISTRY_DB_KEY, trimmed);
  const registryDir = getRegistryDir();
  const registryFile = getRegistryFile();
  if (!existsSync(registryDir)) await mkdir(registryDir, { recursive: true });
  await writeFile(registryFile, JSON.stringify(trimmed, null, 2), "utf-8");
}

export async function removeFromRegistry(projectPath: string): Promise<void> {
  const entries = await readRegistry();
  const filtered = entries.filter((e) => e.path !== projectPath);
  const db = HomeDb.current();
  await db.init();
  db.setJson(REGISTRY_DB_KEY, filtered);
  const registryDir = getRegistryDir();
  const registryFile = getRegistryFile();
  if (!existsSync(registryDir)) await mkdir(registryDir, { recursive: true });
  await writeFile(registryFile, JSON.stringify(filtered, null, 2), "utf-8");
}
