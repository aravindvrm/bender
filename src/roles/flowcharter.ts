import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";
import type { RoleExecutionOptions } from "./base.js";

/**
 * Generate Mermaid flow diagrams for the project's key user flows.
 */
export async function generateFlows(
  model: LanguageModel,
  brief: string,
  architecture: string,
  schema: string | null,
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<string> {
  const context = [
    `## Product Brief\n\n${brief}`,
    `## Architecture\n\n${architecture}`,
    schema ? `## Database Schema\n\`\`\`sql\n${schema}\n\`\`\`` : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  return runRoleStreaming(
    model,
    "flowcharter",
    context,
    "Generate the key user flow diagrams for this product. Cover the most important journeys a user takes through the system.",
    onChunk,
    options,
  );
}
