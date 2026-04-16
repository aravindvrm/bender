import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server as HttpServer } from "node:http";

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

async function startMockOpenAiServer(mode: "chat" | "responses"): Promise<{
  server: HttpServer;
  baseUrl: string;
}> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf-8");
    const payload = raw.trim().length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};

    const isChat = req.method === "POST" && req.url === "/v1/chat/completions";
    const isResponses = req.method === "POST" && req.url === "/v1/responses";

    if (mode === "chat" && isChat) {
      if (payload.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: ok\n\n");
        res.end();
        return;
      }
      if (payload.response_format) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
        return;
      }
      if (payload.tools) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "echo" } }] } }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
      return;
    }

    if (mode === "responses" && isChat) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unexpected endpoint or method. (POST /chat/completions)" }));
      return;
    }

    if (mode === "responses" && isResponses) {
      if (payload.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: ok\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", output: [] }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start mock OpenAI server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
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

describe("api /api/llm/capabilities/detect local-model coverage", () => {
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-api-llm-local-home-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await closeServer(server);
    if (tempBenderHome) {
      await rm(tempBenderHome, { recursive: true, force: true });
    }
    delete process.env.BENDER_HOME_DIR;
  });

  it("detects chat-style local model capabilities", async () => {
    const mock = await startMockOpenAiServer("chat");
    try {
      const res = await fetch(`${baseUrl}/api/llm/capabilities/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: ["local-chat-model"],
        }),
      });
      expect(res.ok).toBe(true);
      const body = await res.json() as {
        capabilities?: Record<string, { endpoint?: string; apiStyle?: string; supportsTools?: boolean; supportsJson?: boolean; supportsStreaming?: boolean }>;
      };
      const caps = body.capabilities?.["local-chat-model"];
      expect(caps?.endpoint).toBe(`${mock.baseUrl}/chat/completions`);
      expect(caps?.apiStyle).toBe("chat");
      expect(caps?.supportsTools).toBe(true);
      expect(caps?.supportsJson).toBe(true);
      expect(caps?.supportsStreaming).toBe(true);
    } finally {
      await closeServer(mock.server);
    }
  });

  it("detects responses-style local model capabilities", async () => {
    const mock = await startMockOpenAiServer("responses");
    try {
      const res = await fetch(`${baseUrl}/api/llm/capabilities/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: ["local-responses-model"],
        }),
      });
      expect(res.ok).toBe(true);
      const body = await res.json() as {
        capabilities?: Record<string, { endpoint?: string; apiStyle?: string; supportsTools?: boolean; supportsJson?: boolean; supportsStreaming?: boolean }>;
      };
      const caps = body.capabilities?.["local-responses-model"];
      expect(caps?.endpoint).toBe(`${mock.baseUrl}/responses`);
      expect(caps?.apiStyle).toBe("responses");
      expect(caps?.supportsTools).toBe(false);
      expect(caps?.supportsJson).toBe(false);
      expect(caps?.supportsStreaming).toBe(true);
    } finally {
      await closeServer(mock.server);
    }
  });
});
