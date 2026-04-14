import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  fetchRegistry,
  fetchSkillContent,
  type SkillMeta,
} from "./skills.js";

export type SkillPackageSource = "curated" | "user" | "project";

export interface SkillPackageMeta {
  id: string;
  name: string;
  source: SkillPackageSource;
  description: string;
  size: number;
  tags: string[];
  domains: string[];
  triggerPhrases: string[];
  antiTriggerPhrases: string[];
  examples: string[];
  files: {
    skillMdPath?: string;
    references: string[];
    scripts: string[];
    assets: string[];
    evals: string[];
  };
}

export interface SkillPackageRegistry {
  fetchedAt: number;
  packages: SkillPackageMeta[];
}

export interface SkillPackageFetchOptions {
  projectRoot?: string;
  forceRemote?: boolean;
}

interface ParsedFrontmatter {
  description: string;
  tags: string[];
  domains: string[];
  triggerPhrases: string[];
  antiTriggerPhrases: string[];
  examples: string[];
}

const USER_SKILLS_DIR = join(homedir(), ".bender", "skills");

function parseArrayValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((v) => v.trim().replace(/^['\"]|['\"]$/g, ""))
      .filter(Boolean);
  }
  return trimmed
    .split(",")
    .map((v) => v.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) {
    return {
      description: "",
      tags: [],
      domains: [],
      triggerPhrases: [],
      antiTriggerPhrases: [],
      examples: [],
    };
  }
  const fm = m[1];
  const lines = fm.split("\n");
  const out: ParsedFrontmatter = {
    description: "",
    tags: [],
    domains: [],
    triggerPhrases: [],
    antiTriggerPhrases: [],
    examples: [],
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "description") out.description = value.replace(/^['\"]|['\"]$/g, "").trim();
    if (key === "tags") out.tags = parseArrayValue(value);
    if (key === "domains") out.domains = parseArrayValue(value);
    if (key === "trigger_phrases" || key === "triggerphrases") out.triggerPhrases = parseArrayValue(value);
    if (key === "anti_trigger_phrases" || key === "antitriggerphrases") out.antiTriggerPhrases = parseArrayValue(value);
    if (key === "examples") out.examples = parseArrayValue(value);
  }

  return out;
}

async function listDirSafe(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function inspectLocalPackage(baseDir: string, source: SkillPackageSource, dirName: string): Promise<SkillPackageMeta | null> {
  const root = join(baseDir, dirName);
  const skillMd = join(root, "SKILL.md");
  if (!existsSync(skillMd)) return null;

  let content = "";
  try {
    content = await readFile(skillMd, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);

  const refsDir = join(root, "references");
  const scriptsDir = join(root, "scripts");
  const assetsDir = join(root, "assets");
  const evalsDir = join(root, "evals");

  const listFiles = async (dir: string): Promise<string[]> => {
    if (!existsSync(dir)) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => join(dir, e.name)).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };

  return {
    id: `${source}:${dirName}`,
    name: dirName,
    source,
    description: fm.description,
    size: Buffer.byteLength(content, "utf-8"),
    tags: fm.tags,
    domains: fm.domains,
    triggerPhrases: fm.triggerPhrases,
    antiTriggerPhrases: fm.antiTriggerPhrases,
    examples: fm.examples,
    files: {
      skillMdPath: skillMd,
      references: await listFiles(refsDir),
      scripts: await listFiles(scriptsDir),
      assets: await listFiles(assetsDir),
      evals: await listFiles(evalsDir),
    },
  };
}

async function buildLocalPackages(projectRoot?: string): Promise<SkillPackageMeta[]> {
  const out: SkillPackageMeta[] = [];

  const userNames = await listDirSafe(USER_SKILLS_DIR);
  for (const name of userNames) {
    const meta = await inspectLocalPackage(USER_SKILLS_DIR, "user", name);
    if (meta) out.push(meta);
  }

  if (projectRoot) {
    const projectDir = join(projectRoot, ".bender", "skills");
    const projectNames = await listDirSafe(projectDir);
    for (const name of projectNames) {
      const meta = await inspectLocalPackage(projectDir, "project", name);
      if (meta) out.push(meta);
    }
  }

  return out;
}

function fromCuratedSkill(meta: SkillMeta): SkillPackageMeta {
  return {
    id: `curated:${meta.name}`,
    name: meta.name,
    source: "curated",
    description: meta.description,
    size: meta.size,
    tags: [],
    domains: [],
    triggerPhrases: [],
    antiTriggerPhrases: [],
    examples: [],
    files: {
      references: [],
      scripts: [],
      assets: [],
      evals: [],
    },
  };
}

export async function fetchSkillPackages(options: SkillPackageFetchOptions = {}): Promise<SkillPackageRegistry> {
  const curated = await fetchRegistry(Boolean(options.forceRemote));
  const local = await buildLocalPackages(options.projectRoot);
  return {
    fetchedAt: Date.now(),
    packages: [...curated.skills.map(fromCuratedSkill), ...local]
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function fetchSkillPackageContent(pkg: SkillPackageMeta): Promise<string | null> {
  if (pkg.source === "curated") {
    return fetchSkillContent(pkg.name);
  }
  const path = pkg.files.skillMdPath;
  if (!path) return null;
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export function parseExplicitSkillInvocations(query: string, packages: SkillPackageMeta[]): SkillPackageMeta[] {
  const normalized = query.toLowerCase();
  return packages.filter((pkg) => {
    const byDollar = normalized.includes(`$${pkg.name.toLowerCase()}`);
    const bySkillPrefix = normalized.includes(`skill:${pkg.name.toLowerCase()}`);
    const byId = normalized.includes(pkg.id.toLowerCase());
    return byDollar || bySkillPrefix || byId;
  });
}

export function scoreSkillPackage(pkg: SkillPackageMeta, query: string): number {
  const q = query.toLowerCase();
  const nameWords = pkg.name.replace(/[-_]/g, " ").toLowerCase();
  const desc = pkg.description.toLowerCase();

  let score = 0;
  if (q.includes(nameWords)) score += 10;
  for (const w of nameWords.split(" ").filter((w) => w.length > 3)) {
    if (q.includes(w)) score += 2;
  }
  for (const w of desc.split(/\W+/).filter((w) => w.length > 4)) {
    if (q.includes(w)) score += 1;
  }
  for (const tag of pkg.tags) {
    if (q.includes(tag.toLowerCase())) score += 3;
  }
  for (const domain of pkg.domains) {
    if (q.includes(domain.toLowerCase())) score += 3;
  }
  for (const trigger of pkg.triggerPhrases) {
    if (q.includes(trigger.toLowerCase())) score += 4;
  }
  for (const anti of pkg.antiTriggerPhrases) {
    if (q.includes(anti.toLowerCase())) score -= 4;
  }
  return score;
}

export function selectSkillPackagesHybrid(
  packages: SkillPackageMeta[],
  query: string,
  topN = 3,
): SkillPackageMeta[] {
  const explicit = parseExplicitSkillInvocations(query, packages);
  const explicitIds = new Set(explicit.map((p) => p.id));

  const scored = packages
    .map((pkg) => ({ pkg, score: scoreSkillPackage(pkg, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.pkg)
    .filter((pkg) => !explicitIds.has(pkg.id));

  return [...explicit, ...scored].slice(0, topN);
}

export async function hasProjectSkillPackages(projectRoot: string): Promise<boolean> {
  const dir = join(projectRoot, ".bender", "skills");
  if (!existsSync(dir)) return false;
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
  } catch {
    return false;
  }
  const names = await listDirSafe(dir);
  return names.length > 0;
}
