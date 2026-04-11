import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";
import type { ProjectContext } from "../state/manager.js";
import { formatContextForPrompt } from "../state/manager.js";

/**
 * Generate a task plan for initial project scaffolding.
 */
export async function generateInitialPlan(
  model: LanguageModel,
  brief: string,
  architecture: string,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const context = `# Project Context\n\n## Product Brief\n\n${brief}\n\n## Architecture\n\n${architecture}`;

  return runRoleStreaming(
    model,
    "planner",
    context,
    `Create the initial implementation plan for this project. This is a greenfield project — nothing exists yet. The plan should scaffold the entire application from scratch.\n\nStart with:\n1. Project setup and configuration (package.json, tsconfig, etc.)\n2. Database schema and ORM setup\n3. Auth scaffolding\n4. Base layout and shared components\n5. Core features (one task per feature from the brief)\n6. Integration and polish\n\nFollow the exact output format specified in your instructions.`,
    onChunk,
  );
}

/**
 * Generate a task plan for a new feature/change on an existing project.
 */
export async function generateFeaturePlan(
  model: LanguageModel,
  featureDescription: string,
  architectureUpdate: string,
  existingContext: ProjectContext,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const contextStr = formatContextForPrompt(existingContext);

  return runRoleStreaming(
    model,
    "planner",
    `${contextStr}\n\n## Architecture Updates for This Feature\n\n${architectureUpdate}`,
    `Create an implementation plan for the following feature/change:\n\n"${featureDescription}"\n\nThis is an existing project. The architecture updates above describe what needs to change. Create tasks that:\n1. Build on top of the existing codebase (don't recreate what exists)\n2. Follow established patterns and conventions\n3. Include migrations for any schema changes\n4. Include tests for every feature task\n\nFollow the exact output format specified in your instructions.`,
    onChunk,
  );
}
