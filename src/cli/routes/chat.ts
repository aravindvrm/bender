import type { Express } from "express";
import {
  appendChatMessage,
  ChatServiceError,
  createChatThread,
  listChatMessages,
  listChatThreads,
  streamChatThreadResponse,
  updateChatThread,
} from "../services/chat.js";

interface ChatRouteDeps {
  getProject: () => string;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof ChatServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerChatRoutes(app: Express, deps: ChatRouteDeps): void {
  app.get("/api/chat/threads", async (_req, res) => {
    try {
      const threads = await listChatThreads(deps.getProject());
      res.json({ threads });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/chat/threads", async (req, res) => {
    try {
      const thread = await createChatThread(deps.getProject(), req.body ?? {});
      res.json({ thread });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.patch("/api/chat/threads/:threadId", async (req, res) => {
    try {
      const thread = await updateChatThread(deps.getProject(), req.params.threadId, req.body ?? {});
      res.json({ thread });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/chat/threads/:threadId/messages", async (req, res) => {
    try {
      const messages = await listChatMessages(deps.getProject(), req.params.threadId);
      res.json({ messages });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/chat/threads/:threadId/messages", async (req, res) => {
    try {
      const message = await appendChatMessage(deps.getProject(), req.params.threadId, req.body ?? {});
      res.json({ message });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/chat/threads/:threadId/respond", async (req, res) => {
    try {
      await streamChatThreadResponse(deps.getProject(), req.params.threadId, req.body ?? {}, res);
    } catch (err) {
      const mapped = toHttpError(err);
      if (!res.headersSent) {
        res.status(mapped.status).json({ error: mapped.message });
      }
    }
  });
}
