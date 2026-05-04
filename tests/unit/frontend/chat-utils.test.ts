import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { toolDisplayName, relativeTime } from "../../../src/web/src/components/ChatPanel.js";

describe("toolDisplayName", () => {
  it("strips bender_ prefix", () => {
    expect(toolDisplayName("bender_read_file")).toBe("read file");
    expect(toolDisplayName("bender_run_tests")).toBe("run tests");
  });

  it("replaces underscores with spaces", () => {
    expect(toolDisplayName("some_tool_name")).toBe("some tool name");
  });

  it("handles names without prefix", () => {
    expect(toolDisplayName("bash")).toBe("bash");
  });

  it("handles empty string", () => {
    expect(toolDisplayName("")).toBe("");
  });
});

describe("relativeTime", () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps within the last minute", () => {
    expect(relativeTime(now - 30_000)).toBe("just now");
    expect(relativeTime(now)).toBe("just now");
    expect(relativeTime(now - 59_000)).toBe("just now");
  });

  it("returns minutes ago for 1–59 minutes", () => {
    expect(relativeTime(now - 60_000)).toBe("1m ago");
    expect(relativeTime(now - 30 * 60_000)).toBe("30m ago");
    expect(relativeTime(now - 59 * 60_000)).toBe("59m ago");
  });

  it("returns hours ago for 1–23 hours", () => {
    expect(relativeTime(now - 3_600_000)).toBe("1h ago");
    expect(relativeTime(now - 12 * 3_600_000)).toBe("12h ago");
    expect(relativeTime(now - 23 * 3_600_000)).toBe("23h ago");
  });

  it("returns days ago for 1–6 days", () => {
    expect(relativeTime(now - 86_400_000)).toBe("1d ago");
    expect(relativeTime(now - 6 * 86_400_000)).toBe("6d ago");
  });

  it("returns a locale date string for timestamps older than 7 days", () => {
    const ts = now - 8 * 86_400_000;
    const result = relativeTime(ts);
    // Should be a date string, not a relative label
    expect(result).not.toMatch(/ago|just now/);
    expect(result.length).toBeGreaterThan(3);
  });
});
