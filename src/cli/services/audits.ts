import { readEffectiveConfig } from "../../state/config.js";
import { createModelSet, getModelForTier } from "../../llm/provider.js";
import { createRoleRuntime } from "../../llm/runtime.js";
import { StateManager, type AuditIssue, type AuditResult } from "../../state/manager.js";
import { runRole } from "../../roles/base.js";
import { createLogger, makeAdapterSink, toLoggerOptions } from "../../logger.js";
import type { UIAdapter } from "../adapter.js";
import { getEffectiveAgentForRole } from "../../state/agents.js";

export function parseAuditResponse(rawOutput: string): { summary?: string; coverageEstimate?: string; issues?: AuditIssue[] } {
  let jsonStr = rawOutput.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  try {
    return JSON.parse(jsonStr) as { summary?: string; coverageEstimate?: string; issues?: AuditIssue[] };
  } catch {
    throw new Error("Audit returned invalid JSON. Try again.");
  }
}

export async function runAuditWorkflow(
  projectRoot: string,
  auditType: "security" | "tests",
  adapter: UIAdapter,
): Promise<void> {
  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();
  const label = auditType === "security" ? "Security audit" : "Test harness audit";

  adapter.header(`Bender ${label}`);

  if (!context.architecture) {
    throw new Error("Project needs architecture to be analyzed before auditing. Run analyze first.");
  }

  const config = await readEffectiveConfig(projectRoot);
  const logger = createLogger(
    `audit:${auditType}`,
    projectRoot,
    makeAdapterSink(adapter),
    toLoggerOptions(config.logging),
  );
  const analyzerAgent = await getEffectiveAgentForRole("analyzer");
  const runtime = await createRoleRuntime(
    projectRoot,
    config,
    {
      role: "analyzer",
      taskDescription: auditType === "security" ? "security audit vulnerability analysis" : "test harness coverage audit",
      pinnedSkills: analyzerAgent.pinnedSkills,
      mcpServerIds: analyzerAgent.mcpServerIds,
      capabilityPolicy: analyzerAgent.capabilityPolicy,
      modelTier: analyzerAgent.modelTier,
      systemPromptAddition: analyzerAgent.systemPromptAddition,
    },
    context.architecture ?? undefined,
    logger,
  );

  const roleName = auditType === "security" ? "security-auditor" : "test-auditor";
  const models = createModelSet(config);

  try {
    adapter.subheader(`Running ${label}...`);

    const systemContext = [
      context.architecture ? `## Architecture\n\n${context.architecture}` : "",
      context.schema ? `## Database Schema\n\n${context.schema}` : "",
      context.conventions ? `## Conventions\n\n${context.conventions}` : "",
    ].filter(Boolean).join("\n\n---\n\n");

    const userMessage = [
      `Audit this project's ${auditType === "security" ? "security vulnerabilities" : "test coverage and quality"}.`,
      "",
      "## Project Context",
      systemContext,
    ].join("\n");

    adapter.info(`Analyzing with ${analyzerAgent.name} (${analyzerAgent.modelTier})...`);
    const spin = adapter.spinner("Running LLM audit...");

    const model = getModelForTier(models, analyzerAgent.modelTier);
    let rawOutput = "";
    try {
      rawOutput = await runRole(
        model,
        roleName,
        systemContext,
        userMessage,
        runtime,
      );
    } catch (err) {
      spin.fail("LLM audit failed");
      throw err;
    }

    try {
      const parsed = parseAuditResponse(rawOutput);
      spin.succeed("LLM audit complete");

      const result: AuditResult = {
        type: auditType,
        runAt: Date.now(),
        summary: parsed.summary ?? "",
        coverageEstimate: parsed.coverageEstimate,
        issues: (parsed.issues ?? []).map((issue, i) => ({
          id: issue.id ?? `${auditType.toUpperCase().slice(0, 3)}-${String(i + 1).padStart(3, "0")}`,
          title: issue.title ?? "Untitled issue",
          severity: issue.severity ?? "medium",
          category: issue.category ?? "other",
          description: issue.description ?? "",
          recommendation: issue.recommendation ?? "",
          files: issue.files ?? [],
        })),
      };

      await state.writeAudit(auditType, result);
      if (result.summary) {
        adapter.info(`Summary: ${result.summary}`);
      }
      if (result.coverageEstimate) {
        adapter.info(`Coverage estimate: ${result.coverageEstimate}`);
      }
      const severityCounts = result.issues.reduce(
        (acc, issue) => {
          acc[issue.severity] += 1;
          return acc;
        },
        { low: 0, medium: 0, high: 0, critical: 0 } as Record<AuditIssue["severity"], number>,
      );
      adapter.info(
        `Severity counts: critical ${severityCounts.critical}, high ${severityCounts.high}, medium ${severityCounts.medium}, low ${severityCounts.low}`,
      );
      if (result.issues.length > 0) {
        adapter.subheader("Top findings");
        for (const issue of result.issues.slice(0, 8)) {
          const issueFiles = issue.files ?? [];
          const files = issueFiles.length > 0 ? ` [${issueFiles.join(", ")}]` : "";
          adapter.warn(`${issue.severity.toUpperCase()}: ${issue.title}${files}`);
        }
      } else {
        adapter.success("No issues reported by this audit.");
      }
      adapter.success(`${label} complete — ${result.issues.length} issue(s) found.`);
    } catch {
      spin.fail("Audit response parse failed");
      throw new Error("Audit returned invalid JSON. Try again.");
    }
  } finally {
    await runtime?.close();
  }
}
