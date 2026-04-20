import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readEffectiveConfig } from "../../state/config.js";
import { fetchRegistry, readRegistry as readSkillsRegistry } from "../../state/skills.js";
import { fetchSkillPackages, type SkillPackageMeta, type SkillPackageSource } from "../../state/skill-packages.js";
import {
  appendSkillEvalRun,
  getSkillWorkbench,
  setSkillEvalCases,
  setSkillEvalRunFeedback,
  type SkillEvalCase,
} from "../../state/skill-workbench.js";
import { StateManager } from "../../state/manager.js";
import { createRoleRuntime } from "../../llm/runtime.js";
import { createModelSet, getModelForTier } from "../../llm/provider.js";
import { runRole } from "../../roles/base.js";
import type { BaseRole } from "../../state/agents.js";
import {
  getRolesWithDefaultPinnedSkill,
  getRolesWithRuntimeBaselineSkill,
  getRuntimeCuratedSkillPool,
} from "../../state/role-skill-defaults.js";
import { getBenderHomePath } from "../../state/paths.js";

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS = ["fast", "default", "strong"] as const;
const RUNTIME_CURATED_POOL = new Set(getRuntimeCuratedSkillPool());

export interface SkillCatalogItem {
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
  defaultPinnedRoles: BaseRole[];
  runtimeBaselineRoles: BaseRole[];
  defaultRuntimeEnabled: boolean;
}

export interface SkillLibrarySummary {
  total: number;
  curated: number;
  user: number;
  project: number;
  runtimeCuratedPool: number;
}

export class SkillsServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isBaseRole(value: string): value is BaseRole {
  return BASE_ROLES.includes(value as BaseRole);
}

function isModelTier(value: string): value is (typeof MODEL_TIERS)[number] {
  return MODEL_TIERS.includes(value as (typeof MODEL_TIERS)[number]);
}

function slugifySkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/(^-|-$)/g, "");
}

function resolveLibraryRoot(scope: "user" | "project", projectRoot: string | null): string {
  if (scope === "user") {
    return getBenderHomePath("skills");
  }
  if (!projectRoot) {
    throw new SkillsServiceError(400, "Project scope requires an open project");
  }
  return join(projectRoot, ".bender", "skills");
}

function toCatalogItem(pkg: SkillPackageMeta): SkillCatalogItem {
  return {
    id: pkg.id,
    name: pkg.name,
    source: pkg.source,
    description: pkg.description,
    size: pkg.size,
    tags: pkg.tags,
    domains: pkg.domains,
    triggerPhrases: pkg.triggerPhrases,
    antiTriggerPhrases: pkg.antiTriggerPhrases,
    examples: pkg.examples,
    defaultPinnedRoles: getRolesWithDefaultPinnedSkill(pkg.name),
    runtimeBaselineRoles: getRolesWithRuntimeBaselineSkill(pkg.name),
    defaultRuntimeEnabled: RUNTIME_CURATED_POOL.has(pkg.name),
  };
}

export async function getSkillsRegistrySnapshot(): Promise<{ skills: unknown[]; fetchedAt: number | null; needsRefresh: boolean }> {
  const registry = await readSkillsRegistry();
  if (!registry) {
    return { skills: [], fetchedAt: null, needsRefresh: true };
  }
  return { skills: registry.skills, fetchedAt: registry.fetchedAt, needsRefresh: false };
}

export async function refreshSkillsRegistrySnapshot(): Promise<{ skills: unknown[]; fetchedAt: number }> {
  const registry = await fetchRegistry(true);
  return { skills: registry.skills, fetchedAt: registry.fetchedAt };
}

export async function getSkillsCatalog(projectRoot: string | null): Promise<{
  skills: SkillCatalogItem[];
  fetchedAt: number;
  stale?: boolean;
  summary: SkillLibrarySummary;
}> {
  const registry = await fetchSkillPackages({ projectRoot: projectRoot ?? undefined });
  const catalog = registry.packages.map(toCatalogItem);
  return {
    skills: catalog,
    fetchedAt: registry.fetchedAt,
    stale: registry.stale === true ? true : undefined,
    summary: {
      total: catalog.length,
      curated: catalog.filter((s) => s.source === "curated").length,
      user: catalog.filter((s) => s.source === "user").length,
      project: catalog.filter((s) => s.source === "project").length,
      runtimeCuratedPool: RUNTIME_CURATED_POOL.size,
    },
  };
}

export async function createSkillPackage(
  projectRoot: string | null,
  body: { scope?: "user" | "project"; name?: string; description?: string },
): Promise<{ ok: true; scope: "user" | "project"; name: string; path: string }> {
  const scope = body.scope === "project" ? "project" : "user";
  const rawName = (body.name ?? "").trim();
  if (!rawName) {
    throw new SkillsServiceError(400, "name is required");
  }
  const name = slugifySkillName(rawName);
  if (!name) {
    throw new SkillsServiceError(400, "name must contain alphanumeric characters");
  }

  const libraryRoot = resolveLibraryRoot(scope, projectRoot);
  const targetDir = join(libraryRoot, name);
  const skillPath = join(targetDir, "SKILL.md");
  if (existsSync(skillPath)) {
    throw new SkillsServiceError(409, `Skill '${name}' already exists in ${scope} library`);
  }

  await mkdir(targetDir, { recursive: true });
  const description = (body.description ?? "").trim() || "Describe when this skill should be used.";
  const starter = [
    "---",
    `description: ${JSON.stringify(description)}`,
    "tags: []",
    "domains: []",
    "trigger_phrases: []",
    "anti_trigger_phrases: []",
    "examples: []",
    "---",
    "",
    `# ${name}`,
    "",
    "Purpose:",
    "- Define what this skill does.",
    "",
    "When to use:",
    "- List exact triggers.",
    "",
    "How to execute:",
    "1. Step 1",
    "2. Step 2",
  ].join("\n");
  await writeFile(skillPath, starter, "utf-8");

  return {
    ok: true,
    scope,
    name,
    path: targetDir,
  };
}

export async function importSkillPackage(
  projectRoot: string | null,
  body: { scope?: "user" | "project"; sourcePath?: string; name?: string },
): Promise<{ ok: true; scope: "user" | "project"; name: string; path: string }> {
  const scope = body.scope === "project" ? "project" : "user";
  const rawSourcePath = (body.sourcePath ?? "").trim();
  if (!rawSourcePath) {
    throw new SkillsServiceError(400, "sourcePath is required");
  }
  const sourcePath = resolve(rawSourcePath);
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw new SkillsServiceError(400, `sourcePath not found: ${sourcePath}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new SkillsServiceError(400, "sourcePath must be a directory");
  }

  const sourceSkillPath = join(sourcePath, "SKILL.md");
  if (!existsSync(sourceSkillPath)) {
    throw new SkillsServiceError(400, "sourcePath must contain SKILL.md");
  }

  const requestedName = (body.name ?? "").trim();
  const fallbackName = basename(sourcePath);
  const name = slugifySkillName(requestedName || fallbackName);
  if (!name) {
    throw new SkillsServiceError(400, "Invalid skill name");
  }

  const libraryRoot = resolveLibraryRoot(scope, projectRoot);
  await mkdir(libraryRoot, { recursive: true });
  const targetDir = join(libraryRoot, name);
  if (existsSync(targetDir)) {
    throw new SkillsServiceError(409, `Skill '${name}' already exists in ${scope} library`);
  }

  await cp(sourcePath, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  const targetSkillPath = join(targetDir, "SKILL.md");
  if (!existsSync(targetSkillPath)) {
    throw new SkillsServiceError(500, "Imported skill is missing SKILL.md");
  }

  return {
    ok: true,
    scope,
    name,
    path: targetDir,
  };
}

export async function readSkillWorkbench(skillId: string) {
  const normalizedSkillId = decodeURIComponent(skillId ?? "").trim();
  if (!normalizedSkillId) {
    throw new SkillsServiceError(400, "skillId is required");
  }
  return await getSkillWorkbench(normalizedSkillId);
}

export async function updateSkillEvalCases(skillId: string, cases: unknown) {
  const normalizedSkillId = decodeURIComponent(skillId ?? "").trim();
  if (!normalizedSkillId) {
    throw new SkillsServiceError(400, "skillId is required");
  }
  if (!Array.isArray(cases)) {
    throw new SkillsServiceError(400, "cases must be an array");
  }
  return await setSkillEvalCases(normalizedSkillId, cases as SkillEvalCase[]);
}

export async function updateSkillEvalFeedback(
  skillId: string,
  runId: string,
  body: { pass?: boolean; feedback?: string },
) {
  const normalizedSkillId = decodeURIComponent(skillId ?? "").trim();
  const normalizedRunId = decodeURIComponent(runId ?? "").trim();
  if (!normalizedSkillId || !normalizedRunId) {
    throw new SkillsServiceError(400, "skillId and runId are required");
  }

  return await setSkillEvalRunFeedback(normalizedSkillId, normalizedRunId, {
    pass: typeof body.pass === "boolean" ? body.pass : undefined,
    feedback: body.feedback,
  });
}

export async function runSkillWorkbenchEval(
  projectRoot: string,
  skillId: string,
  body: {
    prompt?: string;
    withSkill?: boolean;
    role?: BaseRole;
    modelTier?: "fast" | "default" | "strong";
  },
): Promise<Record<string, unknown>> {
  const normalizedSkillId = decodeURIComponent(skillId ?? "").trim();
  if (!normalizedSkillId) {
    throw new SkillsServiceError(400, "skillId is required");
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    throw new SkillsServiceError(400, "prompt is required");
  }

  const role = typeof body.role === "string" && isBaseRole(body.role) ? body.role : "planner";
  const withSkill = body.withSkill !== false;
  const modelTier = typeof body.modelTier === "string" && isModelTier(body.modelTier) ? body.modelTier : "default";

  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();
  const config = await readEffectiveConfig(projectRoot);
  const skillAliases = [normalizedSkillId, normalizedSkillId.replace(/^.+:/, "")];

  const runtime = await createRoleRuntime(
    projectRoot,
    {
      ...config,
      skills: {
        ...(config.skills ?? {}),
        enabled: withSkill,
        enabledSkills: withSkill ? skillAliases : [],
      },
    },
    {
      role,
      taskDescription: prompt,
      pinnedSkills: withSkill ? skillAliases : [],
      modelTier,
    },
    context.architecture ?? undefined,
  );

  try {
    const models = createModelSet(config);
    const output = await runRole(
      getModelForTier(models, modelTier),
      role,
      context.architecture ?? "",
      prompt,
      runtime,
    );

    const run = {
      id: randomUUID(),
      skillId: normalizedSkillId,
      prompt,
      withSkill,
      role,
      modelTier,
      output,
      createdAt: Date.now(),
    };
    const workbench = await appendSkillEvalRun(run);
    return { run, workbench };
  } finally {
    await runtime.close();
  }
}
