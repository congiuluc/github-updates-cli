import type { EnrichmentTraceEvent } from "./enricher.js";
import { stripVTControlCharacters } from "node:util";
import { formatConsoleMessage, type MessageKind } from "./console-output.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wideGlyph = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
const spinnerFrames = ["-", "\\", "|", "/"];
const partialBlocks = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"];

interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): unknown;
}

function cellWidth(text: string): number {
  return [...graphemes.segment(text)].reduce((width, { segment }) =>
    width + (/^\p{Mark}+$/u.test(segment) ? 0 : wideGlyph.test(segment) ? 2 : 1), 0);
}

function fitLine(text: string, width: number): string {
  const clean = stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  if (cellWidth(clean) <= width) return clean;
  const suffix = ".".repeat(Math.min(3, width));
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const size = cellWidth(segment);
    if (used + size > width - suffix.length) break;
    result += segment;
    used += size;
  }
  return result + suffix;
}

function progressBar(ratio: number, width: number, unicode: boolean): string {
  if (width < 1) return "";
  if (!unicode) {
    const filled = Math.floor(ratio * width);
    return "#".repeat(filled) + "-".repeat(width - filled);
  }
  const units = Math.min(width * 8, Math.floor(ratio * width * 8));
  const filled = Math.floor(units / 8);
  const fraction = partialBlocks[units % 8];
  return "\u2588".repeat(filled) + fraction + "\u2592".repeat(width - filled - (fraction ? 1 : 0));
}

function elapsedTime(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function createProgressDisplay(options: {
  stream?: ProgressStream;
  enabled?: boolean;
  term?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const stream = options.stream ?? process.stderr;
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), ...(options.term !== undefined ? { TERM: options.term } : {}) };
  const enabled = options.enabled !== false && Boolean(stream.isTTY) &&
    env.TERM !== "dumb";
  const unicode = env.TERM !== "linux" && !/^(C|POSIX)$/.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "");
  const animate = enabled && !env.CI;
  let active = false;
  let lines = 0;
  let label = "";
  let total = 0;
  let completed = 0;
  let omitted = 0;
  let detail = { text: "", kind: "info" as MessageKind };
  let workers: { text: string; kind: MessageKind }[] = [];
  let failed = false;
  let paused = false;
  let startedAt = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopAnimation = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const displayWidth = () => Math.max(1, (stream.columns ?? 80) - 1);
  const isRunning = () => active && completed < total && !failed && !paused;
  const headingKind = (): MessageKind => failed ? "error" : omitted || paused ? "warning" : completed === total ? "success" : "info";
  const heading = (running = isRunning()) => {
    const width = displayWidth();
    const ratio = total ? Math.min(completed / total, 1) : 0;
    const counts = `${completed}/${total} (${Math.floor(ratio * 100)}%)`;
    const warnings = omitted ? ` | ${omitted} omitted` : "";
    let suffix = `${counts}${warnings}`;
    const elapsed = ` ${elapsedTime(startedAt)}`;
    if (cellWidth(suffix + elapsed) + 12 <= width) suffix += elapsed;
    if (cellWidth(suffix) >= width) return fitLine(suffix, width);
    const symbol = running ? spinnerFrames[frame % spinnerFrames.length] : failed ? "!" : paused ? "!" : "";
    let prefix = `${symbol ? `${symbol} ` : ""}${label}`;
    const minimumBarWidth = 4;
    const prefixSpace = Math.max(0, width - cellWidth(suffix) - minimumBarWidth - 4);
    prefix = prefixSpace ? fitLine(prefix, prefixSpace) : "";
    const barWidth = Math.min(24, Math.max(0, width - cellWidth(prefix) - cellWidth(suffix) - (prefix ? 4 : 2)));
    const bar = progressBar(ratio, barWidth, unicode);
    return [prefix, bar, suffix].filter(Boolean).join("  ");
  };
  const clear = () => {
    if (!lines) return "";
    const sequence = `\r${lines > 1 ? `\x1b[${lines - 1}A` : ""}\x1b[J`;
    lines = 0;
    return sequence;
  };
  const render = () => {
    if (!active) return;
    const rows = Math.max(1, (stream.rows ?? 24) - 1);
    const width = displayWidth();
    const content = [{ text: heading(), kind: headingKind() }, ...(workers.length ? workers : [detail])].slice(0, rows);
    if (workers.length >= rows && rows > 1) {
      content[rows - 1] = { text: `${workers.length - rows + 2} more workers (increase terminal height to show all)`, kind: "muted" };
    }
    const prefix = clear();
    lines = content.length;
    stream.write(prefix + content.map((line) => formatConsoleMessage(fitLine(line.text, width), line.kind, stream, env)).join("\n"));
  };
  return {
    get active() { return active; },
    start(phase: string, count: number, workerCount = 0, alreadyCompleted = 0) {
      if (!enabled) return;
      stopAnimation();
      label = phase;
      total = count;
      completed = alreadyCompleted;
      omitted = 0;
      detail = { text: "", kind: "info" };
      failed = false;
      paused = false;
      startedAt = Date.now();
      frame = 0;
      workers = Array.from({ length: workerCount }, (_, index) => ({ text: `Worker ${index + 1}: waiting`, kind: "muted" }));
      active = true;
      render();
      if (animate && isRunning()) {
        // Animation signals activity only; completed counts change exclusively through real events.
        timer = setInterval(() => {
          frame += 1;
          render();
        }, 120);
        timer.unref();
      }
    },
    update(count: number, message: string, kind: MessageKind = "info") {
      completed = count;
      detail = { text: message, kind };
      if (kind === "error") failed = true;
      if (!isRunning()) stopAnimation();
      render();
    },
    event(event: EnrichmentTraceEvent) {
      if (!active || event.worker === undefined) return;
      let status: string;
      let kind: MessageKind = "info";
      switch (event.event) {
        case "article_processing_started": status = "starting"; break;
        case "copilot_attempt_started": status = `${event.agent === "reviewer" ? "reviewer" : "attempt"} ${event.attempt}`; break;
        case "copilot_response_received": status = "validating"; kind = "muted"; break;
        case "copilot_request_failed": status = `request failed: ${event.error}`; kind = "warning"; break;
        case "slide_validation_completed":
          status = event.issues?.length ? `needs correction: ${event.issues.join("; ")}` : "validated";
          kind = event.issues?.length ? "warning" : "success";
          break;
        case "article_processing_completed": status = "completed"; completed++; kind = "success"; break;
        case "article_review_skipped": status = "omitted"; completed++; omitted++; kind = "warning"; break;
        case "article_processing_failed": status = `failed: ${event.error}`; kind = "error"; failed = true; break;
        case "article_processing_paused": status = "paused: AI budget"; kind = "warning"; paused = true; break;
        case "image_download_failed": status = "image unavailable"; kind = "warning"; break;
      }
      workers[event.worker - 1] = { text: `Worker ${event.worker}: ${status} - ${event.articleTitle}`, kind };
      if (!isRunning()) stopAnimation();
      render();
    },
    log(message: string, kind: MessageKind = "info") {
      stream.write(clear() + formatConsoleMessage(message, kind, stream, env));
      render();
    },
    stop() {
      stopAnimation();
      if (!active) return;
      stream.write(clear() + formatConsoleMessage(`${heading(false)}\n`, headingKind(), stream, env));
      active = false;
    },
  };
}
