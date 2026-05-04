import { useRef, useState } from "react";
import { Upload, Trash2, Moon, Sun, Check } from "lucide-react";
import { SectionHeader } from "./shared";
import type { ThemeSummary } from "./types";

interface ThemeSectionProps {
  themes: ThemeSummary[];
  activeThemeId: string;
  loading: boolean;
  importing: boolean;
  scope: "global" | "project";
  error: string | null;
  notice: string | null;
  onSelectTheme: (themeId: string) => void;
  onRefresh: () => Promise<void>;
  onImportVsCode: (jsonText: string) => Promise<void>;
  onDeleteTheme?: (themeId: string, scope: "global" | "project") => Promise<void>;
}

// ── Swatch card ───────────────────────────────────────────────────────────────

function ThemeCard({
  theme,
  isActive,
  onSelect,
  onDelete,
}: {
  theme: ThemeSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const p = theme.preview;
  const isDark = theme.appearance === "dark";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 w-full ${
        isActive
          ? "border-zinc-400 bg-zinc-800/60 ring-1 ring-zinc-400/40"
          : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70"
      }`}
    >
      {/* Colour preview */}
      {p ? (
        <div
          className="relative h-14 w-full overflow-hidden rounded-lg"
          style={{ background: p.appBg }}
        >
          {/* Simulated editor lines */}
          <div className="absolute inset-0 flex flex-col gap-1 p-2">
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 rounded-full w-6" style={{ background: p.panelBg }} />
              <div className="h-1.5 rounded-full w-12" style={{ background: p.panelBg, opacity: 0.6 }} />
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="h-1 rounded w-3" style={{ background: p.accent, opacity: 0.9 }} />
              <div className="h-1 rounded w-8" style={{ background: p.textPrimary, opacity: 0.55 }} />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-1 rounded w-4" style={{ background: p.success, opacity: 0.8 }} />
              <div className="h-1 rounded w-6" style={{ background: p.textPrimary, opacity: 0.35 }} />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-1 rounded w-2" style={{ background: p.danger, opacity: 0.75 }} />
              <div className="h-1 rounded w-5" style={{ background: p.accent, opacity: 0.4 }} />
            </div>
          </div>
          {/* Colour dot strip */}
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center gap-1 px-2 py-1"
            style={{ background: p.panelBg + "cc" }}
          >
            {[p.appBg, p.accent, p.success, p.danger, p.textPrimary].map((color, i) => (
              <div
                key={i}
                className="h-2 w-2 rounded-full border border-black/10 shrink-0"
                style={{ background: color }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="h-14 w-full rounded-lg bg-zinc-800" />
      )}

      {/* Name row */}
      <div className="flex items-start justify-between gap-1 min-w-0">
        <span className="text-[11px] font-medium text-zinc-200 leading-tight">{theme.name}</span>
        <div className="flex items-center gap-0.5 shrink-0 mt-px">
          {isDark
            ? <Moon className="h-2.5 w-2.5 text-zinc-600" />
            : <Sun className="h-2.5 w-2.5 text-zinc-500" />}
          {isActive && <Check className="h-3 w-3 text-bender-success ml-0.5" />}
        </div>
      </div>

      {/* Source badge + delete button */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          theme.source === "builtin"
            ? "bg-zinc-800 text-zinc-600"
            : theme.source === "project"
              ? "bg-blue-950/60 text-blue-400"
              : "bg-zinc-800 text-zinc-500"
        }`}>
          {theme.source}
        </span>
        {onDelete && theme.source !== "builtin" && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-600 hover:text-red-400 transition-all"
            title="Delete theme"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </button>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export function ThemeSection({
  themes,
  activeThemeId,
  importing,
  scope,
  error,
  notice,
  onSelectTheme,
  onImportVsCode,
  onDeleteTheme,
}: ThemeSectionProps) {
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  async function handleFileSelection(file: File | null): Promise<void> {
    if (!file) return;
    const text = await file.text();
    await onImportVsCode(text);
    if (uploadRef.current) uploadRef.current.value = "";
  }

  function handleDeleteClick(themeId: string): void {
    if (deleteConfirm === themeId) {
      void onDeleteTheme?.(themeId, scope);
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(themeId);
      setTimeout(() => setDeleteConfirm((p) => (p === themeId ? null : p)), 3000);
    }
  }

  const dark = themes.filter((t) => t.appearance === "dark");
  const light = themes.filter((t) => t.appearance === "light");

  function renderGroup(group: ThemeSummary[], label: string) {
    if (group.length === 0) return null;
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">{label}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {group.map((theme) => (
            <div key={theme.id} className="relative">
              {deleteConfirm === theme.id && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-zinc-900/90 border border-red-500/50 p-2">
                  <span className="text-[10px] text-red-400 text-center leading-snug">
                    Click delete again to confirm
                  </span>
                </div>
              )}
              <ThemeCard
                theme={theme}
                isActive={theme.id === activeThemeId}
                onSelect={() => onSelectTheme(theme.id)}
                onDelete={onDeleteTheme ? () => handleDeleteClick(theme.id) : undefined}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <section>
        <SectionHeader
          title="Appearance"
          description="Pick a theme. Import any VS Code-compatible theme JSON — Tokyo Night, Catppuccin, One Dark, etc."
        />

        <div className="space-y-5">
          {renderGroup(dark, "Dark")}
          {renderGroup(light, "Light")}

          {/* Import row */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-zinc-800/60">
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              disabled={importing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Upload className="h-3.5 w-3.5" />
              {importing ? "Importing…" : `Import VS Code theme (${scope})`}
            </button>
            <input
              ref={uploadRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => { void handleFileSelection(e.target.files?.[0] ?? null); }}
            />
            <span className="text-[11px] text-zinc-600 hidden sm:block">
              Any VS Code-compatible <code className="bg-zinc-800 px-1 rounded">.json</code> theme file
            </span>
          </div>

          {notice && <p className="text-xs text-zinc-400">{notice}</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />
    </>
  );
}
