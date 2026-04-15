import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { addToRegistry, readRegistry, removeFromRegistry } from "../../state/registry.js";
import type { ProjectEntry } from "../../state/registry.js";

export async function listRecentProjects(): Promise<ProjectEntry[]> {
  return await readRegistry();
}

export async function selectExistingProject(normalizedPath: string): Promise<string> {
  if (!existsSync(normalizedPath)) {
    throw new Error("Directory does not exist");
  }
  const dirStat = await stat(normalizedPath);
  if (!dirStat.isDirectory()) {
    throw new Error("Path is not a directory");
  }
  await addToRegistry(normalizedPath);
  return normalizedPath;
}

export async function openProjectDirectory(normalizedPath: string): Promise<string> {
  if (!existsSync(normalizedPath)) {
    await mkdir(normalizedPath, { recursive: true });
  } else {
    const dirStat = await stat(normalizedPath);
    if (!dirStat.isDirectory()) {
      throw new Error("Path is not a directory");
    }
  }
  await addToRegistry(normalizedPath);
  return normalizedPath;
}

export async function removeRecentProject(path: string): Promise<void> {
  await removeFromRegistry(path);
}
