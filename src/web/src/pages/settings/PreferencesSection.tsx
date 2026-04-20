import { ChevronDown } from "lucide-react";
import { Field, TextInput, SectionHeader } from "./shared";
import type { FullConfig } from "./types";

interface PreferencesSectionProps {
  config: FullConfig;
  setConfig: React.Dispatch<React.SetStateAction<FullConfig | null>>;
}

export function PreferencesSection({ config, setConfig }: PreferencesSectionProps) {
  return (
    <>
      {/* Agents (placeholder) */}
      <section>
        <SectionHeader title="Agents" />
        <p className="text-xs text-zinc-600">
          Configure role defaults, pinned skills, and capability policy in the{" "}
          <span className="text-zinc-400">Agents</span> tab.
        </p>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Test command */}
      <section>
        <SectionHeader title="Test Command" />
        <Field label="Override">
          <TextInput
            value={config.test?.command ?? ""}
            onChange={(v) => setConfig((c) => c ? { ...c, test: { command: v || undefined } } : c)}
            placeholder="Auto-detected (e.g. npm test)"
            mono
          />
        </Field>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Auto re-analyze */}
      <section>
        <SectionHeader title="Auto Re-analyze" />
        <p className="text-xs text-zinc-500 mb-4">
          Automatically re-run the architecture analyzer after a series of major task completions (schema, auth, API changes).
        </p>
        <div className="space-y-3">
          <Field label="Enabled">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="reanalyze-enabled"
                checked={config.reanalyze?.enabled ?? true}
                onChange={(e) => setConfig((c) => c ? { ...c, reanalyze: { ...c.reanalyze, enabled: e.target.checked } } : c)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-zinc-100 focus:ring-zinc-500"
              />
              <label htmlFor="reanalyze-enabled" className="text-sm text-zinc-400 cursor-pointer">
                Re-analyze after major tasks
              </label>
            </div>
          </Field>
          <Field label="Threshold">
            <input
              type="number"
              min={1}
              max={10}
              value={config.reanalyze?.threshold ?? 3}
              onChange={(e) => setConfig((c) => c ? { ...c, reanalyze: { ...c.reanalyze, threshold: parseInt(e.target.value, 10) || 3 } } : c)}
              className="w-24 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
            />
            <span className="text-xs text-zinc-500 ml-2">major tasks between analyses</span>
          </Field>
        </div>
      </section>

      <div className="h-px bg-zinc-800" />

      {/* Logging */}
      <section>
        <SectionHeader title="Logging" />
        <p className="text-xs text-zinc-500 mb-4">
          Configure structured logs and console mirroring. Token usage metrics are always recorded for session counters.
        </p>
        <div className="space-y-3">
          <Field label="Enabled">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="logging-enabled"
                checked={config.logging?.enabled ?? true}
                onChange={(e) => setConfig((c) => c ? { ...c, logging: { ...c.logging, enabled: e.target.checked } } : c)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-zinc-100 focus:ring-zinc-500"
              />
              <label htmlFor="logging-enabled" className="text-sm text-zinc-400 cursor-pointer">
                Write structured logs to <span className="font-mono text-zinc-500">.bender/bender.log</span>
              </label>
            </div>
          </Field>
          <Field label="File level">
            <div className="relative max-w-[220px]">
              <select
                value={config.logging?.level ?? "info"}
                onChange={(e) => setConfig((c) => c ? { ...c, logging: { ...c.logging, level: e.target.value as "debug" | "info" | "warn" | "error" } } : c)}
                className="select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors"
              >
                <option value="debug" className="bg-zinc-900 text-zinc-200">debug</option>
                <option value="info" className="bg-zinc-900 text-zinc-200">info</option>
                <option value="warn" className="bg-zinc-900 text-zinc-200">warn</option>
                <option value="error" className="bg-zinc-900 text-zinc-200">error</option>
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
                <ChevronDown className="h-3.5 w-3.5" />
              </span>
            </div>
          </Field>
          <Field label="Console level">
            <div className="relative max-w-[220px]">
              <select
                value={config.logging?.consoleLevel ?? "warn"}
                onChange={(e) => setConfig((c) => c ? { ...c, logging: { ...c.logging, consoleLevel: e.target.value as "none" | "debug" | "info" | "warn" | "error" } } : c)}
                className="select-flat w-full pl-3 pr-8 py-2 text-[13px] transition-colors"
              >
                <option value="none" className="bg-zinc-900 text-zinc-200">none</option>
                <option value="error" className="bg-zinc-900 text-zinc-200">error</option>
                <option value="warn" className="bg-zinc-900 text-zinc-200">warn</option>
                <option value="info" className="bg-zinc-900 text-zinc-200">info</option>
                <option value="debug" className="bg-zinc-900 text-zinc-200">debug</option>
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
                <ChevronDown className="h-3.5 w-3.5" />
              </span>
            </div>
          </Field>
        </div>
      </section>
    </>
  );
}
