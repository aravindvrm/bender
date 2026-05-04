import { describe, expect, it } from "vitest";
import { pickUsableThread } from "../../../src/web/src/components/ChatPanel.js";

describe("pickUsableThread", () => {
  const threads = [
    { id: "t-archived", title: "Archived", provider: "openai", model: "gpt-4o", toolsEnabled: true, archived: true, createdAt: 1, updatedAt: 1 },
    { id: "t-1", title: "Thread 1", provider: "openai", model: "gpt-4o", toolsEnabled: true, archived: false, createdAt: 2, updatedAt: 2 },
    { id: "t-2", title: "Thread 2", provider: "openai", model: "gpt-4o", toolsEnabled: true, archived: false, createdAt: 3, updatedAt: 3 },
  ];

  it("prefers the active thread when it is valid and non-archived", () => {
    const picked = pickUsableThread(threads, {
      preferredThreadId: "t-2",
      savedThreadId: "t-1",
    });
    expect(picked?.id).toBe("t-2");
  });

  it("falls back to saved thread if preferred is missing", () => {
    const picked = pickUsableThread(threads, {
      preferredThreadId: "missing",
      savedThreadId: "t-1",
    });
    expect(picked?.id).toBe("t-1");
  });

  it("ignores archived thread IDs and falls back to first active", () => {
    const picked = pickUsableThread(threads, {
      preferredThreadId: "t-archived",
      savedThreadId: "t-archived",
    });
    expect(picked?.id).toBe("t-1");
  });

  it("returns null when there are no active threads", () => {
    const picked = pickUsableThread([
      { id: "t-a", title: "Archived only", provider: "openai", model: "gpt-4o", toolsEnabled: true, archived: true, createdAt: 1, updatedAt: 1 },
    ], {
      preferredThreadId: "t-a",
      savedThreadId: "t-a",
    });
    expect(picked).toBeNull();
  });
});

