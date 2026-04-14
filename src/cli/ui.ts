import chalk from "chalk";
import ora, { type Ora } from "ora";
import { createInterface } from "node:readline";

let rl: ReturnType<typeof createInterface> | null = null;

function getReadline() {
  if (rl) return rl;
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl;
}

/**
 * Prompt the user for text input.
 */
export function prompt(question: string): Promise<string> {
  const lineReader = getReadline();
  return new Promise((resolve) => {
    lineReader.question(chalk.cyan(`${question} `), (answer: string) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt the user for multi-line text input (end with empty line).
 */
export async function promptMultiline(question: string): Promise<string> {
  console.log(chalk.cyan(`${question} (press Enter twice to finish)`));
  const lineReader = getReadline();
  const lines: string[] = [];
  let emptyCount = 0;

  return new Promise((resolve) => {
    const lineHandler = (line: string) => {
      if (line === "") {
        emptyCount++;
        if (emptyCount >= 1 && lines.length > 0) {
          lineReader.removeListener("line", lineHandler);
          resolve(lines.join("\n"));
          return;
        }
      } else {
        emptyCount = 0;
      }
      lines.push(line);
    };
    lineReader.on("line", lineHandler);
  });
}

/**
 * Ask the user a yes/no question.
 */
export async function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(`${question} ${hint}`);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

/**
 * Display a section header.
 */
export function header(text: string): void {
  console.log("\n" + chalk.bold.blue(`=== ${text} ===`) + "\n");
}

/**
 * Display a sub-section header.
 */
export function subheader(text: string): void {
  console.log("\n" + chalk.bold(`--- ${text} ---`) + "\n");
}

/**
 * Display a success message.
 */
export function success(text: string): void {
  console.log(chalk.green(`  ${text}`));
}

/**
 * Display an error message.
 */
export function error(text: string): void {
  console.log(chalk.red(`  ${text}`));
}

/**
 * Display a warning message.
 */
export function warn(text: string): void {
  console.log(chalk.yellow(`  ${text}`));
}

/**
 * Display info text.
 */
export function info(text: string): void {
  console.log(chalk.gray(`  ${text}`));
}

/**
 * Create a spinner.
 */
export function spinner(text: string): Ora {
  return ora({ text, color: "cyan" });
}

/**
 * Display streamed LLM output with a subtle prefix.
 */
export function streamWriter(): (chunk: string) => void {
  return (chunk: string) => {
    process.stdout.write(chunk);
  };
}

/**
 * Display a diff-like view of file operations.
 */
export function showFileOperations(operations: { path: string; action: string }[]): void {
  for (const op of operations) {
    const actionColor = op.action === "create" ? chalk.green : chalk.yellow;
    console.log(`  ${actionColor(op.action.toUpperCase().padEnd(6))} ${op.path}`);
  }
}

/**
 * Clean up readline interface.
 */
export function cleanup(): void {
  if (!rl) return;
  rl.close();
  rl = null;
}
