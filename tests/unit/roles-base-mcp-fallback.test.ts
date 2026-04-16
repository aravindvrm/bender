import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

import { generateText } from "ai";
import { runRoleDetailed } from "../../src/roles/base.js";

describe("roles/base MCP fallback", () => {
  const generateTextMock = vi.mocked(generateText);

  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("retries once without MCP tools/options when connector auth fails", async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error("external_connector_error: Error retrieving tool list from MCP server: 'GitHub'. Http status code: 401 (Unauthorized)"))
      .mockResolvedValueOnce({
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1 },
      } as Awaited<ReturnType<typeof generateText>>);

    const result = await runRoleDetailed(
      {} as never,
      "analyzer",
      "system context",
      "user message",
      {
        tools: { mcp_github: {} } as never,
        providerOptions: { anthropic: { mcpServers: [{ type: "url", url: "https://example.com/mcp", name: "GitHub" }] } } as never,
      },
    );

    expect(result.text).toBe("ok");
    expect(generateTextMock).toHaveBeenCalledTimes(2);

    const firstCall = generateTextMock.mock.calls[0]?.[0];
    const secondCall = generateTextMock.mock.calls[1]?.[0];
    expect(firstCall?.tools).toBeDefined();
    expect(firstCall?.providerOptions).toBeDefined();
    expect(secondCall?.tools).toBeUndefined();
    expect(secondCall?.providerOptions).toBeUndefined();
  });
});
