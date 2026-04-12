import * as ui from "./ui.js";

export interface SpinnerAdapter {
  text: string;
  start(): void;
  stop(): void;
  succeed(text?: string): void;
  fail(text?: string): void;
}

/**
 * Abstraction over terminal/web UI interactions.
 * All CLI commands accept a UIAdapter so they can be driven from
 * either the terminal or the web dashboard via SSE.
 */
export interface UIAdapter {
  header(text: string): void;
  subheader(text: string): void;
  info(text: string): void;
  success(text: string): void;
  error(text: string): void;
  warn(text: string): void;
  streamWriter(): (chunk: string) => void;
  spinner(text: string): SpinnerAdapter;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  promptMultiline(question: string): Promise<string>;
  showFileOperations(ops: { path: string; action: string }[]): void;
  cleanup(): void;
}

/**
 * Terminal adapter — wraps existing ui.ts functions.
 * Used when running commands from the CLI.
 */
export const terminalAdapter: UIAdapter = {
  header: ui.header,
  subheader: ui.subheader,
  info: ui.info,
  success: ui.success,
  error: ui.error,
  warn: ui.warn,
  streamWriter: ui.streamWriter,
  spinner: ui.spinner,
  confirm: ui.confirm,
  promptMultiline: ui.promptMultiline,
  showFileOperations: ui.showFileOperations,
  cleanup: ui.cleanup,
};
