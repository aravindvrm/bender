import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getBenderHomePath } from "./state/paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type SinkLevel = LogLevel | "none";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
  type?: string;
  cause?: SerializedError | string;
}

export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
  enabled?: boolean;
  level?: LogLevel;
  sinkMinLevel?: SinkLevel;
}

export interface LoggingSettingsLike {
  enabled?: boolean;
  level?: LogLevel;
  consoleLevel?: SinkLevel;
}

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
  private enabled: boolean;
  private sinkMinLevel: SinkLevel;

  constructor(
    private component: string,
    private logFile: string | null = null,
    private sink: LogSink | null = null,
    opts?: LoggerOptions,
  ) {
    this.enabled = opts?.enabled ?? true;
    this.minLevel = opts?.level ?? getMinLevel();
    this.sinkMinLevel = opts?.sinkMinLevel ?? "warn";
  }

  private shouldEmit(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.minLevel];
  }

  private async emit(level: LogLevel, message: string, data?: Record<string, unknown>): Promise<void> {
    const hasTokenUsage =
      typeof data?.inputTokens === "number"
      || typeof data?.outputTokens === "number";
    if (!hasTokenUsage && !this.enabled) return;
    if (!hasTokenUsage && !this.shouldEmit(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    // Call UI sink synchronously
    if (
      this.sink
      && this.sinkMinLevel !== "none"
      && LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.sinkMinLevel]
    ) {
      this.sink(entry);
    }

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
    return new Logger(`${this.component}:${subComponent}`, this.logFile, this.sink, {
      enabled: this.enabled,
      level: this.minLevel,
      sinkMinLevel: this.sinkMinLevel,
    });
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Create a logger for a project operation. Log file goes in .bender/bender.log. */
export function createLogger(
  component: string,
  projectRoot?: string | null,
  sink?: LogSink | null,
  opts?: LoggerOptions,
): Logger {
  let logFile: string | null = null;
  if (projectRoot) {
    const benderDir = join(projectRoot, ".bender");
    logFile = join(benderDir, "bender.log");
    // Ensure directory exists (sync check is fine at startup)
    if (!existsSync(benderDir)) {
      try {
        mkdirSync(benderDir, { recursive: true });
      } catch {
        // ignore; appendFile fallback is also best-effort
      }
    }
  } else {
    const homeLogPath = getBenderHomePath("bender.log");
    const homeDir = dirname(homeLogPath);
    try {
      if (!existsSync(homeDir)) {
        mkdirSync(homeDir, { recursive: true });
      }
      logFile = homeLogPath;
    } catch {
      // ignore and continue without file sink
      logFile = null;
    }
  }
  return new Logger(component, logFile, sink ?? null, opts);
}

export function toLoggerOptions(settings?: LoggingSettingsLike): LoggerOptions {
  return {
    enabled: settings?.enabled ?? true,
    level: settings?.level ?? getMinLevel(),
    sinkMinLevel: settings?.consoleLevel ?? "warn",
  };
}

export function createRequestId(): string {
  return randomUUID();
}

/**
 * Return the project root only when .bender already exists.
 * Useful for observational logging paths that should not implicitly initialize state.
 */
export function resolveExistingProjectLogRoot(projectRoot?: string | null): string | null {
  if (!projectRoot) return null;
  const benderDir = join(projectRoot, ".bender");
  return existsSync(benderDir) ? projectRoot : null;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; cause?: unknown; type?: unknown };
    return {
      name: error.name,
      message: normalizeErrorMessage(error),
      ...(typeof error.stack === "string" && error.stack ? { stack: error.stack } : {}),
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      ...(typeof candidate.type === "string" ? { type: candidate.type } : {}),
      ...(candidate.cause !== undefined
        ? {
            cause: candidate.cause instanceof Error
              ? serializeError(candidate.cause)
              : normalizeErrorMessage(candidate.cause),
          }
        : {}),
    };
  }
  return { message: normalizeErrorMessage(error) };
}

export function logError(
  logger: Logger,
  message: string,
  error: unknown,
  data?: Record<string, unknown>,
): void {
  logger.error(message, {
    ...(data ?? {}),
    error: serializeError(error),
  });
}

/** Create a no-op logger (for tests or contexts where logging is unwanted). */
export function createNullLogger(component = "test"): Logger {
  return new Logger(component, null, null, { enabled: false, sinkMinLevel: "none" });
}

/** Build a UIAdapter-compatible sink that forwards log entries as adapter messages. */
export function makeAdapterSink(adapter: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
}): LogSink {
  return (entry: LogEntry) => {
    if (entry.level === "debug" || entry.level === "info") {
      adapter.info(`[${entry.component}] ${entry.message}`);
    } else if (entry.level === "warn") {
      adapter.warn(`[${entry.component}] ${entry.message}`);
    } else if (entry.level === "error") {
      (adapter.error ?? adapter.warn)(`[${entry.component}] ${entry.message}`);
    }
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
