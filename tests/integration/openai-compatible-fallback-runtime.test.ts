import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { generateText } from "ai";
import { createModelSet } from "../../src/llm/provider.js";
import type { BenderConfig } from "../../src/state/config.js";

function baseConfig(): BenderConfig {
  return {
    llm: {
      provider: "openai-compatible",
      models: {
        fast: { provider: "openai-compatible", model: "devstral-small-2-24b-instruct-2512" },
        default: { provider: "openai-compatible", model: "devstral-small-2-24b-instruct-2512" },
        strong: { provider: "openai-compatible", model: "devstral-small-2-24b-instruct-2512" },
      },
    },
    providers: {
      "openai-compatible": {
        baseUrl: "",
      },
    },
    mcp: { enabled: false, servers: [] },
    skills: { enabled: false, enabledSkills: [], paths: [], maxChars: 12000 },
    stack: {
      template: "nextjs-saas",
      framework: "next.js",
      database: "postgres",
      orm: "drizzle",
      auth: "next-auth",
      styling: "tailwind",
      language: "typescript",
    },
    deploy: {},
    test: {},
  };
}

async function closeServer(server: HttpServer | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("openai-compatible runtime fallback", () => {
  let server: HttpServer | null = null;

  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  it("falls back to a working chat endpoint when /v1 and /responses return bad request", async () => {
    const seenPaths: string[] = [];
    server = createServer(async (req, res) => {
      seenPaths.push(String(req.url ?? ""));
      if (req.method === "POST" && req.url === "/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "devstral-small-2-24b-instruct-2512",
          choices: [
            {
              index: 0,
              message: { content: "pong" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 1,
            total_tokens: 5,
          },
        }));
        return;
      }

      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Unexpected endpoint or method. (${req.method} ${req.url})` }));
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start local mock server");
    const hostBase = `127.0.0.1:${address.port}`;

    const cfg = baseConfig();
    cfg.providers!["openai-compatible"] = {
      baseUrl: hostBase,
      modelCapabilities: {
        "devstral-small-2-24b-instruct-2512": {
          // Force the runtime to start on responses, then rely on fallback.
          apiStyle: "responses",
        },
      },
    };

    const model = createModelSet(cfg).default;
    const out = await generateText({
      model,
      prompt: "ping",
      maxOutputTokens: 16,
    });

    expect(out.text.trim()).toBe("pong");
    expect(seenPaths).toContain("/v1/responses");
    expect(seenPaths).toContain("/chat/completions");
  });
});
