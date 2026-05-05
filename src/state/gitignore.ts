import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";

const GITIGNORE_ENTRY = ".bender/";
const GITIGNORE_HEADER = "# Bender runtime project state";

/**
 * Best-effort housekeeping so the project's `.bender/` directory doesn't
 * pollute the user's git history or downstream review tooling:
 *
 *   1. Append `.bender/` to .gitignore (creating the file if missing).
 *   2. Untrack any `.bender/` paths that were committed before the entry
 *      was added — `git rm --cached -r --ignore-unmatch .bender/`.
 *
 * Silent on non-git projects and on any error: this is a polish step,
 * not a precondition for `bender init`.
 */
export async function ensureBenderGitignored(projectRoot: string): Promise<void> {
  if (!existsSync(join(projectRoot, ".git"))) return;
  try {
    await ensureGitignoreEntry(projectRoot);
    await untrackBenderDir(projectRoot);
  } catch {
    // best-effort
  }
}

async function ensureGitignoreEntry(projectRoot: string): Promise<void> {
  const path = join(projectRoot, ".gitignore");
  let contents = "";
  if (existsSync(path)) {
    contents = await readFile(path, "utf-8");
    const hasEntry = contents
      .split(/\r?\n/)
      .some((line) => line.trim() === GITIGNORE_ENTRY || line.trim() === ".bender");
    if (hasEntry) return;
  }
  const prefix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  const block = `${prefix}\n${GITIGNORE_HEADER}\n${GITIGNORE_ENTRY}\n`;
  await writeFile(path, contents + block, "utf-8");
}

async function untrackBenderDir(projectRoot: string): Promise<void> {
  const git = simpleGit(projectRoot);
  await git.raw(["rm", "--cached", "-r", "--ignore-unmatch", ".bender/"]);
}
