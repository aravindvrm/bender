/**
 * Tool set and system prompt for global (no-project) chat scope.
 * Tools here focus on project lifecycle: opening, cloning, listing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getBenderHomeDir } from "../../state/paths.js";
import { HomeDb } from "../../state/home-db.js";
import { readRegistry, addToRegistry } from "../../state/registry.js";
import { openProjectDirectory } from "./projects.js";

export const GLOBAL_SYSTEM_PROMPT = [
  "You are Bender, an AI assistant for software development.",
  "",
  "## Current context",
  "No project is open. You are in app-level (global) mode.",
  "",
  "## What you can do",
  "- Help the user open an existing local project",
  "- Clone a GitHub or Git repository to get started",
  "- List recently opened projects",
  "- Answer general software development questions",
  "",
  "## Getting started flow",
  "When the user wants to work on a project:",
  "1. If they have a local path → use bender_open_project",
  "2. If they have a GitHub/Git URL → use bender_clone_repo (ask for clone destination if not provided)",
  "3. If they want to browse what they've worked on → use bender_list_recent_projects",
  "",
  "## Rules",
  "- After successfully opening or cloning a project, tell the user the app is switching to that project.",
  "- For clone destination: if the user hasn't specified one, ask. Suggest their default clone directory if set.",
  "- Never invent project paths. Always confirm with the user before opening.",
  "- You cannot run /task, /audit, or /analyze commands without an open project — explain this if asked.",
].join("\n");

function getDefaultCloneDir(): string {
  const db = HomeDb.current();
  try {
    return db.getJson<string>("global.defaultCloneDir") ?? join(getBenderHomeDir(), "projects");
  } catch {
    return join(getBenderHomeDir(), "projects");
  }
}

function setDefaultCloneDir(dir: string): void {
  const db = HomeDb.current();
  db.setJson("global.defaultCloneDir", dir);
}

function gitClone(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", "--depth=1", url, dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (signal) {
      signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
    }
    const stderr: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed: ${stderr.join("").trim() || `exit ${code}`}`));
    });
    proc.on("error", reject);
  });
}

export function createGlobalTools(
  onProjectOpened: (path: string) => void,
  signal?: AbortSignal,
): ToolSet {
  return {
    bender_list_recent_projects: tool({
      description: "List recently opened Bender projects, ordered by last-opened date.",
      inputSchema: z.object({}),
      execute: async () => {
        const projects = await readRegistry();
        if (projects.length === 0) {
          return { ok: true, count: 0, projects: [], message: "No recent projects found." };
        }
        return {
          ok: true,
          count: projects.length,
          projects: projects.map((p) => ({
            name: p.name,
            path: p.path,
            lastOpened: p.lastOpened,
          })),
        };
      },
    }),

    bender_open_project: tool({
      description: "Open an existing local project directory in Bender. Use this when the user provides a file path.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute or ~ path to the project directory."),
      }),
      execute: async ({ path }) => {
        if (signal?.aborted) throw new Error("Aborted");
        // Expand ~ manually
        const expanded = path.startsWith("~/")
          ? join(getBenderHomeDir(), "..", path.slice(2))
          : path;
        const resolved = resolve(expanded);
        if (!existsSync(resolved)) {
          return { ok: false, error: `Directory not found: ${resolved}` };
        }
        const opened = await openProjectDirectory(resolved);
        onProjectOpened(opened);
        return { ok: true, path: opened, message: `Opened project at ${opened}. The app is switching now.` };
      },
    }),

    bender_clone_repo: tool({
      description: [
        "Clone a Git/GitHub repository to a local directory, then open it as a project.",
        "If the user has not specified a destination directory, ask them.",
        "Suggest their default clone directory. They can optionally set it as the new default.",
      ].join(" "),
      inputSchema: z.object({
        url: z.string().min(1).describe("The Git clone URL or GitHub shorthand (e.g. owner/repo)."),
        dest: z.string().optional().describe("Destination directory. Omit to use default clone dir + repo name."),
        setAsDefaultDir: z.boolean().optional().describe("If true, save the parent of dest as the new default clone directory."),
      }),
      execute: async ({ url, dest, setAsDefaultDir }) => {
        if (signal?.aborted) throw new Error("Aborted");
        // Normalise GitHub shorthand owner/repo → full HTTPS URL
        const cloneUrl = /^[\w.-]+\/[\w.-]+$/.test(url)
          ? `https://github.com/${url}.git`
          : url;
        const repoName = basename(cloneUrl.replace(/\.git$/, ""));
        const defaultDir = getDefaultCloneDir();
        const expandTilde = (p: string) =>
          p.startsWith("~/") ? join(getBenderHomeDir(), "..", p.slice(2)) : p;

        const cloneDest = dest
          ? resolve(expandTilde(dest))
          : join(defaultDir, repoName);

        if (existsSync(cloneDest)) {
          return { ok: false, error: `Destination already exists: ${cloneDest}` };
        }

        await mkdir(cloneDest, { recursive: true }).catch(() => {});
        if (signal?.aborted) throw new Error("Aborted");

        try {
          await gitClone(cloneUrl, cloneDest, signal);
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }

        if (setAsDefaultDir) {
          setDefaultCloneDir(resolve(expandTilde(dest ?? defaultDir)));
        }

        await addToRegistry(cloneDest);
        onProjectOpened(cloneDest);

        return {
          ok: true,
          path: cloneDest,
          message: `Cloned ${repoName} to ${cloneDest}. The app is switching to this project now.`,
        };
      },
    }),

    bender_get_clone_dir: tool({
      description: "Get the user's current default clone directory.",
      inputSchema: z.object({}),
      execute: async () => {
        return { ok: true, defaultCloneDir: getDefaultCloneDir() };
      },
    }),

    bender_set_clone_dir: tool({
      description: "Set or update the user's default directory for cloning repositories.",
      inputSchema: z.object({
        dir: z.string().min(1).describe("Absolute or ~ path to use as the default clone directory."),
      }),
      execute: async ({ dir }) => {
        const expanded = dir.startsWith("~/")
          ? join(getBenderHomeDir(), "..", dir.slice(2))
          : resolve(dir);
        setDefaultCloneDir(expanded);
        return { ok: true, defaultCloneDir: expanded };
      },
    }),
  };
}
