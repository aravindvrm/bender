import type { Express } from "express";
import type { AgentConfig } from "../../state/agents.js";
import {
  AgentsServiceError,
  createAgent,
  deleteAgent,
  listAgents,
  listPromptSnippets,
  listRoleSelections,
  updateAgent,
  updateRoleSelection,
} from "../services/agents.js";

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof AgentsServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerAgentRoutes(app: Express): void {
  app.get("/api/agents", async (_req, res) => {
    try {
      res.json(await listAgents());
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/agents/selection", async (_req, res) => {
    try {
      res.json(await listRoleSelections());
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/agents/selection/:role", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { agentId?: string | null };
      res.json({ ok: true, ...(await updateRoleSelection(req.params.role, body.agentId)) });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/agents/prompt-snippets", async (_req, res) => {
    try {
      res.json(await listPromptSnippets());
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/agents", async (req, res) => {
    try {
      res.json(await createAgent((req.body ?? {}) as Partial<AgentConfig>));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/agents/:id", async (req, res) => {
    try {
      res.json(await updateAgent(req.params.id, (req.body ?? {}) as Partial<AgentConfig>));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    try {
      res.json(await deleteAgent(req.params.id));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
