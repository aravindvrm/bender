import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BenderConfig } from "../../src/state/config.js";

const mockChatModel = { provider: "openai-compatible", modelId: "chat-model" } as never;
const mockResponsesModel = { provider: "openai-compatible", modelId: "responses-model" } as never;
const openAiCallSpy = vi.hoisted(() => vi.fn(() => ({ provider: "openai", modelId: "default-model" } as never)));
const openAiChatSpy = vi.hoisted(() => vi.fn(() => mockChatModel));
const openAiResponsesSpy = vi.hoisted(() => vi.fn(() => mockResponsesModel));
const createOpenAiSpy = vi.hoisted(() => vi.fn(() => Object.assign(openAiCallSpy, { chat: openAiChatSpy, responses: openAiResponsesSpy })));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAiSpy,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({}) as never)),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({}) as never)),
}));

import { createModelSet } from "../../src/llm/provider.js";

describe("openai-compatible model wiring", () => {
  beforeEach(() => {
    createOpenAiSpy.mockClear();
    openAiCallSpy.mockClear();
    openAiChatSpy.mockClear();
    openAiResponsesSpy.mockClear();
  });

  it("uses chat-completions mode when endpoint hint is chat", () => {
    const config: BenderConfig = {
      llm: {
        provider: "openai-compatible",
        models: {
          fast: "fast-local",
          default: "default-local",
          strong: "strong-local",
        },
      },
      providers: {
        "openai-compatible": {
          baseUrl: "100.102.218.63:7070",
          apiKey: "",
          modelCapabilities: {
            "fast-local": { endpoint: "http://100.102.218.63:7070/chat/completions", apiStyle: "chat" },
            "default-local": { endpoint: "http://100.102.218.63:7070/chat/completions", apiStyle: "chat" },
            "strong-local": { endpoint: "http://100.102.218.63:7070/chat/completions", apiStyle: "chat" },
          },
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

    createModelSet(config);

    expect(createOpenAiSpy).toHaveBeenCalled();
    const firstCall = createOpenAiSpy.mock.calls[0]?.[0];
    expect(firstCall?.baseURL).toBe("http://100.102.218.63:7070");

    expect(openAiCallSpy).not.toHaveBeenCalled();
    expect(openAiResponsesSpy).not.toHaveBeenCalled();
    expect(openAiChatSpy).toHaveBeenCalledTimes(3);
    expect(openAiChatSpy).toHaveBeenNthCalledWith(1, "fast-local");
    expect(openAiChatSpy).toHaveBeenNthCalledWith(2, "default-local");
    expect(openAiChatSpy).toHaveBeenNthCalledWith(3, "strong-local");
  });

  it("uses responses mode when endpoint hint is responses", () => {
    const config: BenderConfig = {
      llm: {
        provider: "openai-compatible",
        models: {
          fast: "fast-local",
          default: "default-local",
          strong: "strong-local",
        },
      },
      providers: {
        "openai-compatible": {
          baseUrl: "http://localhost:1234",
          apiKey: "",
          modelCapabilities: {
            "fast-local": { endpoint: "http://localhost:1234/v1/responses", apiStyle: "responses" },
            "default-local": { endpoint: "http://localhost:1234/v1/responses", apiStyle: "responses" },
            "strong-local": { endpoint: "http://localhost:1234/v1/responses", apiStyle: "responses" },
          },
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

    createModelSet(config);

    expect(createOpenAiSpy).toHaveBeenCalled();
    const firstCall = createOpenAiSpy.mock.calls[0]?.[0];
    expect(firstCall?.baseURL).toBe("http://localhost:1234/v1");
    expect(openAiCallSpy).not.toHaveBeenCalled();
    expect(openAiChatSpy).not.toHaveBeenCalled();
    expect(openAiResponsesSpy).toHaveBeenCalledTimes(3);
  });

  it("defaults to chat mode when openai-compatible style is unknown", () => {
    const config: BenderConfig = {
      llm: {
        provider: "openai-compatible",
        models: {
          fast: "fast-local",
          default: "default-local",
          strong: "strong-local",
        },
      },
      providers: {
        "openai-compatible": {
          baseUrl: "100.102.218.63:7070",
          apiKey: "",
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

    createModelSet(config);

    expect(createOpenAiSpy).toHaveBeenCalled();
    const firstCall = createOpenAiSpy.mock.calls[0]?.[0];
    expect(firstCall?.baseURL).toBe("http://100.102.218.63:7070/v1");
    expect(openAiCallSpy).not.toHaveBeenCalled();
    expect(openAiResponsesSpy).not.toHaveBeenCalled();
    expect(openAiChatSpy).toHaveBeenCalledTimes(3);
  });

  it("falls back from chat to responses when chat endpoint is rejected", async () => {
    const chatGenerate = vi.fn(async () => {
      throw new Error("Unexpected endpoint or method. (POST /chat/completions)");
    });
    const responsesGenerate = vi.fn(async () => ({ text: "ok" }));
    const chatStream = vi.fn(async () => {
      throw new Error("Unexpected endpoint or method. (POST /chat/completions)");
    });
    const responsesStream = vi.fn(async () => ({ stream: "ok" }));

    openAiChatSpy.mockImplementation(() => ({
      provider: "openai-compatible",
      modelId: "chat-model",
      doGenerate: chatGenerate,
      doStream: chatStream,
    }) as never);
    openAiResponsesSpy.mockImplementation(() => ({
      provider: "openai-compatible",
      modelId: "responses-model",
      doGenerate: responsesGenerate,
      doStream: responsesStream,
    }) as never);

    const config: BenderConfig = {
      llm: {
        provider: "openai-compatible",
        models: {
          fast: "fast-local",
          default: "default-local",
          strong: "strong-local",
        },
      },
      providers: {
        "openai-compatible": {
          baseUrl: "http://localhost:1234/v1",
          apiKey: "",
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

    const models = createModelSet(config);
    const generated = await (models.default as { doGenerate: (options: unknown) => Promise<unknown> }).doGenerate({});
    expect(generated).toEqual({ text: "ok" });
    expect(chatGenerate).toHaveBeenCalledTimes(1);
    expect(responsesGenerate).toHaveBeenCalledTimes(1);
  });

  it("uses provider-level API keys for mixed tier providers", () => {
    const config: BenderConfig = {
      llm: {
        provider: "openai-compatible",
        models: {
          fast: { provider: "openai", model: "gpt-5.4-mini" },
          default: "default-local",
          strong: "strong-local",
        },
      },
      providers: {
        openai: {
          apiKey: "sk-tier-key",
        },
        "openai-compatible": {
          baseUrl: "http://localhost:1234/v1",
          apiKey: "",
          modelCapabilities: {
            "default-local": { endpoint: "http://localhost:1234/v1/chat/completions", apiStyle: "chat" },
            "strong-local": { endpoint: "http://localhost:1234/v1/chat/completions", apiStyle: "chat" },
          },
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

    const models = createModelSet(config);
    expect(models.fast).toBeTruthy();
    expect(openAiCallSpy).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(
      createOpenAiSpy.mock.calls.some(([opts]) => (opts as { apiKey?: string })?.apiKey === "sk-tier-key"),
    ).toBe(true);
  });
});
