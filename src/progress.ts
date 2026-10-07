import type { EnrichmentTraceEvent } from "./enricher.js";

interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): unknown;
}

function fitLine(text: string, width: number): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  let result = "";
  let used = 0;
  for (const char of clean) {
    const size = char.codePointAt(0)! > 0xff ? 2 : 1;
    if (used + size > width - 3) return `${result}...`;
    result += char;
    used += size;
  }
  return result;
}

export function createProgressDisplay(options: {
  stream?: ProgressStream;
  enabled?: boolean;
  term?: string;
} = {}) {
  const stream = options.stream ?? process.stderr;
  const enabled = options.enabled !== false && Boolean(stream.isTTY) &&
    (options.term ?? process.env.TERM) !== "dumb";
  let active = false;
  let lines = 0;
  let label = "";
  let total = 0;
  let completed = 0;
  let omitted = 0;
  let detail = "";
  let workers: string[] = [];
  const heading = () => {
    const ratio = total ? Math.min(completed / total, 1) : 0;
    const filled = Math.floor(ratio * 16);
    return `${label} [${"#".repeat(filled)}${"-".repeat(16 - filled)}] ${completed}/${total} (${Math.floor(ratio * 100)}%)${omitted ? ` | ${omitted} omitted` : ""}`;
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
    const width = Math.max(4, (stream.columns ?? 80) - 1);
    const content = [heading(), ...(workers.length ? workers : [detail])].slice(0, rows);
    if (workers.length >= rows && rows > 1) {
      content[rows - 1] = `${workers.length - rows + 2} more workers (increase terminal height to show all)`;
    }
    const prefix = clear();
    lines = content.length;
    stream.write(prefix + content.map((line) => fitLine(line, width)).join("\n"));
  };
  return {
    get active() { return active; },
    start(phase: string, count: number, workerCount = 0, alreadyCompleted = 0) {
      if (!enabled) return;
      label = phase;
      total = count;
      completed = alreadyCompleted;
      omitted = 0;
      detail = "";
      workers = Array.from({ length: workerCount }, (_, index) => `Worker ${index + 1}: waiting`);
      active = true;
      render();
    },
    update(count: number, message: string) {
      completed = count;
      detail = message;
      render();
    },
    event(event: EnrichmentTraceEvent) {
      if (!active || event.worker === undefined) return;
      let status: string;
      switch (event.event) {
        case "article_processing_started": status = "starting"; break;
        case "copilot_attempt_started": status = `${event.agent === "reviewer" ? "reviewer" : "attempt"} ${event.attempt}`; break;
        case "copilot_response_received": status = "validating"; break;
        case "copilot_request_failed": status = `request failed: ${event.error}`; break;
        case "slide_validation_completed":
          status = event.issues?.length ? `needs correction: ${event.issues.join("; ")}` : "validated";
          break;
        case "article_processing_completed": status = "completed"; completed++; break;
        case "article_review_skipped": status = "omitted"; completed++; omitted++; break;
        case "article_processing_failed": status = `failed: ${event.error}`; break;
        case "article_processing_paused": status = "paused: AI budget"; break;
        case "image_download_failed": status = "image unavailable"; break;
      }
      workers[event.worker - 1] = `Worker ${event.worker}: ${status} - ${event.articleTitle}`;
      render();
    },
    log(message: string) {
      stream.write(clear() + message);
      render();
    },
    stop() {
      if (!active) return;
      stream.write(clear() + `${heading()}\n`);
      active = false;
    },
  };
}
