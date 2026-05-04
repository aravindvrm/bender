import { describe, expect, it } from "vitest";
import { formatTokenCount, shortenModelName } from "../../../src/web/src/components/Sidebar.js";

describe("formatTokenCount", () => {
  it("returns raw number for small counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(42_500)).toBe("43k");
    expect(formatTokenCount(999_999)).toBe("1000k");
  });

  it("formats millions with M suffix and one decimal", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
    expect(formatTokenCount(12_345_678)).toBe("12.3M");
  });
});

describe("shortenModelName", () => {
  it("strips trailing date suffix", () => {
    expect(shortenModelName("claude-sonnet-4-5-20250930")).toBe("claude-sonnet-4-5");
  });

  it("strips trailing 4-digit build suffix", () => {
    expect(shortenModelName("devstral-small-2512")).toBe("devstral-small");
  });

  it("strips -instruct suffix", () => {
    expect(shortenModelName("devstral-small-2-24b-instruct-2512")).toBe("devstral-small-2-24b");
  });

  it("strips -preview suffix", () => {
    expect(shortenModelName("gpt-4o-preview")).toBe("gpt-4o");
  });

  it("leaves clean names unchanged", () => {
    expect(shortenModelName("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(shortenModelName("claude-opus-4")).toBe("claude-opus-4");
    expect(shortenModelName("—")).toBe("—");
  });

  it("returns the name unchanged if stripping yields empty string", () => {
    expect(shortenModelName("preview")).toBe("preview");
  });
});
