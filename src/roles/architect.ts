import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";
import type { ProjectContext } from "../state/manager.js";
import { formatContextForPrompt } from "../state/manager.js";
import type { BenderConfig } from "../state/config.js";
import type { RoleExecutionOptions } from "./base.js";

/**
 * Generate an architecture document based on the product brief.
 */
export async function generateArchitecture(
  model: LanguageModel,
  brief: string,
  config: BenderConfig,
  existingContext: ProjectContext | null,
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<string> {
  const contextStr = existingContext
    ? formatContextForPrompt(existingContext)
    : "This is a brand new project. No existing architecture.";

  const stackConstraints = `
## Stack Constraints (from project config)
- Framework: ${config.stack.framework}
- Language: ${config.stack.language}
- Database: ${config.stack.database}
- ORM: ${config.stack.orm}
- Auth: ${config.stack.auth}
- Styling: ${config.stack.styling}

Work within these constraints. If the brief requires something the stack doesn't support well, explain the limitation and suggest the best approach within these constraints.`;

  return runRoleStreaming(
    model,
    "architect",
    `${contextStr}\n\n${stackConstraints}`,
    `Here is the product brief:\n\n${brief}\n\nProduce a complete architecture document following the exact format specified in your instructions. Include complete SQL schema, all API routes, full file structure, key design decisions, complexity gate, auth flow, and coding conventions.`,
    onChunk,
    options,
  );
}

/**
 * Update architecture for a new feature on an existing project.
 */
export async function updateArchitecture(
  model: LanguageModel,
  featureDescription: string,
  config: BenderConfig,
  existingContext: ProjectContext,
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<{ architectureUpdate: string; schemaMigration: string | null }> {
  const contextStr = formatContextForPrompt(existingContext);

  const result = await runRoleStreaming(
    model,
    "architect",
    contextStr,
    `A new feature/change has been requested:\n\n"${featureDescription}"\n\nThe project already has an established architecture (shown in context above). Produce:\n\n1. **Architecture updates**: What changes to the architecture document are needed? Show only the sections that change.\n2. **Complexity gate**: Include a line in the form "GATE: PASS | SIMPLIFY | VALIDATE | BLOCKED" and list prerequisites if not PASS.\n3. **Schema migration**: If the database schema needs changes, provide the migration SQL (ALTER TABLE, CREATE TABLE, etc.), not a full schema rewrite. If no schema changes are needed, say "No schema changes required."\n4. **New API routes**: Any new routes needed.\n5. **New conventions**: Any new conventions needed.\n6. **Decision record**: Create an ADR for any significant architectural decisions.\n\nBe precise about what changes vs. what stays the same.`,
    onChunk,
    options,
  );

  // Parse out migration if present
  const migrationMatch = result.match(/```sql\n([\s\S]*?)```/);
  const schemaMigration = migrationMatch ? migrationMatch[1].trim() : null;

  return { architectureUpdate: result, schemaMigration };
}
