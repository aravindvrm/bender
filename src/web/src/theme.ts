export interface BenderThemePayload {
  id: string;
  appearance: "dark" | "light";
  ui: {
    colors: Record<string, string>;
    radius: Record<string, string>;
    legacy?: {
      zinc?: Record<string, string>;
    };
  };
}

const COLOR_VAR_MAP: Record<string, string> = {
  appBg: "--bender-app-bg",
  panelBg: "--bender-panel-bg",
  panelAltBg: "--bender-panel-alt-bg",
  elevatedBg: "--bender-elevated-bg",
  overlayBg: "--bender-overlay-bg",
  textPrimary: "--bender-text-primary",
  textSecondary: "--bender-text-secondary",
  textMuted: "--bender-text-muted",
  textInverse: "--bender-text-inverse",
  borderDefault: "--bender-border-default",
  borderMuted: "--bender-border-muted",
  borderStrong: "--bender-border-strong",
  accent: "--bender-accent",
  accentFg: "--bender-accent-fg",
  focusRing: "--bender-focus-ring",
  success: "--bender-success",
  warning: "--bender-warning",
  danger: "--bender-danger",
  diffAdded: "--bender-diff-added",
  diffRemoved: "--bender-diff-removed",
  inputBg: "--bender-input-bg",
  inputBorder: "--bender-input-border",
  inputBorderHover: "--bender-input-border-hover",
  inputBorderFocus: "--bender-input-border-focus",
  inputDisabledBg: "--bender-input-disabled-bg",
  inputDisabledBorder: "--bender-input-disabled-border",
  inputDisabledText: "--bender-input-disabled-text",
  checkboxBg: "--bender-checkbox-bg",
  checkboxBorder: "--bender-checkbox-border",
  checkboxCheckedBg: "--bender-checkbox-checked-bg",
  checkboxCheckedBorder: "--bender-checkbox-checked-border",
  checkboxIndicator: "--bender-checkbox-indicator",
  scrollbarThumb: "--bender-scrollbar-thumb",
  scrollbarThumbHover: "--bender-scrollbar-thumb-hover",
  codeInlineBg: "--bender-code-inline-bg",
  codeInlineFg: "--bender-code-inline-fg",
  codeBlockBg: "--bender-code-block-bg",
  codeBlockBorder: "--bender-code-block-border",
};

const RADIUS_VAR_MAP: Record<string, string> = {
  sm: "--bender-radius-sm",
  md: "--bender-radius-md",
  lg: "--bender-radius-lg",
  xl: "--bender-radius-xl",
};

export function applyBenderTheme(theme: BenderThemePayload): void {
  if (!theme?.ui?.colors || !theme?.ui?.radius) return;
  const root = document.documentElement;

  for (const [token, cssVar] of Object.entries(COLOR_VAR_MAP)) {
    const value = theme.ui.colors[token];
    if (typeof value === "string" && value.trim()) {
      root.style.setProperty(cssVar, value.trim());
    }
  }

  for (const [token, cssVar] of Object.entries(RADIUS_VAR_MAP)) {
    const value = theme.ui.radius[token];
    if (typeof value === "string" && value.trim()) {
      root.style.setProperty(cssVar, value.trim());
    }
  }

  const zinc = theme.ui.legacy?.zinc ?? {};
  for (const [scale, value] of Object.entries(zinc)) {
    if (!/^\d{2,3}$/.test(scale)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    root.style.setProperty(`--color-zinc-${scale}`, value.trim());
  }

  root.style.setProperty("color-scheme", theme.appearance);
  root.dataset.benderTheme = theme.id;
}
