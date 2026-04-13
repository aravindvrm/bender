import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
  size: number; // bytes of SKILL.md content
}

export interface SkillsRegistry {
  fetchedAt: number;
  skills: SkillMeta[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Skills larger than this are only injected on task-specific match (tier 3), not project context (tier 2). */
export const TIER2_MAX_BYTES = 5000;

/** Registry TTL: 24 hours */
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

const GITHUB_ORG = "openai";
const GITHUB_REPO = "skills";
const SKILLS_PATH = "skills/.curated";

function getCacheDir(): string {
  return join(homedir(), ".bender", "skills-cache");
}

function getRegistryPath(): string {
  return join(getCacheDir(), "registry.json");
}

function getSkillCachePath(name: string): string {
  return join(getCacheDir(), `${name}.md`);
}

// ── GitHub fetch helpers ──────────────────────────────────────────────────────

async function githubGet(path: string): Promise<unknown> {
  const url = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "bender-app",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${path}`);
  }
  return res.json();
}

function parseDescription(content: string): string {
  // Extract description from SKILL.md frontmatter
  const match = content.match(/^---[\s\S]*?description:\s*["']?([^\n"']+)["']?[\s\S]*?---/m);
  return match ? match[1].trim().replace(/\\n/g, " ") : "";
}

// ── Registry management ───────────────────────────────────────────────────────

export async function readRegistry(): Promise<SkillsRegistry | null> {
  const path = getRegistryPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SkillsRegistry;
  } catch {
    return null;
  }
}

export async function fetchRegistry(force = false): Promise<SkillsRegistry> {
  if (!force) {
    const cached = await readRegistry();
    if (cached && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS) {
      return cached;
    }
  }

  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }

  // List all skill directories
  const items = (await githubGet(SKILLS_PATH)) as Array<{ name: string; type: string }>;
  const skillNames = items
    .filter((item) => item.type === "dir" && !item.name.startsWith("."))
    .map((item) => item.name);

  // Fetch metadata in batches of 5
  const metas: SkillMeta[] = [];
  const BATCH = 5;
  for (let i = 0; i < skillNames.length; i += BATCH) {
    const batch = skillNames.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (name): Promise<SkillMeta | null> => {
        try {
          const data = (await githubGet(`${SKILLS_PATH}/${name}/SKILL.md`)) as {
            content?: string;
            size?: number;
          };
          const size = data.size ?? 0;
          const description = data.content
            ? parseDescription(Buffer.from(data.content, "base64").toString("utf-8"))
            : "";
          return { name, description, size };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) metas.push(r.value);
    }
  }

  const registry: SkillsRegistry = {
    fetchedAt: Date.now(),
    skills: metas.sort((a, b) => a.name.localeCompare(b.name)),
  };

  await writeFile(getRegistryPath(), JSON.stringify(registry, null, 2), "utf-8");
  return registry;
}

// ── Skill content cache ───────────────────────────────────────────────────────

export async function fetchSkillContent(name: string): Promise<string | null> {
  const cachePath = getSkillCachePath(name);

  if (existsSync(cachePath)) {
    try {
      return await readFile(cachePath, "utf-8");
    } catch {
      // fall through
    }
  }

  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }

  try {
    const data = (await githubGet(`${SKILLS_PATH}/${name}/SKILL.md`)) as {
      content?: string;
    };
    if (!data.content) return null;
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    await writeFile(cachePath, content, "utf-8");
    return content;
  } catch {
    return null;
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────

/** Score a skill against a text query using keyword overlap. */
export function scoreSkill(skill: SkillMeta, query: string): number {
  const q = query.toLowerCase();
  const nameWords = skill.name.replace(/-/g, " ").toLowerCase();
  const descWords = skill.description.toLowerCase();

  let score = 0;

  // Exact name phrase match
  if (q.includes(nameWords)) score += 10;

  // Individual name word matches (>3 chars)
  for (const w of nameWords.split(" ").filter((w) => w.length > 3)) {
    if (q.includes(w)) score += 3;
  }

  // Description word matches (>4 chars)
  for (const w of descWords.split(/\W+/).filter((w) => w.length > 4)) {
    if (q.includes(w)) score += 1;
  }

  return score;
}

/**
 * Select top N skills from the enabled set by matching against a query string.
 * Returns skill names sorted by relevance, filtered to score > 0.
 */
export function selectSkillsByKeyword(
  enabledSkills: SkillMeta[],
  query: string,
  topN = 3,
): string[] {
  return enabledSkills
    .map((s) => ({ name: s.name, score: scoreSkill(s, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => s.name);
}

/**
 * Build a project context query string from config fields and architecture text.
 * Used for tier-2 (project context) skill matching.
 */
export function buildProjectContextQuery(
  config: {
    stack?: { framework?: string; database?: string };
    deploy?: { target?: string };
    test?: { command?: string };
  },
  architectureText?: string,
): string {
  return [
    config.stack?.framework ?? "",
    config.stack?.database ?? "",
    config.deploy?.target ?? "",
    config.test?.command ?? "",
    (architectureText ?? "").slice(0, 2000),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
