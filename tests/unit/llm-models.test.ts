import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectOpenAiCompatibleCapabilities } from "../../src/cli/services/llm-models.js";

const encoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(status = 200): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: ok\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("cli/services/llm-models", () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("detects chat-completions capability profile", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (!url.endsWith("/v1/chat/completions")) {
        return jsonResponse({ error: "unexpected endpoint" }, 404);
      }
      if (payload.messages && (payload.messages as Array<{ content?: string }>)[0]?.content === "ping") {
        return jsonResponse({ choices: [{ message: { content: "pong" } }] });
      }
      if (payload.stream === true) {
        return streamResponse();
      }
      if (payload.response_format) {
        return jsonResponse({ choices: [{ message: { content: "{\"ok\":true}" } }] });
      }
      if (payload.tools) {
        return jsonResponse({ choices: [{ message: { tool_calls: [{ function: { name: "echo" } }] } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    const result = await detectOpenAiCompatibleCapabilities("http://localhost:1234/v1", ["chat-model"]);
    const caps = result["chat-model"];

    expect(caps).toBeDefined();
    expect(caps.apiStyle).toBe("chat");
    expect(caps.endpoint).toBe("http://localhost:1234/v1/chat/completions");
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsJson).toBe(true);
    expect(caps.supportsTools).toBe(true);
  });

  it("falls back to responses profile when chat endpoint is unsupported", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.endsWith("/v1/chat/completions")) {
        // Some local servers return 200 with an error envelope for unsupported endpoints.
        return jsonResponse({ error: "Unexpected endpoint or method. (POST /chat/completions)" }, 200);
      }
      if (url.endsWith("/v1/responses")) {
        if (payload.stream === true) return streamResponse();
        return jsonResponse({ id: "resp_1", output: [] });
      }
      return jsonResponse({ error: "unexpected endpoint" }, 404);
    });

    const result = await detectOpenAiCompatibleCapabilities("http://localhost:1234/v1", ["responses-model"]);
    const caps = result["responses-model"];

    expect(caps).toBeDefined();
    expect(caps.apiStyle).toBe("responses");
    expect(caps.endpoint).toBe("http://localhost:1234/v1/responses");
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsJson).toBe(false);
    expect(caps.supportsTools).toBe(false);
  });
});
