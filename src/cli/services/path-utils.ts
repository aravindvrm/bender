import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function normalizeUserPath(input?: string): string {
  const raw = (input ?? "").trim();
  let targetPath = raw;

  if (!targetPath || targetPath === "~") {
    targetPath = homedir();
  } else if (targetPath.startsWith("~/")) {
    targetPath = join(homedir(), targetPath.slice(2));
  }

  return resolve(targetPath);
}

