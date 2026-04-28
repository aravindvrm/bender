import { z } from "zod";

export type ThemeAppearance = "dark" | "light";
export type ThemeSource = "builtin" | "global" | "project";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const radiusRe = /^(\d+(\.\d+)?)(px|rem|em)$/;

export const colorValueSchema = z.string().regex(HEX_COLOR_RE, "Expected #RRGGBB or #RRGGBBAA");
export const radiusValueSchema = z.string().regex(radiusRe, "Expected radius token like 6px or 0.5rem");

export const benderThemeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(128),
  appearance: z.enum(["dark", "light"]),
  description: z.string().trim().max(400).optional(),
  author: z.string().trim().max(120).optional(),
  extends: z.string().trim().min(1).max(64).optional(),
  ui: z.object({
    colors: z.object({
      appBg: colorValueSchema,
      panelBg: colorValueSchema,
      panelAltBg: colorValueSchema,
      elevatedBg: colorValueSchema,
      overlayBg: colorValueSchema,
      textPrimary: colorValueSchema,
      textSecondary: colorValueSchema,
      textMuted: colorValueSchema,
      textInverse: colorValueSchema,
      borderDefault: colorValueSchema,
      borderMuted: colorValueSchema,
      borderStrong: colorValueSchema,
      accent: colorValueSchema,
      accentFg: colorValueSchema,
      focusRing: colorValueSchema,
      success: colorValueSchema,
      warning: colorValueSchema,
      danger: colorValueSchema,
      diffAdded: colorValueSchema,
      diffRemoved: colorValueSchema,
      inputBg: colorValueSchema,
      inputBorder: colorValueSchema,
      inputBorderHover: colorValueSchema,
      inputBorderFocus: colorValueSchema,
      inputDisabledBg: colorValueSchema,
      inputDisabledBorder: colorValueSchema,
      inputDisabledText: colorValueSchema,
      checkboxBg: colorValueSchema,
      checkboxBorder: colorValueSchema,
      checkboxCheckedBg: colorValueSchema,
      checkboxCheckedBorder: colorValueSchema,
      checkboxIndicator: colorValueSchema,
      scrollbarThumb: colorValueSchema,
      scrollbarThumbHover: colorValueSchema,
      codeInlineBg: colorValueSchema,
      codeInlineFg: colorValueSchema,
      codeBlockBg: colorValueSchema,
      codeBlockBorder: colorValueSchema,
    }),
    radius: z.object({
      sm: radiusValueSchema,
      md: radiusValueSchema,
      lg: radiusValueSchema,
      xl: radiusValueSchema,
    }),
    legacy: z.object({
      zinc: z.record(z.string(), colorValueSchema).optional(),
    }).optional(),
  }),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type BenderTheme = z.infer<typeof benderThemeSchema>;

export interface ThemeSummary {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  description?: string;
  author?: string;
  source: ThemeSource;
  isActive?: boolean;
}

export interface ThemeListResult {
  themes: ThemeSummary[];
  activeThemeId: string;
}
