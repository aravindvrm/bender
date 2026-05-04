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
  diffAddedBg: "--bender-diff-added-bg",
  diffRemovedBg: "--bender-diff-removed-bg",
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
  // Elevation tier
  surfaceFloat:   "--bender-surface-float",
  surfaceOverlay: "--bender-surface-overlay",
  overlayBorder:  "--bender-overlay-border",
  overlayHover:   "--bender-overlay-hover",
  overlayActive:  "--bender-overlay-active",
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

  // Shadow scale — not hex colors, generated from appearance
  if (theme.appearance === "light") {
    root.style.setProperty("--bender-shadow-float",   "0 4px 20px rgba(0,0,0,0.09), 0 1px 4px rgba(0,0,0,0.05)");
    root.style.setProperty("--bender-shadow-overlay", "0 8px 32px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.07)");
  } else {
    root.style.setProperty("--bender-shadow-float",   "0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)");
    root.style.setProperty("--bender-shadow-overlay", "0 4px 24px rgba(0,0,0,0.65), 0 1px 6px rgba(0,0,0,0.40)");
  }

  root.style.setProperty("color-scheme", theme.appearance);
  root.dataset.benderTheme = theme.id;
}
