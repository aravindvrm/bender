import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatStore } from "../../src/state/chat.js";

const tempDirs: string[] = [];

async function makeProjectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bender-chat-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("ChatStore", () => {
  it("creates, updates, and lists threads/messages in order", async () => {
    const projectRoot = await makeProjectRoot();
    const store = new ChatStore(projectRoot);
    await store.init();

    const thread = await store.createThread({
      title: "Thread A",
      provider: "openai-compatible",
      model: "local-model",
      toolsEnabled: false,
    });

    await store.appendMessage({
      threadId: thread.id,
      provider: thread.provider,
      model: thread.model,
      toolsEnabled: thread.toolsEnabled,
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      createdAt: 100,
    });
    await store.appendMessage({
      threadId: thread.id,
      provider: thread.provider,
      model: thread.model,
      toolsEnabled: thread.toolsEnabled,
      message: {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
      createdAt: 200,
    });

    const messages = await store.listMessages(thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]?.message.role).toBe("user");
    expect(messages[1]?.message.role).toBe("assistant");

    await store.upsertThread({
      ...thread,
      model: "local-model-2",
      updatedAt: 300,
    });
    const threads = await store.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.model).toBe("local-model-2");
  });
});
