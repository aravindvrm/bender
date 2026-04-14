import type { LanguageModel } from "ai";
import { runRoleStreaming } from "./base.js";
import type { RoleExecutionOptions } from "./base.js";

export type OfficeHoursVerdict =
  | "SHIP_NOW"
  | "SIMPLIFY_FIRST"
  | "VALIDATE_FIRST"
  | "DEFER"
  | "KILL";

const VERDICT_SET = new Set<OfficeHoursVerdict>([
  "SHIP_NOW",
  "SIMPLIFY_FIRST",
  "VALIDATE_FIRST",
  "DEFER",
  "KILL",
]);

export function parseOfficeHoursVerdict(output: string): OfficeHoursVerdict | null {
  const m = output.match(/VERDICT:\s*([A-Z_]+)/i);
  if (!m) return null;
  const verdict = m[1].toUpperCase() as OfficeHoursVerdict;
  return VERDICT_SET.has(verdict) ? verdict : null;
}

export async function runOfficeHours(
  model: LanguageModel,
  featureDescription: string,
  existingBrief: string | null,
  existingArchitecture: string | null,
  onChunk?: (chunk: string) => void,
  options?: RoleExecutionOptions,
): Promise<{ output: string; verdict: OfficeHoursVerdict | null }> {
  const contextParts: string[] = [];
  if (existingBrief?.trim()) {
    contextParts.push(`## Current Project Brief\n\n${existingBrief}`);
  }
  if (existingArchitecture?.trim()) {
    contextParts.push(`## Current Architecture\n\n${existingArchitecture}`);
  }
  if (contextParts.length === 0) {
    contextParts.push("No existing project brief or architecture was provided.");
  }

  const output = await runRoleStreaming(
    model,
    "office-hours",
    contextParts.join("\n\n"),
    `Pressure-test this idea before planning:\n\n${featureDescription}`,
    onChunk,
    options,
  );

  return {
    output,
    verdict: parseOfficeHoursVerdict(output),
  };
}
