import { useRef } from "react";
import { ChevronDown, Upload, RefreshCw } from "lucide-react";
import { Field, SectionHeader } from "./shared";
import type { ThemeSummary } from "./types";

interface ThemeSectionProps {
  themes: ThemeSummary[];
  selectedThemeId: string;
  activeThemeId: string;
  loading: boolean;
  importing: boolean;
  scope: "global" | "project";
  error: string | null;
  notice: string | null;
  onSelectTheme: (themeId: string) => void;
  onRefresh: () => Promise<void>;
  onImportVsCode: (jsonText: string) => Promise<void>;
}

export function ThemeSection({
  themes,
  selectedThemeId,
  activeThemeId,
  loading,
  importing,
  scope,
  error,
  notice,
  onSelectTheme,
  onRefresh,
  onImportVsCode,
}: ThemeSectionProps) {
  const uploadRef = useRef<HTMLInputElement | null>(null);

  async function handleFileSelection(file: File | null): Promise<void> {
    if (!file) return;
    const text = await file.text();
    await onImportVsCode(text);
    if (uploadRef.current) uploadRef.current.value = "";
  }

  return (
    <>
      <section>
        <SectionHeader
          title="Theme"
          description="Select a built-in/imported theme. Bender Default (Dark) remains the baseline."
        />
        <div className="space-y-3">
          <Field label="Active theme">
            <div className="space-y-2">
              <div className="relative max-w-[360px]">
                <select
                  value={selectedThemeId}
                  onChange={(event) => onSelectTheme(event.target.value)}
                  className="select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors"
                >
                  {themes.map((theme) => (
                    <option key={theme.id} value={theme.id} className="bg-zinc-900 text-zinc-200">
                      {theme.name} [{theme.appearance}] [{theme.source}]
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
                  <ChevronDown className="h-3.5 w-3.5" />
                </span>
              </div>
              <p className="text-[11px] text-zinc-500">
                {selectedThemeId === activeThemeId ? "Applied" : `Saved selection: ${selectedThemeId}`}
              </p>
            </div>
          </Field>

          <Field label="Library">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onRefresh()}
                disabled={loading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
              <button
                type="button"
                onClick={() => uploadRef.current?.click()}
                disabled={importing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Upload className="h-3.5 w-3.5" />
                Import VS Code JSON ({scope})
              </button>
              <input
                ref={uploadRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  void handleFileSelection(file);
                }}
              />
            </div>
          </Field>

          {notice && <p className="text-xs text-zinc-400">{notice}</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </section>

      <div className="h-px bg-zinc-800" />
    </>
  );
}
