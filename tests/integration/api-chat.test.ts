import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultChatTransport, isTextUIPart, readUIMessageStream, type UIMessage } from "ai";

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve free port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function closeServer(server: HttpServer | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => isTextUIPart(part))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function startMockLocalOpenAiServer(): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = createHttpServer(async (req, res) => {
    const isChat = req.method === "POST" && req.url === "/v1/chat/completions";
    const isResponses = req.method === "POST" && req.url === "/v1/responses";
    if (isResponses) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!isChat) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payloadRaw = Buffer.concat(chunks).toString("utf-8");
    const payload = payloadRaw ? JSON.parse(payloadRaw) as { stream?: boolean } : {};

    if (payload.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Echo \"}}]}\n\n");
      res.write("data: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"from local model\"}}]}\n\n");
      res.write("data: {\"id\":\"chatcmpl_1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Echo from local model" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock OpenAI-compatible server");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

describe("api chat integration", () => {
  let tempWorkspace = "";
  let tempBenderHome = "";
  let benderServer: HttpServer | null = null;
  let mockModelServer: HttpServer | null = null;
  let baseUrl = "";
  let modelBaseUrl = "";

  beforeAll(async () => {
    tempWorkspace = await mkdtemp(join(tmpdir(), "bender-chat-int-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-chat-home-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const mock = await startMockLocalOpenAiServer();
    mockModelServer = mock.server;
    modelBaseUrl = mock.baseUrl;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    benderServer = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;

    const projectPath = join(tempWorkspace, "project-chat");
    const openRes = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    expect(openRes.ok).toBe(true);

    const configRes = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          provider: "openai-compatible",
          models: {
            fast: { provider: "openai-compatible", model: "local-chat" },
            default: { provider: "openai-compatible", model: "local-chat" },
            strong: { provider: "openai-compatible", model: "local-chat" },
          },
        },
        providers: {
          "openai-compatible": {
            baseUrl: modelBaseUrl,
            modelCapabilities: {
              "local-chat": {
                apiStyle: "chat",
                supportsStreaming: true,
                supportsJson: false,
                supportsTools: false,
              },
            },
          },
        },
        mcp: {
          enabled: false,
          servers: [],
        },
      }),
    });
    expect(configRes.ok).toBe(true);
  });

  afterAll(async () => {
    await closeServer(benderServer);
    await closeServer(mockModelServer);
    if (tempWorkspace) {
      await rm(tempWorkspace, { recursive: true, force: true });
    }
    if (tempBenderHome) {
      await rm(tempBenderHome, { recursive: true, force: true });
    }
    delete process.env.BENDER_HOME_DIR;
  });

  it("creates a thread and streams assistant output via AI SDK protocol", async () => {
    const createRes = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Smoke thread" }),
    });
    expect(createRes.ok).toBe(true);
    const createBody = await createRes.json() as { thread?: { id?: string } };
    const threadId = createBody.thread?.id;
    expect(threadId).toBeTruthy();

    const userMessage: UIMessage = {
      id: "msg_user_1",
      role: "user",
      parts: [{ type: "text", text: "hello from test" }],
    };

    const transport = new DefaultChatTransport<UIMessage>({
      api: `${baseUrl}/api/chat/threads/${encodeURIComponent(threadId ?? "")}/respond`,
    });
    const chunkStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: threadId ?? "",
      messageId: userMessage.id,
      messages: [userMessage],
      abortSignal: undefined,
    });

    let streamedAssistant: UIMessage | null = null;
    for await (const partial of readUIMessageStream<UIMessage>({ stream: chunkStream })) {
      streamedAssistant = partial;
    }

    expect(streamedAssistant?.role).toBe("assistant");
    expect(messageText(streamedAssistant as UIMessage)).toContain("Echo from local model");

    const listRes = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(threadId ?? "")}/messages`);
    expect(listRes.ok).toBe(true);
    const listBody = await listRes.json() as { messages?: UIMessage[] };
    const messages = listBody.messages ?? [];
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[messages.length - 1]?.role).toBe("assistant");
  });

  it("executes deterministic operator commands without tool-calling support", async () => {
    const createRes = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Operator thread" }),
    });
    expect(createRes.ok).toBe(true);
    const createBody = await createRes.json() as { thread?: { id?: string } };
    const threadId = createBody.thread?.id;
    expect(threadId).toBeTruthy();

    const transport = new DefaultChatTransport<UIMessage>({
      api: `${baseUrl}/api/chat/threads/${encodeURIComponent(threadId ?? "")}/respond`,
    });

    const addMessage: UIMessage = {
      id: "msg_user_add",
      role: "user",
      parts: [{ type: "text", text: "/task add title: Harden chat fallback; description: Add deterministic command path" }],
    };
    const addStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: threadId ?? "",
      messageId: addMessage.id,
      messages: [addMessage],
      abortSignal: undefined,
    });
    let addAssistant: UIMessage | null = null;
    for await (const partial of readUIMessageStream<UIMessage>({ stream: addStream })) {
      addAssistant = partial;
    }
    expect(addAssistant?.role).toBe("assistant");
    expect(messageText(addAssistant as UIMessage)).toContain("Added task");

    const listMessage: UIMessage = {
      id: "msg_user_list",
      role: "user",
      parts: [{ type: "text", text: "/task list" }],
    };
    const listStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: threadId ?? "",
      messageId: listMessage.id,
      messages: [addMessage, addAssistant as UIMessage, listMessage],
      abortSignal: undefined,
    });
    let listAssistant: UIMessage | null = null;
    for await (const partial of readUIMessageStream<UIMessage>({ stream: listStream })) {
      listAssistant = partial;
    }
    expect(listAssistant?.role).toBe("assistant");
    expect(messageText(listAssistant as UIMessage)).toContain("Current tasks");
    expect(messageText(listAssistant as UIMessage)).toContain("Harden chat fallback");
  });
});
