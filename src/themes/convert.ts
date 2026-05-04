/**
 * Pure VS Code → BenderTheme conversion utilities.
 * No imports from other theme files — safe to import from anywhere without
 * creating circular dependency chains.
 */
import { benderThemeSchema, type BenderTheme } from "./types.js";

export interface ImportVsCodeThemeResult {
  theme: BenderTheme;
  warnings: string[];
}

export interface ImportVsCodeThemeParams {
  payload: unknown;
  id?: string;
  name?: string;
  author?: string;
}

// ── Colour helpers ────────────────────────────────────────────────────────────

export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value) return null;
  const prefixed = value.startsWith("#") ? value : `#${value}`;
  const shortMatch = prefixed.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4})$/);
  if (shortMatch) {
    const chars = shortMatch[1].split("");
    return `#${chars.map((c) => `${c}${c}`).join("")}`.toLowerCase();
  }
  const longMatch = prefixed.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (longMatch) return `#${longMatch[1].toLowerCase()}`;
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) return null;
  const parts = rgbMatch[1].split(",").map((p) => p.trim());
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map(Number);
  if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return null;
  const hex3 = [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  if (parts.length < 4) return `#${hex3}`;
  const a = Math.max(0, Math.min(1, Number(parts[3])));
  if (!Number.isFinite(a)) return null;
  return `#${hex3}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHexColor(hex);
  if (!n) return null;
  const v = n.slice(1, 7);
  return {
    r: Number.parseInt(v.slice(0, 2), 16),
    g: Number.parseInt(v.slice(2, 4), 16),
    b: Number.parseInt(v.slice(4, 6), 16),
  };
}

/** Approximate relative lightness [0..1] from a hex color (using sRGB luminance). */
function hexToRelativeLightness(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

export function blend(base: string, target: string, amount: number): string {
  const a = hexToRgb(base);
  const b = hexToRgb(target);
  if (!a || !b) return base;
  const t = Math.max(0, Math.min(1, amount));
  return `#${(["r", "g", "b"] as const).map((ch) => Math.round(a[ch] + (b[ch] - a[ch]) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function makeZincScale(
  background: string,
  foreground: string,
  appearance: "dark" | "light",
): Record<string, string> {
  const bg = normalizeHexColor(background) ?? "#09090b";
  const fg = normalizeHexColor(foreground) ?? (appearance === "dark" ? "#fafafa" : "#18181b");
  if (appearance === "light") {
    return {
      "50": blend(bg, fg, 0.04),
      "100": blend(bg, fg, 0.08),
      "200": blend(bg, fg, 0.14),
      "300": blend(bg, fg, 0.22),
      "400": blend(bg, fg, 0.34),
      "500": blend(bg, fg, 0.46),
      "600": blend(bg, fg, 0.58),
      "700": blend(bg, fg, 0.70),
      "800": blend(bg, fg, 0.80),
      "900": blend(bg, fg, 0.90),
      "925": blend(bg, fg, 0.94),
      "950": blend(bg, fg, 0.97),
    };
  }
  return {
    "50": blend(bg, fg, 0.96),
    "100": blend(bg, fg, 0.92),
    "200": blend(bg, fg, 0.86),
    "300": blend(bg, fg, 0.78),
    "400": blend(bg, fg, 0.65),
    "500": blend(bg, fg, 0.50),
    "600": blend(bg, fg, 0.35),
    "700": blend(bg, fg, 0.24),
    "800": blend(bg, fg, 0.14),
    "900": blend(bg, fg, 0.08),
    "925": blend(bg, fg, 0.05),
    "950": blend(bg, fg, 0.03),
  };
}

function normalizeId(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// ── VS Code → Bender theme converter ─────────────────────────────────────────

export function importVsCodeTheme(params: ImportVsCodeThemeParams): ImportVsCodeThemeResult {
  const warnings: string[] = [];
  const payload = params.payload;
  if (!payload || typeof payload !== "object") throw new Error("Invalid VS Code theme payload");

  const obj = payload as Record<string, unknown>;
  const colorsObj = (obj.colors && typeof obj.colors === "object" && !Array.isArray(obj.colors))
    ? obj.colors as Record<string, unknown>
    : {};
  const appearance = String(obj.type ?? "dark").toLowerCase() === "light" ? "light" : "dark";
  const sourceName = (typeof obj.name === "string" && obj.name.trim()) ? obj.name.trim() : "Imported VS Code Theme";
  const name = params.name?.trim() || sourceName;
  const id = normalizeId(params.id?.trim() || name || `theme-${Date.now()}`) || `theme-${Date.now()}`;

  function pick(...keys: string[]): string | null {
    for (const key of keys) {
      const v = normalizeHexColor(colorsObj[key]);
      if (v) return v;
    }
    return null;
  }

  const appBg = pick("editor.background", "terminal.background", "sideBar.background")
    ?? (appearance === "dark" ? "#09090b" : "#fafafa");
  const panelBg = pick("sideBar.background", "editorGroupHeader.tabsBackground", "panel.background")
    ?? (appearance === "dark" ? "#18181b" : "#f4f4f5");
  const panelAltBg = pick("editor.background", "editorGroup.background", "tab.inactiveBackground") ?? appBg;
  // surfaceOverlay comes from VS Code's widget/dropdown surface — clearly elevated above panel
  const rawOverlay = pick("editorWidget.background", "dropdown.background", "menu.background");
  const elevatedBg = rawOverlay ?? panelBg;
  const textPrimary = pick("editor.foreground", "foreground")
    ?? (appearance === "dark" ? "#fafafa" : "#18181b");
  const textSecondary = pick("sideBar.foreground", "descriptionForeground", "editorLineNumber.foreground")
    ?? blend(panelBg, textPrimary, appearance === "dark" ? 0.68 : 0.58);
  const textMuted = pick("disabledForeground", "editorLineNumber.foreground")
    ?? blend(panelBg, textPrimary, appearance === "dark" ? 0.45 : 0.35);
  const borderDefault = pick("panel.border", "sideBar.border", "editorGroup.border")
    ?? blend(panelBg, textPrimary, appearance === "dark" ? 0.12 : 0.22);
  const accent = pick("button.background", "textLink.foreground", "focusBorder")
    ?? (appearance === "dark" ? "#e4e4e7" : "#18181b");
  const accentFg = pick("button.foreground") ?? (appearance === "dark" ? "#09090b" : "#fafafa");
  const focusRing = pick("focusBorder", "button.background") ?? accent;
  const inputBg = pick("input.background", "dropdown.background", "sideBar.background") ?? panelBg;
  const inputBorder = pick("input.border", "dropdown.border", "panel.border") ?? borderDefault;
  const success = pick("terminal.ansiGreen", "testing.iconPassed") ?? "#34d399";
  const warning = pick("terminal.ansiYellow", "editorWarning.foreground") ?? "#fbbf24";
  const danger = pick("terminal.ansiRed", "editorError.foreground") ?? "#f87171";
  const diffAdded = pick("diffEditor.insertedLineBackground", "gitDecoration.addedResourceForeground") ?? success;
  const diffRemoved = pick("diffEditor.removedLineBackground", "gitDecoration.deletedResourceForeground") ?? danger;
  const zinc = makeZincScale(appBg, textPrimary, appearance);

  // ── Elevation tier ────────────────────────────────────────────────────────
  // surfaceFloat: one visible step above panelBg — for floating cards
  const surfaceFloat = blend(panelBg, textPrimary, appearance === "dark" ? 0.07 : 0.04);
  // surfaceOverlay: clearly elevated for popups/menus — prefer VS Code widget bg if distinct
  const surfaceOverlay = (() => {
    if (rawOverlay) {
      // Only use VS Code's value if it's actually above panelBg in lightness
      const panelL = hexToRelativeLightness(panelBg);
      const overlayL = hexToRelativeLightness(rawOverlay);
      const diff = appearance === "dark" ? overlayL - panelL : panelL - overlayL;
      if (diff >= 0.04) return rawOverlay;
    }
    // Derive: ~14% blend — ensures visible step on any theme
    return blend(panelBg, textPrimary, appearance === "dark" ? 0.14 : 0.07);
  })();
  // overlayBorder: visible ring around popup — blend toward text at 25%
  const overlayBorder = pick("editorWidget.border", "menu.border")
    ?? blend(surfaceOverlay, textPrimary, appearance === "dark" ? 0.28 : 0.18);
  // Row states inside overlays
  const overlayHover  = pick("list.hoverBackground")
    ?? blend(surfaceOverlay, textPrimary, appearance === "dark" ? 0.09 : 0.07);
  const overlayActive = pick("list.activeSelectionBackground", "list.focusBackground")
    ?? blend(surfaceOverlay, textPrimary, appearance === "dark" ? 0.17 : 0.12);

  const theme: BenderTheme = {
    schemaVersion: 1,
    id,
    name,
    appearance,
    description: (typeof obj.description === "string") ? obj.description.slice(0, 400).trim() : "Imported from VS Code theme JSON",
    author: params.author?.trim() || "Imported",
    ui: {
      colors: {
        appBg,
        panelBg,
        panelAltBg,
        elevatedBg,
        overlayBg: blend(appBg, "#000000", appearance === "dark" ? 0.4 : 0.15)
          + (appearance === "dark" ? "e6" : "cc"),
        textPrimary,
        textSecondary,
        textMuted,
        textInverse: appearance === "dark" ? "#09090b" : "#fafafa",
        borderDefault,
        borderMuted: blend(panelBg, borderDefault, appearance === "dark" ? 0.7 : 0.6),
        borderStrong: blend(borderDefault, textPrimary, appearance === "dark" ? 0.5 : 0.25),
        accent,
        accentFg,
        focusRing,
        success,
        warning,
        danger,
        diffAdded,
        diffRemoved,
        inputBg,
        inputBorder,
        inputBorderHover: blend(inputBorder, textPrimary, appearance === "dark" ? 0.35 : 0.15),
        inputBorderFocus: focusRing,
        inputDisabledBg: blend(inputBg, panelBg, appearance === "dark" ? 0.55 : 0.8),
        inputDisabledBorder: blend(inputBorder, panelBg, appearance === "dark" ? 0.5 : 0.7),
        inputDisabledText: textMuted,
        checkboxBg: inputBg,
        checkboxBorder: inputBorder,
        checkboxCheckedBg: blend(accent, panelBg, appearance === "dark" ? 0.25 : 0.1),
        checkboxCheckedBorder: accent,
        checkboxIndicator: accent,
        scrollbarThumb: blend(panelBg, textPrimary, appearance === "dark" ? 0.24 : 0.28),
        scrollbarThumbHover: blend(panelBg, textPrimary, appearance === "dark" ? 0.34 : 0.38),
        codeInlineBg: blend(panelBg, textPrimary, appearance === "dark" ? 0.1 : 0.04),
        codeInlineFg: textSecondary,
        codeBlockBg: panelBg,
        codeBlockBorder: borderDefault,
        // Elevation tier
        surfaceFloat,
        surfaceOverlay,
        overlayBorder,
        overlayHover,
        overlayActive,
      },
      radius: { sm: "4px", md: "6px", lg: "8px", xl: "12px" },
      legacy: { zinc },
    },
    meta: {
      importedFrom: "vscode",
      originalName: sourceName,
      importedAt: Date.now(),
    },
  };

  if (!Object.keys(colorsObj).length) warnings.push("No VS Code color tokens found; fallbacks were used.");
  if (!pick("editor.background")) warnings.push("Missing `editor.background`; used fallback for base background.");
  if (!pick("editor.foreground")) warnings.push("Missing `editor.foreground`; used fallback for text color.");

  return { theme: benderThemeSchema.parse(theme), warnings };
}
