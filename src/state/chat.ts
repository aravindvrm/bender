import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { LocalProjectDb } from "./local-db.js";

const NS_THREAD = "chat.thread";
const NS_MESSAGE = "chat.message";

function nowTs(): number {
  return Date.now();
}

function normalizeLimit(limit = 500): number {
  if (!Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(10_000, Math.floor(limit)));
}

export type LlmProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "ollama"
  | "openai-compatible";

export interface ChatThread {
  id: string;
  title: string;
  provider: LlmProvider;
  model: string;
  toolsEnabled: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessageRecord {
  id: string;
  threadId: string;
  provider: LlmProvider;
  model: string;
  toolsEnabled: boolean;
  message: UIMessage;
  createdAt: number;
  updatedAt: number;
}

function messageRecordDbId(threadId: string, messageId: string): string {
  return `${threadId}:${messageId}`;
}

export class ChatStore {
  private readonly db: LocalProjectDb;

  constructor(projectRoot: string) {
    this.db = LocalProjectDb.forProject(projectRoot);
  }

  async init(): Promise<void> {
    await this.db.init();
  }

  async listThreads(options?: { includeArchived?: boolean; limit?: number }): Promise<ChatThread[]> {
    const includeArchived = options?.includeArchived === true;
    const threads = this.db.listRecords<ChatThread>(NS_THREAD, {
      limit: normalizeLimit(options?.limit ?? 200),
      orderBy: "updated_at",
      desc: true,
    });
    return threads
      .filter((thread) => typeof thread?.id === "string")
      .filter((thread) => includeArchived || !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getThread(threadId: string): Promise<ChatThread | null> {
    return this.db.getRecord<ChatThread>(NS_THREAD, threadId);
  }

  async upsertThread(thread: ChatThread): Promise<void> {
    this.db.upsertRecord(NS_THREAD, thread.id, thread, {
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }

  async createThread(input: {
    title: string;
    provider: LlmProvider;
    model: string;
    toolsEnabled?: boolean;
  }): Promise<ChatThread> {
    const ts = nowTs();
    const thread: ChatThread = {
      id: randomUUID(),
      title: input.title,
      provider: input.provider,
      model: input.model,
      toolsEnabled: input.toolsEnabled !== false,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.upsertThread(thread);
    return thread;
  }

  async listMessages(threadId: string, options?: { limit?: number }): Promise<ChatMessageRecord[]> {
    const all = this.db.listRecords<ChatMessageRecord>(NS_MESSAGE, {
      limit: normalizeLimit(options?.limit ?? 2_000),
      orderBy: "created_at",
      desc: false,
    });
    return all
      .filter((record) => record.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async hasMessage(threadId: string, messageId: string): Promise<boolean> {
    const key = messageRecordDbId(threadId, messageId);
    return this.db.getRecord<ChatMessageRecord>(NS_MESSAGE, key) !== null;
  }

  async upsertMessage(record: ChatMessageRecord): Promise<void> {
    this.db.upsertRecord(NS_MESSAGE, messageRecordDbId(record.threadId, record.id), record, {
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async appendMessage(input: {
    threadId: string;
    provider: LlmProvider;
    model: string;
    toolsEnabled: boolean;
    message: UIMessage;
    createdAt?: number;
  }): Promise<ChatMessageRecord> {
    const ts = input.createdAt ?? nowTs();
    const record: ChatMessageRecord = {
      id: input.message.id,
      threadId: input.threadId,
      provider: input.provider,
      model: input.model,
      toolsEnabled: input.toolsEnabled,
      message: input.message,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.upsertMessage(record);
    return record;
  }

  async touchThread(threadId: string): Promise<void> {
    const thread = await this.getThread(threadId);
    if (!thread) return;
    await this.upsertThread({
      ...thread,
      updatedAt: nowTs(),
    });
  }
}
