import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "./shared";

interface RuntimeDepsState {
  id: string;
  label: string;
  bundleVersion: number;
  upstreamVersion: string;
  sizeBytes: number;
  installedSizeBytes: number | null;
  status:
    | { state: "installed"; bundleVersion: number; upstreamVersion: string; installedAt: string }
    | { state: "missing" }
    | { state: "stale"; installedBundleVersion: number; expectedBundleVersion: number };
}

interface StorageSectionProps {
  runOperation?: (
    url: string,
    body: Record<string, unknown>,
    options?: { onSuccess?: () => void; onFinish?: (success: boolean) => void },
  ) => void;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function StorageSection({ runOperation }: StorageSectionProps) {
  const [runtimeDeps, setRuntimeDeps] = useState<RuntimeDepsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/evals/runtime-deps");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRuntimeDeps((await res.json()) as RuntimeDepsState);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleUninstall() {
    if (!window.confirm("Uninstall eval support? You can reinstall it any time from this page or the Evals tab.")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/evals/runtime-deps", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleInstall() {
    if (!runOperation) return;
    runOperation("/api/evals/runtime-deps/install", {}, { onSuccess: () => void refresh() });
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Storage"
        description="Optional runtime extensions downloaded into ~/.bender/runtime-deps/."
      />

      {error && <p className="text-xs text-red-400">{error}</p>}

      {runtimeDeps && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex items-start gap-4">
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">{runtimeDeps.label}</span>
                {runtimeDeps.status.state === "installed" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                    Installed
                  </span>
                )}
                {runtimeDeps.status.state === "stale" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                    Update available
                  </span>
                )}
                {runtimeDeps.status.state === "missing" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400">
                    Not installed
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500">
                promptfoo {runtimeDeps.upstreamVersion} · bundle v{runtimeDeps.bundleVersion}
              </p>
              {runtimeDeps.status.state === "installed" && (
                <p className="text-[11px] text-zinc-500">
                  {runtimeDeps.installedSizeBytes !== null
                    ? `${formatBytes(runtimeDeps.installedSizeBytes)} on disk`
                    : "size unknown"}
                  {" · installed "}
                  {formatDate(runtimeDeps.status.installedAt)}
                </p>
              )}
              {runtimeDeps.status.state !== "installed" && (
                <p className="text-[11px] text-zinc-500">
                  Download size ~{formatBytes(runtimeDeps.sizeBytes)}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {runtimeDeps.status.state === "installed" ? (
                <button
                  type="button"
                  onClick={() => void handleUninstall()}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg border border-zinc-700 text-[11px] text-zinc-300 hover:border-rose-500/60 hover:text-rose-300 transition-colors disabled:opacity-50"
                >
                  Uninstall
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleInstall}
                  disabled={!runOperation}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-[11px] text-amber-100 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                >
                  {runtimeDeps.status.state === "stale" ? "Update" : "Install"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
