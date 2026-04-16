import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

import { generateText, streamText } from "ai";
import { runRoleStreaming } from "../../src/roles/base.js";

describe("roles/base streaming fallback", () => {
  const generateTextMock = vi.mocked(generateText);
  const streamTextMock = vi.mocked(streamText);

  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
  });

  it("falls back to non-streaming call when stream completes empty", async () => {
    streamTextMock.mockReturnValue({
      textStream: (async function* empty() {})(),
      text: Promise.resolve(""),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
    } as Awaited<ReturnType<typeof streamText>>);

    generateTextMock.mockResolvedValue({
      text: "fallback response",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as Awaited<ReturnType<typeof generateText>>);

    const chunks: string[] = [];
    const result = await runRoleStreaming(
      {} as never,
      "analyzer",
      "system context",
      "user message",
      (chunk) => chunks.push(chunk),
    );

    expect(result).toBe("fallback response");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(chunks.join("")).toBe("fallback response");
  });
});
