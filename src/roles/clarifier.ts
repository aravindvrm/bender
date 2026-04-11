import type { LanguageModel } from "ai";
import { runConversationalRole, runRoleStreaming } from "./base.js";
import type { ProjectContext } from "../state/manager.js";
import { formatContextForPrompt } from "../state/manager.js";

/**
 * Run the clarification flow: ask questions, then produce a brief.
 *
 * Phase 1: Generate clarifying questions based on user's description
 * Phase 2: After receiving answers, generate the structured product brief
 */
export async function generateClarifyingQuestions(
  model: LanguageModel,
  userDescription: string,
  existingContext: ProjectContext | null,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const context = existingContext
    ? formatContextForPrompt(existingContext)
    : "This is a brand new project. No existing context.";

  return runRoleStreaming(
    model,
    "clarifier",
    context,
    `The user wants to build the following:\n\n"${userDescription}"\n\nAsk 3-7 targeted clarifying questions. Number each question. Be specific about what information you need and why it matters for implementation decisions.`,
    onChunk,
  );
}

/**
 * Generate the structured product brief after clarification.
 */
export async function generateBrief(
  model: LanguageModel,
  userDescription: string,
  clarificationQA: { role: "user" | "assistant"; content: string }[],
  existingContext: ProjectContext | null,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const context = existingContext
    ? formatContextForPrompt(existingContext)
    : "This is a brand new project. No existing context.";

  const messages: { role: "user" | "assistant"; content: string }[] = [
    {
      role: "user",
      content: `The user wants to build the following:\n\n"${userDescription}"\n\nAsk clarifying questions.`,
    },
    ...clarificationQA,
    {
      role: "user",
      content: "Based on the original description and the clarification answers above, produce the structured product brief. Follow the exact output format specified in your instructions.",
    },
  ];

  return runConversationalRole(model, "clarifier", context, messages, onChunk);
}
