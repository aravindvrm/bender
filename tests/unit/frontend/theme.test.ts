// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { applyBenderTheme } from "../../../src/web/src/theme.js";
import type { BenderThemePayload } from "../../../src/web/src/theme.js";

function makeTheme(overrides: Partial<BenderThemePayload> = {}): BenderThemePayload {
  return {
    id: "test-theme",
    appearance: "dark",
    ui: {
      colors: {
        appBg: "#111",
        panelBg: "#222",
        accent: "#3b82f6",
        success: "#22c55e",
        danger: "#ef4444",
        warning: "#f59e0b",
        textPrimary: "#f4f4f5",
        textSecondary: "#a1a1aa",
        textMuted: "#71717a",
        textInverse: "#000",
        borderDefault: "#27272a",
        borderMuted: "#18181b",
        borderStrong: "#3f3f46",
      },
      radius: {
        sm: "4px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
    },
    ...overrides,
  };
}

describe("applyBenderTheme", () => {
  beforeEach(() => {
    // Reset applied styles between tests
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.benderTheme;
  });

  it("sets CSS custom properties on document root", () => {
    applyBenderTheme(makeTheme());

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--bender-app-bg")).toBe("#111");
    expect(style.getPropertyValue("--bender-panel-bg")).toBe("#222");
    expect(style.getPropertyValue("--bender-accent")).toBe("#3b82f6");
    expect(style.getPropertyValue("--bender-success")).toBe("#22c55e");
    expect(style.getPropertyValue("--bender-danger")).toBe("#ef4444");
  });

  it("sets radius variables", () => {
    applyBenderTheme(makeTheme());

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--bender-radius-sm")).toBe("4px");
    expect(style.getPropertyValue("--bender-radius-md")).toBe("8px");
    expect(style.getPropertyValue("--bender-radius-lg")).toBe("12px");
    expect(style.getPropertyValue("--bender-radius-xl")).toBe("16px");
  });

  it("sets color-scheme and data-bender-theme attribute", () => {
    applyBenderTheme(makeTheme({ appearance: "light", id: "my-light" }));

    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
    expect(document.documentElement.dataset.benderTheme).toBe("my-light");
  });

  it("does not throw and does nothing when ui.colors is missing", () => {
    const badTheme = { id: "bad", appearance: "dark" } as unknown as BenderThemePayload;
    expect(() => applyBenderTheme(badTheme)).not.toThrow();
    // No properties should be set
    expect(document.documentElement.style.getPropertyValue("--bender-app-bg")).toBe("");
  });

  it("applies legacy zinc overrides", () => {
    const theme = makeTheme();
    theme.ui.legacy = { zinc: { "900": "#0a0a0a", "950": "#050505" } };
    applyBenderTheme(theme);

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-zinc-900")).toBe("#0a0a0a");
    expect(style.getPropertyValue("--color-zinc-950")).toBe("#050505");
  });

  it("skips legacy zinc keys that are not 2-3 digit numbers", () => {
    const theme = makeTheme();
    theme.ui.legacy = { zinc: { "invalid": "#bad", "99": "#valid", "1000": "#also-bad" } };
    applyBenderTheme(theme);

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-zinc-invalid")).toBe("");
    expect(style.getPropertyValue("--color-zinc-99")).toBe("#valid");
    expect(style.getPropertyValue("--color-zinc-1000")).toBe("");
  });
});
