import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBenderDir } from "../state/config.js";
import { getBenderHomePath } from "../state/paths.js";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "./defaults.js";
import { benderThemeSchema, type BenderTheme, type ThemeListResult, type ThemeSource, type ThemeSummary } from "./types.js";

export interface ResolvedTheme {
  theme: BenderTheme;
  source: ThemeSource;
  activeThemeId: string;
  themes: ThemeSummary[];
}

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

function nowTs(): number {
  return Date.now();
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value) return null;
  const prefixed = value.startsWith("#") ? value : `#${value}`;
  const shortMatch = prefixed.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4})$/);
  if (shortMatch) {
    const chars = shortMatch[1].split("");
    return `#${chars.map((char) => `${char}${char}`).join("")}`.toLowerCase();
  }
  const longMatch = prefixed.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (longMatch) return `#${longMatch[1].toLowerCase()}`;
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) return null;
  const rawParts = rgbMatch[1].split(",").map((part) => part.trim());
  if (rawParts.length < 3) return null;
  const [r, g, b] = rawParts.slice(0, 3).map((part) => Number(part));
  if (![r, g, b].every((num) => Number.isFinite(num) && num >= 0 && num <= 255)) return null;
  if (rawParts.length < 4) {
    return `#${[r, g, b].map((num) => Math.round(num).toString(16).padStart(2, "0")).join("")}`;
  }
  const alphaNum = Number(rawParts[3]);
  if (!Number.isFinite(alphaNum)) return null;
  const alpha = Math.max(0, Math.min(1, alphaNum));
  return `#${[r, g, b].map((num) => Math.round(num).toString(16).padStart(2, "0")).join("")}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  const value = normalized.slice(1, 7);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function blend(base: string, target: string, amount: number): string {
  const a = hexToRgb(base);
  const b = hexToRgb(target);
  if (!a || !b) return base;
  const t = Math.max(0, Math.min(1, amount));
  const channels = ["r", "g", "b"] as const;
  const parts = channels.map((channel) => {
    const mixed = Math.round(a[channel] + (b[channel] - a[channel]) * t);
    return mixed.toString(16).padStart(2, "0");
  });
  return `#${parts.join("")}`;
}

function makeZincScale(background: string, foreground: string, appearance: "dark" | "light"): Record<string, string> {
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
      "700": blend(bg, fg, 0.7),
      "800": blend(bg, fg, 0.8),
      "900": blend(bg, fg, 0.9),
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
    "500": blend(bg, fg, 0.5),
    "600": blend(bg, fg, 0.35),
    "700": blend(bg, fg, 0.24),
    "800": blend(bg, fg, 0.14),
    "900": blend(bg, fg, 0.08),
    "925": blend(bg, fg, 0.05),
    "950": blend(bg, fg, 0.03),
  };
}

function uniqueThemeSummaries(records: Array<{ theme: BenderTheme; source: ThemeSource }>, activeThemeId: string): ThemeSummary[] {
  const map = new Map<string, ThemeSummary>();
  for (const record of records) {
    const theme = record.theme;
    map.set(theme.id, {
      id: theme.id,
      name: theme.name,
      appearance: theme.appearance,
      description: theme.description,
      author: theme.author,
      source: record.source,
      isActive: theme.id === activeThemeId,
    });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getGlobalThemeDir(): string {
  return getBenderHomePath("themes");
}

function getProjectThemeDir(projectRoot: string): string {
  return join(getBenderDir(projectRoot), "themes");
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) await mkdir(path, { recursive: true });
}

async function readThemeFile(path: string): Promise<BenderTheme | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = benderThemeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function readThemeDir(dir: string, source: ThemeSource): Promise<Array<{ theme: BenderTheme; source: ThemeSource }>> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
  const themes: Array<{ theme: BenderTheme; source: ThemeSource }> = [];
  for (const file of files) {
    const theme = await readThemeFile(join(dir, file));
    if (!theme) continue;
    themes.push({ theme, source });
  }
  return themes;
}

export async function listThemes(projectRoot?: string | null, activeThemeId?: string): Promise<ThemeListResult> {
  const builtin = BUILTIN_THEMES.map((theme) => ({ theme, source: "builtin" as const }));
  const global = await readThemeDir(getGlobalThemeDir(), "global");
  const project = projectRoot ? await readThemeDir(getProjectThemeDir(projectRoot), "project") : [];
  const merged = [...builtin, ...global, ...project];
  const byId = new Map<string, { theme: BenderTheme; source: ThemeSource }>();
  for (const item of merged) {
    byId.set(item.theme.id, item);
  }
  const requested = (activeThemeId ?? "").trim();
  const resolvedActive = byId.get(requested)?.theme.id ?? (byId.get(DEFAULT_THEME_ID)?.theme.id ?? [...byId.keys()][0] ?? DEFAULT_THEME_ID);
  return {
    themes: uniqueThemeSummaries([...byId.values()], resolvedActive),
    activeThemeId: resolvedActive,
  };
}

export async function resolveTheme(themeId: string | undefined, projectRoot?: string | null): Promise<ResolvedTheme> {
  const builtin = BUILTIN_THEMES.map((theme) => ({ theme, source: "builtin" as const }));
  const global = await readThemeDir(getGlobalThemeDir(), "global");
  const project = projectRoot ? await readThemeDir(getProjectThemeDir(projectRoot), "project") : [];
  const merged = [...builtin, ...global, ...project];
  const byId = new Map<string, { theme: BenderTheme; source: ThemeSource }>();
  for (const item of merged) byId.set(item.theme.id, item);
  const requestedId = (themeId ?? "").trim();
  const chosen = byId.get(requestedId) ?? byId.get(DEFAULT_THEME_ID) ?? builtin[0];
  const activeThemeId = chosen?.theme.id ?? DEFAULT_THEME_ID;
  const summaries = uniqueThemeSummaries([...byId.values()], activeThemeId);
  return {
    theme: chosen.theme,
    source: chosen.source,
    activeThemeId,
    themes: summaries,
  };
}

export async function saveTheme(theme: BenderTheme, scope: "global" | "project", projectRoot?: string | null): Promise<void> {
  const parsed = benderThemeSchema.parse(theme);
  if (scope === "project") {
    if (!projectRoot) throw new Error("No project selected");
    const dir = getProjectThemeDir(projectRoot);
    await ensureDir(dir);
    await writeFile(join(dir, `${parsed.id}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    return;
  }
  const dir = getGlobalThemeDir();
  await ensureDir(dir);
  await writeFile(join(dir, `${parsed.id}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

export function importVsCodeTheme(params: ImportVsCodeThemeParams): ImportVsCodeThemeResult {
  const warnings: string[] = [];
  const payload = params.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid VS Code theme payload");
  }
  const obj = payload as Record<string, unknown>;
  const colorsObj = obj.colors && typeof obj.colors === "object" && !Array.isArray(obj.colors)
    ? obj.colors as Record<string, unknown>
    : {};
  const appearance = String(obj.type ?? "dark").toLowerCase() === "light" ? "light" : "dark";
  const sourceName = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "Imported VS Code Theme";
  const name = params.name?.trim() || sourceName;
  const id = normalizeId(params.id?.trim() || name || `theme-${nowTs()}`) || `theme-${nowTs()}`;

  function pick(...keys: string[]): string | null {
    for (const key of keys) {
      const value = normalizeHexColor(colorsObj[key]);
      if (value) return value;
    }
    return null;
  }

  const appBg = pick("editor.background", "terminal.background", "sideBar.background")
    ?? (appearance === "dark" ? "#09090b" : "#fafafa");
  const panelBg = pick("sideBar.background", "editorGroupHeader.tabsBackground", "panel.background")
    ?? (appearance === "dark" ? "#18181b" : "#f4f4f5");
  const panelAltBg = pick("editor.background", "editorGroup.background", "tab.inactiveBackground") ?? appBg;
  const elevatedBg = pick("editorWidget.background", "dropdown.background", "menu.background") ?? panelBg;
  const textPrimary = pick("editor.foreground", "foreground") ?? (appearance === "dark" ? "#fafafa" : "#18181b");
  const textSecondary = pick("sideBar.foreground", "descriptionForeground", "editorLineNumber.foreground")
    ?? blend(panelBg, textPrimary, appearance === "dark" ? 0.68 : 0.58);
  const textMuted = pick("disabledForeground", "editorLineNumber.foreground")
    ?? blend(panelBg, textPrimary, appearance === "dark" ? 0.45 : 0.35);
  const borderDefault = pick("panel.border", "sideBar.border", "editorGroup.border")
    ?? blend(panelBg, textPrimary, appearance === "dark" ? 0.12 : 0.22);
  const accent = pick("button.background", "textLink.foreground", "focusBorder")
    ?? (appearance === "dark" ? "#e4e4e7" : "#18181b");
  const accentFg = pick("button.foreground")
    ?? (appearance === "dark" ? "#09090b" : "#fafafa");
  const focusRing = pick("focusBorder", "button.background") ?? accent;
  const inputBg = pick("input.background", "dropdown.background", "sideBar.background") ?? panelBg;
  const inputBorder = pick("input.border", "dropdown.border", "panel.border") ?? borderDefault;
  const success = pick("terminal.ansiGreen", "testing.iconPassed") ?? "#34d399";
  const warning = pick("terminal.ansiYellow", "editorWarning.foreground") ?? "#fbbf24";
  const danger = pick("terminal.ansiRed", "editorError.foreground") ?? "#f87171";
  const diffAdded = pick("diffEditor.insertedLineBackground", "gitDecoration.addedResourceForeground") ?? success;
  const diffRemoved = pick("diffEditor.removedLineBackground", "gitDecoration.deletedResourceForeground") ?? danger;
  const zinc = makeZincScale(appBg, textPrimary, appearance);

  const theme: BenderTheme = {
    schemaVersion: 1,
    id,
    name,
    appearance,
    description: typeof obj.description === "string" ? obj.description.slice(0, 400).trim() : "Imported from VS Code theme JSON",
    author: params.author?.trim() || "Imported",
    ui: {
      colors: {
        appBg,
        panelBg,
        panelAltBg,
        elevatedBg,
        overlayBg: blend(appBg, "#000000", appearance === "dark" ? 0.4 : 0.15) + (appearance === "dark" ? "e6" : "cc"),
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
      },
      radius: {
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "12px",
      },
      legacy: {
        zinc,
      },
    },
    meta: {
      importedFrom: "vscode",
      originalName: sourceName,
      importedAt: nowTs(),
    },
  };

  if (!Object.keys(colorsObj).length) {
    warnings.push("No VS Code color tokens found; fallbacks were used.");
  }
  if (!pick("editor.background")) {
    warnings.push("Missing `editor.background`; used fallback for base background.");
  }
  if (!pick("editor.foreground")) {
    warnings.push("Missing `editor.foreground`; used fallback for text color.");
  }

  return {
    theme: benderThemeSchema.parse(theme),
    warnings,
  };
}
