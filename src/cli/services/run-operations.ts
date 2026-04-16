import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { addToRegistry } from "../../state/registry.js";
import { readEffectiveConfig, writeConfig } from "../../state/config.js";
import { StateManager } from "../../state/manager.js";
import { createModelSet, getModelForTier } from "../../llm/provider.js";
import { createRoleRuntime } from "../../llm/runtime.js";
import { getEffectiveAgentForRole } from "../../state/agents.js";
import { initCommand } from "../init.js";
import { planCommand } from "../plan.js";
import { implementCommand, implementSingleTask } from "../implement.js";
import { analyzeCommand } from "../analyze.js";
import { generateFlows } from "../../roles/flowcharter.js";
import { createLogger, makeAdapterSink, toLoggerOptions } from "../../logger.js";
import type { UIAdapter } from "../adapter.js";

interface RunInitDeps {
  getProject: () => string;
  setCurrentProject: (path: string) => void;
  normalizeUserPath: (input?: string) => string;
}

export async function runInitOperation(
  deps: RunInitDeps,
  input: {
    description?: string;
    path?: string;
    template?: "nextjs-saas" | "express-api" | "auto";
    llmProvider?: "anthropic" | "openai" | "google" | "groq" | "ollama" | "openai-compatible";
    llmApiKey?: string;
  },
  adapter: UIAdapter,
): Promise<void> {
  const {
    description,
    path: requestedPath,
    template,
    llmProvider,
    llmApiKey,
  } = input;

  let projectRoot: string;
  if (requestedPath?.trim()) {
    projectRoot = deps.normalizeUserPath(requestedPath);
    if (!existsSync(projectRoot)) {
      await mkdir(projectRoot, { recursive: true });
    } else {
      const rootStat = await stat(projectRoot);
      if (!rootStat.isDirectory()) {
        throw new Error("Selected path is not a directory.");
      }
    }
  } else {
    projectRoot = deps.getProject();
  }

  deps.setCurrentProject(projectRoot);

  const initialConfig = await readEffectiveConfig(projectRoot);
  let shouldWriteConfig = false;
  const nextConfig = {
    ...initialConfig,
    llm: { ...initialConfig.llm },
    providers: { ...(initialConfig.providers ?? {}) },
    stack: { ...initialConfig.stack },
  };

  if (template && template !== "auto") {
    nextConfig.stack.template = template;
    if (template === "nextjs-saas") {
      nextConfig.stack.framework = "next.js";
    } else if (template === "express-api") {
      nextConfig.stack.framework = "express";
    }
    shouldWriteConfig = true;
  }

  if (llmProvider) {
    nextConfig.llm.provider = llmProvider;
    if (llmApiKey?.trim() && llmProvider !== "ollama") {
      nextConfig.providers[llmProvider] = { apiKey: llmApiKey.trim() };
    }
    shouldWriteConfig = true;
  }

  if (shouldWriteConfig) {
    await writeConfig(projectRoot, nextConfig);
  }

  let firstPrompt = true;
  const originalPrompt = adapter.promptMultiline.bind(adapter);
  adapter.promptMultiline = async (question: string) => {
    if (firstPrompt && description) {
      firstPrompt = false;
      adapter.info(`> ${description}`);
      return description;
    }
    return originalPrompt(question);
  };

  await initCommand(projectRoot, adapter);
  await addToRegistry(projectRoot);
}

export async function runPlanOperation(
  projectRoot: string,
  input: {
    feature?: string;
    role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
    agentId?: string;
    officeHoursMode?: "pressure-test" | "execution-plan";
    askClarifyingQuestions?: boolean;
    requireArchitectureApproval?: boolean;
    requirePlanApproval?: boolean;
  },
  adapter: UIAdapter,
): Promise<void> {
  if (!input.feature) {
    throw new Error("feature is required");
  }

  await planCommand(projectRoot, input.feature, adapter, {
    role: input.role,
    agentId: input.agentId,
    officeHoursMode: input.officeHoursMode,
    askClarifyingQuestions: input.askClarifyingQuestions,
    requireArchitectureApproval: input.requireArchitectureApproval,
    requirePlanApproval: input.requirePlanApproval,
  });
}

export async function runImplementOperation(
  projectRoot: string,
  input: { taskId?: number },
  adapter: UIAdapter,
): Promise<void> {
  if (input.taskId !== undefined) {
    await implementSingleTask(projectRoot, Number(input.taskId), adapter);
    return;
  }
  await implementCommand(projectRoot, adapter);
}

export async function runAnalyzeOperation(projectRoot: string, adapter: UIAdapter): Promise<void> {
  await analyzeCommand(projectRoot, adapter);
}

export async function runFlowsOperation(projectRoot: string, adapter: UIAdapter): Promise<void> {
  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();

  if (!context.brief || !context.architecture) {
    throw new Error("Project needs a brief and architecture before flows can be generated. Run init or analyze first.");
  }

  let runtime;
  let architectTier: "fast" | "default" | "strong" = "default";
  let architectAgentName = "Eng Review";

  try {
    const config = await readEffectiveConfig(projectRoot);
    const logger = createLogger(
      "flows",
      projectRoot,
      makeAdapterSink(adapter),
      toLoggerOptions(config.logging),
    );
    const models = createModelSet(config);
    const architectAgent = await getEffectiveAgentForRole("architect");
    architectTier = architectAgent.modelTier;
    architectAgentName = architectAgent.name;
    runtime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "architect",
        pinnedSkills: architectAgent.pinnedSkills,
        mcpServerIds: architectAgent.mcpServerIds,
        capabilityPolicy: architectAgent.capabilityPolicy,
        modelTier: architectAgent.modelTier,
        systemPromptAddition: architectAgent.systemPromptAddition,
      },
      context.architecture ?? undefined,
      logger,
    );

    adapter.subheader("Generating user flow diagrams...");
    adapter.info(`Using agent: ${architectAgentName} (${architectTier})`);

    const flows = await generateFlows(
      getModelForTier(models, architectTier),
      context.brief,
      context.architecture,
      context.schema,
      adapter.streamWriter(),
      runtime,
    );

    await state.writeFlows(flows);
    adapter.success("Flow diagrams saved to .bender/flows.md");
  } catch (err: unknown) {
    if ((err as Error)?.message?.startsWith("Missing API key")) {
      throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    }
    if ((err as Error)?.message?.startsWith("Failed to initialize LLM provider:")) {
      throw err;
    }
    if ((err as Error).message.includes("Missing API key")) {
      throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    await runtime?.close();
  }
}
