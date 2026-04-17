import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { LogEntry, LogLevel } from "../../logger.js";

function parseLogEntries(raw: string, limit?: number): LogEntry[] {
  const lines = raw.split("\n").filter(Boolean);
  const sliced = typeof limit === "number" ? lines.slice(-Math.max(0, limit)) : lines;
  return sliced
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is LogEntry => entry !== null);
}

function aggregateTokenUsage(
  entries: LogEntry[],
  sinceMs?: number,
): { inputTokens: number; outputTokens: number; events: number; lastTimestamp: string | null } {
  let inputTokens = 0;
  let outputTokens = 0;
  let events = 0;
  let lastTimestamp: string | null = null;

  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts)) continue;
    if (typeof sinceMs === "number" && ts < sinceMs) continue;

    const input = typeof entry.data?.inputTokens === "number" ? entry.data.inputTokens : 0;
    const output = typeof entry.data?.outputTokens === "number" ? entry.data.outputTokens : 0;
    if (input <= 0 && output <= 0) continue;

    inputTokens += input;
    outputTokens += output;
    events += 1;
    lastTimestamp = entry.timestamp;
  }

  return { inputTokens, outputTokens, events, lastTimestamp };
}

export async function readStructuredLogs(projectRoot: string, limit = 200): Promise<{ entries: LogEntry[] }> {
  const logPath = join(projectRoot, ".bender", "bender.log");
  if (!existsSync(logPath)) return { entries: [] };
  const raw = await readFile(logPath, "utf-8");
  const bounded = Math.min(500, Math.max(1, limit));
  return { entries: parseLogEntries(raw, bounded) };
}

interface ReadStructuredLogsOptions {
  limit?: number;
  level?: LogLevel;
  component?: string;
  contains?: string;
  sinceMs?: number;
}

function matchesFilter(entry: LogEntry, opts: ReadStructuredLogsOptions): boolean {
  if (opts.level && entry.level !== opts.level) return false;
  if (opts.component && entry.component !== opts.component) return false;
  if (opts.contains) {
    const needle = opts.contains.toLowerCase();
    const haystack = `${entry.message}\n${JSON.stringify(entry.data ?? {})}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (typeof opts.sinceMs === "number") {
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts) || ts < opts.sinceMs) return false;
  }
  return true;
}

export async function readStructuredLogsFiltered(
  projectRoot: string,
  opts: ReadStructuredLogsOptions = {},
): Promise<{ entries: LogEntry[] }> {
  const logPath = join(projectRoot, ".bender", "bender.log");
  if (!existsSync(logPath)) return { entries: [] };
  const raw = await readFile(logPath, "utf-8");
  const all = parseLogEntries(raw);
  const filtered = all.filter((entry) => matchesFilter(entry, opts));
  const bounded = Math.min(500, Math.max(1, opts.limit ?? 200));
  return { entries: filtered.slice(-bounded) };
}

export async function readSessionUsage(
  currentProject: string | null,
  startedAtMs: number,
): Promise<{
  startedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  events: number;
  lastUpdatedAt: string | null;
}> {
  const base = {
    startedAt: new Date(startedAtMs).toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    events: 0,
    lastUpdatedAt: null as string | null,
  };

  if (!currentProject) return base;
  const logPath = join(currentProject, ".bender", "bender.log");
  if (!existsSync(logPath)) return base;

  const raw = await readFile(logPath, "utf-8");
  const usage = aggregateTokenUsage(parseLogEntries(raw), startedAtMs);
  return {
    startedAt: base.startedAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    events: usage.events,
    lastUpdatedAt: usage.lastTimestamp,
  };
}
