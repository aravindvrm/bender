import { randomUUID } from "node:crypto";
import { readEffectiveConfig } from "../../state/config.js";
import { fetchRegistry, readRegistry as readSkillsRegistry } from "../../state/skills.js";
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

const BASE_ROLES: BaseRole[] = ["analyzer", "architect", "planner", "implementer", "reviewer"];
const MODEL_TIERS = ["fast", "default", "strong"] as const;

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
