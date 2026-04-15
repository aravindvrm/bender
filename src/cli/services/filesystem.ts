import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { readdir, stat } from "node:fs/promises";

export class FilesystemServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function browseDirectory(targetPath: string): Promise<{
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string; hasBender: boolean }>;
  hasBender: boolean;
}> {
  if (!existsSync(targetPath)) {
    throw new FilesystemServiceError(400, "Path does not exist");
  }

  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) {
    throw new FilesystemServiceError(400, "Path is not a directory");
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
  ).filter(Boolean) as Array<{ name: string; path: string; hasBender: boolean }>;

  return {
    path: targetPath,
    parent: dirname(targetPath) !== targetPath ? dirname(targetPath) : null,
    dirs: [...dirs, ...hiddenDirs],
    hasBender: existsSync(join(targetPath, ".bender")),
  };
}

export async function inspectDirectory(targetPath: string): Promise<{
  path: string;
  exists: boolean;
  isDirectory: boolean;
  empty: boolean;
  hasBender: boolean;
  initialized: boolean;
  entryCount: number;
  fileCount: number;
  dirCount: number;
}> {
  if (!existsSync(targetPath)) {
    return {
      path: targetPath,
      exists: false,
      isDirectory: false,
      empty: true,
      hasBender: false,
      initialized: false,
      entryCount: 0,
      fileCount: 0,
      dirCount: 0,
    };
  }

  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) {
    return {
      path: targetPath,
      exists: true,
      isDirectory: false,
      empty: false,
      hasBender: false,
      initialized: false,
      entryCount: 0,
      fileCount: 0,
      dirCount: 0,
    };
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const fileCount = entries.filter((e) => e.isFile()).length;
  const dirCount = entries.filter((e) => e.isDirectory()).length;
  const hasBender = existsSync(join(targetPath, ".bender"));

  return {
    path: targetPath,
    exists: true,
    isDirectory: true,
    empty: entries.length === 0,
    hasBender,
    initialized: hasBender,
    entryCount: entries.length,
    fileCount,
    dirCount,
  };
}
