import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

export type MessageKind = "info" | "success" | "warning" | "error" | "muted";

export interface ConsoleStream {
  isTTY?: boolean;
  write(text: string): unknown;
}

const colors: Record<MessageKind, string> = {
  info: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  muted: "\x1b[2m",
};

export function consoleColorsEnabled(stream: ConsoleStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stream.isTTY) && !("NO_COLOR" in env) && env.TERM !== "dumb";
}

export function formatConsoleMessage(
  message: string, kind: MessageKind, stream: ConsoleStream, env: NodeJS.ProcessEnv = process.env,
): string {
  return consoleColorsEnabled(stream, env) ? `${colors[kind]}${message}\x1b[0m` : message;
}

export function writeConsoleMessage(
  message: string, kind: MessageKind = "info", stream: ConsoleStream = process.stderr,
): void {
  stream.write(formatConsoleMessage(message, kind, stream));
}

/** OSC 8 is opt-in by terminal capability; a fully encoded file URL remains usable elsewhere. */
export function terminalFileLink(
  path: string, stream: ConsoleStream, env: NodeJS.ProcessEnv = process.env,
): string {
  const absolute = resolve(path);
  const uri = pathToFileURL(absolute).href;
  const hyperlinks = consoleColorsEnabled(stream, env) && !env.CI &&
    (Boolean(env.WT_SESSION) ||
      ["vscode", "iTerm.app", "WezTerm", "ghostty"].includes(env.TERM_PROGRAM ?? "") ||
      env.TERM === "xterm-kitty" || Number(env.VTE_VERSION) >= 5000);
  if (!hyperlinks) return uri;
  const label = stripVTControlCharacters(absolute).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

export interface CompletionSummary {
  presentationPath?: string;
  reviewPath?: string;
  included: number;
  pending: number;
  resumable: boolean;
  budgetPaused: boolean;
}

/** Human-only summary on stderr; stdout file-path records and JSON/trace output stay machine-readable. */
export function writeCompletionSummary(
  summary: CompletionSummary,
  stream: ConsoleStream = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const write = (message: string, kind: MessageKind) => stream.write(formatConsoleMessage(message, kind, stream, env));
  const partial = summary.pending > 0;
  stream.write("\n");
  write(`${partial ? "Needs attention" : "Complete"}: ${summary.included} article${summary.included === 1 ? "" : "s"} in ${summary.presentationPath ? "the generated deck" : "the editable draft"}${partial ? `; ${summary.pending} pending or omitted` : ""}.\n`,
    partial ? "warning" : "success");
  if (summary.presentationPath) {
    write(`Open deck: ${terminalFileLink(summary.presentationPath, stream, env)}\n`, "success");
  } else if (summary.reviewPath) {
    write(`Open editable content: ${terminalFileLink(summary.reviewPath, stream, env)}\n`, "info");
  }
  if (partial) {
    write(summary.resumable
      ? "Reminder: re-run the same command with --resume to retry pending articles and regenerate the deck. Keep the same dates, sources, model and locales; remove --restart if present.\n"
      : "Reminder: re-run the original source-collection command with --resume to recover omitted articles. --import-json alone cannot restore missing source articles.\n",
    "warning");
    if (summary.budgetPaused) write("Review the AI budget and usage warning before retrying; an unchanged exhausted budget will pause again.\n", "warning");
  }
}
