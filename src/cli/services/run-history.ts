import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RUNS = 20;
const RUNS_DIR = ".bender/runs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunEventKind =
  | "header"
  | "subheader"
  | "info"
  | "success"
  | "warn"
  | "error"
  | "stream"
  | "spinner-start"
  | "spinner-update"
  | "spinner-end"
  | "files"
  | "confirm"
  | "prompt"
  | "done";

export interface RunEvent {
  ts: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export type RunStatus = "running" | "done" | "error" | "aborted";

export interface RunSummary {
  id: string;
  label: string;
  operationType: string;
  projectRoot: string;
  startedAt: number;
  durationMs: number | null;
  status: RunStatus;
  eventCount: number;
}

export interface RunHandle {
  id: string;
  appendEvent(kind: RunEventKind, payload: Record<string, unknown>): void;
  finish(status: "done" | "error"): Promise<void>;
  abort(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class RunHistoryStore {
  private readonly runsDir: string;
  private readonly indexPath: string;

  constructor(private readonly projectRoot: string) {
    this.runsDir = join(projectRoot, RUNS_DIR);
    this.indexPath = join(this.runsDir, "index.json");
  }

  async init(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
  }

  async startRun(operationType: string, label: string): Promise<RunHandle> {
    const id = randomUUID();
    const startedAt = Date.now();
    const runPath = join(this.runsDir, `${id}.jsonl`);
    let eventCount = 0;

    const baseSummary: RunSummary = {
      id,
      label,
      operationType,
      projectRoot: this.projectRoot,
      startedAt,
      durationMs: null,
      status: "running",
      eventCount: 0,
    };

    // Write initial "running" entry to the index.
    await this.upsertIndex(baseSummary);

    const appendEvent = (kind: RunEventKind, payload: Record<string, unknown>): void => {
      eventCount++;
      const event: RunEvent = { ts: Date.now(), kind, payload };
      // Fire-and-forget — never block the running operation.
      appendFile(runPath, JSON.stringify(event) + "\n").catch(() => {/* ignore write errors */});
    };

    const finalise = async (status: "done" | "error" | "aborted"): Promise<void> => {
      const durationMs = Date.now() - startedAt;
      await this.upsertIndex({ ...baseSummary, status, durationMs, eventCount });
      await this.trimOldRuns();
    };

    return {
      id,
      appendEvent,
      finish: (status) => finalise(status),
      abort: () => finalise("aborted"),
    };
  }

  async listRuns(limit: number = MAX_RUNS): Promise<RunSummary[]> {
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as RunSummary[]).slice(0, limit) : [];
    } catch {
      return [];
    }
  }

  async getRunEvents(id: string): Promise<RunEvent[]> {
    const runPath = join(this.runsDir, `${id}.jsonl`);
    if (!existsSync(runPath)) return [];
    try {
      const raw = await readFile(runPath, "utf-8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async upsertIndex(summary: RunSummary): Promise<void> {
    let runs: RunSummary[] = [];
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      runs = Array.isArray(parsed) ? (parsed as RunSummary[]) : [];
    } catch {
      runs = [];
    }

    const existingIdx = runs.findIndex((r) => r.id === summary.id);
    if (existingIdx >= 0) {
      runs[existingIdx] = summary;
    } else {
      runs.unshift(summary);
    }

    await writeFile(this.indexPath, JSON.stringify(runs, null, 2) + "\n", "utf-8");
  }

  private async trimOldRuns(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      let runs = JSON.parse(raw) as RunSummary[];
      if (!Array.isArray(runs) || runs.length <= MAX_RUNS) return;

      // Keep newest MAX_RUNS by startedAt.
      runs.sort((a, b) => b.startedAt - a.startedAt);
      const toRemove = runs.slice(MAX_RUNS);
      runs = runs.slice(0, MAX_RUNS);

      await writeFile(this.indexPath, JSON.stringify(runs, null, 2) + "\n", "utf-8");

      // Delete stale JSONL files asynchronously — best effort.
      for (const old of toRemove) {
        const runPath = join(this.runsDir, `${old.id}.jsonl`);
        unlink(runPath).catch(() => {/* stale file already gone */});
      }
    } catch {
      // Index unreadable or parse failure — skip trim silently.
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter wrapper
// ---------------------------------------------------------------------------

import type { SpinnerAdapter, UIAdapter } from "../adapter.js";

/**
 * Wraps any UIAdapter so that every event is also recorded into a RunHandle.
 * The inner adapter continues to work as-is; run-history is a side effect.
 */
export function wrapAdapterWithHistory(inner: UIAdapter, handle: RunHandle): UIAdapter {
  const { appendEvent } = handle;

  return {
    header(text) {
      appendEvent("header", { text });
      inner.header(text);
    },
    subheader(text) {
      appendEvent("subheader", { text });
      inner.subheader(text);
    },
    info(text) {
      appendEvent("info", { text });
      inner.info(text);
    },
    success(text) {
      appendEvent("success", { text });
      inner.success(text);
    },
    error(text) {
      appendEvent("error", { text });
      inner.error(text);
    },
    warn(text) {
      appendEvent("warn", { text });
      inner.warn(text);
    },
    streamWriter() {
      const innerWriter = inner.streamWriter();
      let buffer = "";
      return (chunk: string) => {
        buffer += chunk;
        // Flush to history on newline boundaries to keep events readable.
        const nlIdx = buffer.lastIndexOf("\n");
        if (nlIdx >= 0) {
          appendEvent("stream", { text: buffer.slice(0, nlIdx + 1) });
          buffer = buffer.slice(nlIdx + 1);
        }
        innerWriter(chunk);
      };
    },
    spinner(text: string): SpinnerAdapter {
      appendEvent("spinner-start", { text });
      const innerSpinner = inner.spinner(text);
      return {
        get text() { return innerSpinner.text; },
        set text(v: string) {
          appendEvent("spinner-update", { text: v });
          innerSpinner.text = v;
        },
        start() {
          appendEvent("spinner-start", { text: innerSpinner.text });
          innerSpinner.start();
        },
        stop() {
          appendEvent("spinner-end", { text: innerSpinner.text, success: null });
          innerSpinner.stop();
        },
        succeed(t?: string) {
          appendEvent("spinner-end", { text: t ?? innerSpinner.text, success: true });
          innerSpinner.succeed(t);
        },
        fail(t?: string) {
          appendEvent("spinner-end", { text: t ?? innerSpinner.text, success: false });
          innerSpinner.fail(t);
        },
      };
    },
    async confirm(question, defaultYes) {
      appendEvent("confirm", { question, defaultYes: defaultYes ?? true });
      return inner.confirm(question, defaultYes);
    },
    async promptMultiline(question) {
      appendEvent("prompt", { question });
      return inner.promptMultiline(question);
    },
    showFileOperations(ops) {
      appendEvent("files", { ops });
      inner.showFileOperations(ops);
    },
    cleanup() {
      inner.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable label and operation type from an HTTP route path.
 * e.g. "/api/run/analyze" → { operationType: "analyze", label: "Analyze project" }
 */
export function labelFromRoutePath(routePath: string): { operationType: string; label: string } {
  const segment = routePath.split("/").filter(Boolean).pop() ?? routePath;
  const labels: Record<string, string> = {
    analyze: "Analyze project",
    implement: "Implement tasks",
    init: "Initialize project",
    flows: "Generate flows",
    review: "Review changes",
    security: "Security audit",
    tests: "Tests audit",
  };
  return {
    operationType: segment,
    label: labels[segment] ?? segment,
  };
}
