import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBenderDir } from "../state/config.js";
import { getBenderHomePath } from "../state/paths.js";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "./defaults.js";
import { benderThemeSchema, type BenderTheme, type ThemeListResult, type ThemeSource, type ThemeSummary } from "./types.js";
// Re-export the public converter so callers only need to import from service
export { importVsCodeTheme } from "./convert.js";
export type { ImportVsCodeThemeParams, ImportVsCodeThemeResult } from "./convert.js";

export interface ResolvedTheme {
  theme: BenderTheme;
  source: ThemeSource;
  activeThemeId: string;
  themes: ThemeSummary[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function themePreview(colors: BenderTheme["ui"]["colors"]): ThemeSummary["preview"] {
  return {
    appBg: colors.appBg,
    panelBg: colors.panelBg,
    textPrimary: colors.textPrimary,
    accent: colors.accent,
    success: colors.success,
    danger: colors.danger,
  };
}

function uniqueThemeSummaries(
  records: Array<{ theme: BenderTheme; source: ThemeSource }>,
  activeThemeId: string,
): ThemeSummary[] {
  const map = new Map<string, ThemeSummary>();
  for (const { theme, source } of records) {
    map.set(theme.id, {
      id: theme.id,
      name: theme.name,
      appearance: theme.appearance,
      description: theme.description,
      author: theme.author,
      source,
      isActive: theme.id === activeThemeId,
      preview: themePreview(theme.ui.colors),
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

async function readThemeDir(
  dir: string,
  source: ThemeSource,
): Promise<Array<{ theme: BenderTheme; source: ThemeSource }>> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files = entries.filter((n) => n.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
  const themes: Array<{ theme: BenderTheme; source: ThemeSource }> = [];
  for (const file of files) {
    const theme = await readThemeFile(join(dir, file));
    if (theme) themes.push({ theme, source });
  }
  return themes;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listThemes(projectRoot?: string | null, activeThemeId?: string): Promise<ThemeListResult> {
  const builtin = BUILTIN_THEMES.map((theme) => ({ theme, source: "builtin" as const }));
  const global = await readThemeDir(getGlobalThemeDir(), "global");
  const project = projectRoot ? await readThemeDir(getProjectThemeDir(projectRoot), "project") : [];
  const merged = [...builtin, ...global, ...project];
  const byId = new Map<string, { theme: BenderTheme; source: ThemeSource }>();
  for (const item of merged) byId.set(item.theme.id, item);
  const requested = (activeThemeId ?? "").trim();
  const resolvedActive = byId.get(requested)?.theme.id
    ?? byId.get(DEFAULT_THEME_ID)?.theme.id
    ?? [...byId.keys()][0]
    ?? DEFAULT_THEME_ID;
  return {
    themes: uniqueThemeSummaries([...byId.values()], resolvedActive),
    activeThemeId: resolvedActive,
  };
}

export async function resolveTheme(
  themeId: string | undefined,
  projectRoot?: string | null,
): Promise<ResolvedTheme> {
  const builtin = BUILTIN_THEMES.map((theme) => ({ theme, source: "builtin" as const }));
  const global = await readThemeDir(getGlobalThemeDir(), "global");
  const project = projectRoot ? await readThemeDir(getProjectThemeDir(projectRoot), "project") : [];
  const merged = [...builtin, ...global, ...project];
  const byId = new Map<string, { theme: BenderTheme; source: ThemeSource }>();
  for (const item of merged) byId.set(item.theme.id, item);
  const requestedId = (themeId ?? "").trim();
  const chosen = byId.get(requestedId) ?? byId.get(DEFAULT_THEME_ID) ?? builtin[0];
  const activeThemeId = chosen?.theme.id ?? DEFAULT_THEME_ID;
  return {
    theme: chosen.theme,
    source: chosen.source,
    activeThemeId,
    themes: uniqueThemeSummaries([...byId.values()], activeThemeId),
  };
}

export async function saveTheme(
  theme: BenderTheme,
  scope: "global" | "project",
  projectRoot?: string | null,
): Promise<void> {
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

export async function deleteTheme(
  themeId: string,
  scope: "global" | "project",
  projectRoot?: string | null,
): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  const dir = scope === "project"
    ? (projectRoot ? getProjectThemeDir(projectRoot) : null)
    : getGlobalThemeDir();
  if (!dir) throw new Error("No project selected");
  const filePath = join(dir, `${themeId}.json`);
  if (!existsSync(filePath)) throw new Error(`Theme file not found: ${themeId}`);
  await unlink(filePath);
}
