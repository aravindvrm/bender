import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Minimum level to emit. Can be overridden via BENDER_LOG_LEVEL env var. */
function getMinLevel(): LogLevel {
  const env = process.env.BENDER_LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return "info";
}

/**
 * Structured logger for Bender operations.
 * Writes NDJSON to .bender/bender.log and optionally calls a UIAdapter sink.
 */
export class Logger {
  private minLevel: LogLevel;

  constructor(
    private component: string,
    private logFile: string | null = null,
    private sink: LogSink | null = null,
  ) {
    this.minLevel = getMinLevel();
  }

  private shouldEmit(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.minLevel];
  }

  private async emit(level: LogLevel, message: string, data?: Record<string, unknown>): Promise<void> {
    if (!this.shouldEmit(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    // Call UI sink synchronously
    this.sink?.(entry);

    // Write to log file asynchronously (fire and forget with error suppression)
    if (this.logFile) {
      const line = JSON.stringify(entry) + "\n";
      appendFile(this.logFile, line, "utf-8").catch(() => { /* ignore write errors */ });
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    void this.emit("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    void this.emit("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    void this.emit("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    void this.emit("error", message, data);
  }

  /** Return a child logger with a sub-component name. */
  child(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`, this.logFile, this.sink);
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Create a logger for a project operation. Log file goes in .bender/bender.log. */
export function createLogger(
  component: string,
  projectRoot?: string | null,
  sink?: LogSink | null,
): Logger {
  let logFile: string | null = null;
  if (projectRoot) {
    const benderDir = join(projectRoot, ".bender");
    logFile = join(benderDir, "bender.log");
    // Ensure directory exists (sync check is fine at startup)
    if (!existsSync(benderDir)) {
      mkdir(benderDir, { recursive: true }).catch(() => { /* ignore */ });
    }
  }
  return new Logger(component, logFile, sink ?? null);
}

/** Create a no-op logger (for tests or contexts where logging is unwanted). */
export function createNullLogger(component = "test"): Logger {
  return new Logger(component, null, null);
}

/** Build a UIAdapter-compatible sink that forwards log entries as adapter messages. */
export function makeAdapterSink(adapter: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
}): LogSink {
  return (entry: LogEntry) => {
    // Only forward warn/error to the adapter (info/debug is too noisy for the console)
    if (entry.level === "warn") {
      adapter.warn(`[${entry.component}] ${entry.message}`);
    } else if (entry.level === "error") {
      (adapter.error ?? adapter.warn)(`[${entry.component}] ${entry.message}`);
    }
    // debug/info go to the log file only
  };
}

// ── Timing helper ─────────────────────────────────────────────────────────────

/** Returns a function that logs elapsed time when called. */
export function startTimer(logger: Logger, operation: string): () => number {
  const start = Date.now();
  return () => {
    const elapsed = Date.now() - start;
    logger.debug(`${operation} completed`, { elapsedMs: elapsed });
    return elapsed;
  };
}
