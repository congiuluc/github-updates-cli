import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { createProgressDisplay } from "./progress.js";

function terminal(columns = 100, rows = 24) {
  return { isTTY: true, columns, rows, write: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("updates a fixed progress bar and separate worker rows in place", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream });
  display.start("Enriching", 5, 2, 2);
  display.event({ event: "article_processing_started", articleTitle: "First", worker: 1 });
  display.event({ event: "article_processing_started", articleTitle: "Second", worker: 2 });
  display.event({ event: "copilot_attempt_started", articleTitle: "First", worker: 1, attempt: 2 });
  let frame = stream.write.mock.calls.at(-1)![0];
  expect(frame).toContain("2/5");
  expect(frame).toContain("Worker 1: attempt 2 - First");
  expect(frame).toContain("Worker 2: starting - Second");
  expect(frame).toContain("\x1b[");
  display.event({ event: "article_review_skipped", articleTitle: "First", worker: 1 });
  display.event({ event: "article_processing_completed", articleTitle: "Second", worker: 2 });
  frame = stream.write.mock.calls.at(-1)![0];
  expect(frame).toContain("4/5");
  expect(frame).toContain("1 omitted");
  display.stop();
  expect(display.active).toBe(false);
});

test("keeps messages outside the live frame and stops idempotently", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream });
  display.start("Sources", 2);
  display.update(1, "Prepared source");
  display.log("Warning: image unavailable\n");
  expect(stream.write.mock.calls.map(([text]) => text).join("")).toContain("Warning: image unavailable\n");
  display.stop();
  const calls = stream.write.mock.calls.length;
  display.stop();
  expect(stream.write).toHaveBeenCalledTimes(calls);
});

test("bounds terminal rows and truncates control characters and wide titles", () => {
  const stream = terminal(36, 5);
  const display = createProgressDisplay({ stream });
  display.start("Enriching", 8, 8);
  display.event({ event: "article_processing_started", worker: 1, articleTitle: "\x1b[2J\n" + "界".repeat(100) });
  const frame: string = stream.write.mock.calls.at(-1)![0];
  expect(frame).not.toContain("\x1b[2J");
  expect(frame.split("\n").length).toBeLessThanOrEqual(5);
  for (const line of frame.replace(/\x1b\[[0-9;]*[A-Za-z]|\r/g, "").split("\n")) {
    expect(Array.from(line).reduce((width, char) => width + (char === "界" ? 2 : 1), 0))
      .toBeLessThan(36);
  }
});

test.each([{ isTTY: false }, { isTTY: true, enabled: false }, { isTTY: true, term: "dumb" }])(
  "does not redraw redirected, verbose and dumb terminals: %j", (options) => {
    const stream = { ...terminal(), isTTY: options.isTTY };
    const display = createProgressDisplay({ stream, ...options });
    display.start("Enriching", 3, 2);
    display.update(1, "First");
    display.stop();
    expect(stream.write).not.toHaveBeenCalled();
    display.log("Normal log\n");
    expect(stripVTControlCharacters(stream.write.mock.calls.at(-1)![0])).toBe("Normal log\n");
  },
);

test("styles worker status by severity after fitting each row to the terminal width", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream, env: {} });
  display.start("Enriching", 3, 3);
  display.event({ event: "article_processing_completed", worker: 1, articleTitle: "First" });
  display.event({ event: "article_review_skipped", worker: 2, articleTitle: "Second" });
  display.event({ event: "article_processing_failed", worker: 3, articleTitle: "Third", error: "Service unavailable" });
  const frame = stream.write.mock.calls.at(-1)![0];
  expect(frame).toContain("\x1b[32mWorker 1: completed");
  expect(frame).toContain("\x1b[33mWorker 2: omitted");
  expect(frame).toContain("\x1b[31mWorker 3: failed");
  expect(stripVTControlCharacters(frame)).toContain("First");
});

test("NO_COLOR keeps the compact display but suppresses color codes", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream, env: { NO_COLOR: "" } });
  display.start("Enriching", 1, 1);
  display.event({ event: "article_processing_completed", worker: 1, articleTitle: "First" });
  const frame = stream.write.mock.calls.at(-1)![0];
  expect(frame).toContain("\x1b[J");
  expect(frame).not.toMatch(/\x1b\[[0-9;]*m/);
});

test("uses WinGet-style blocks and fractional fill while preserving truthful counters", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream, env: {} });
  display.start("Enriching", 7, 1, 2);
  const initial = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]);
  expect(initial).toContain("\u2588");
  expect(initial).toMatch(/[\u2589-\u258f]/);
  expect(initial).toContain("\u2592");
  expect(initial).toContain("2/7 (28%)");
  expect(initial).toContain("00:00");
  expect(initial).not.toContain("[#####");
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(120);
  const next = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]);
  expect(next).toContain("\\ Enriching");
  expect(next).toContain("2/7 (28%)");
  expect(next).not.toBe(initial);
  vi.advanceTimersByTime(1880);
  expect(stripVTControlCharacters(stream.write.mock.calls.at(-1)![0])).toContain("00:01");
  display.stop();
  expect(stripVTControlCharacters(stream.write.mock.calls.at(-1)![0])).toContain("00:02");
  expect(vi.getTimerCount()).toBe(0);
});

test.each([24, 36, 60, 120])("adapts the bar without hiding the counter at %i columns", (columns) => {
  const stream = terminal(columns);
  const display = createProgressDisplay({ stream, env: {} });
  display.start("Long source preparation phase", 10, 0, 5);
  const frame = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]);
  expect(frame).toContain("5/10 (50%)");
  for (const line of frame.split("\n")) expect(line.length).toBeLessThan(columns);
});

test.each([
  { TERM: "linux" }, { LC_ALL: "C" }, { LC_CTYPE: "POSIX" }, { LANG: "C" },
])("uses an ASCII fallback in limited terminal environments: %j", (env) => {
  const stream = terminal();
  const display = createProgressDisplay({ stream, env });
  display.start("Enriching", 4, 0, 2);
  const frame = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]);
  expect(frame).toContain("############------------");
  expect(frame).not.toMatch(/[\u2588-\u2592]/);
  expect(frame).toContain("2/4 (50%)");
});

test("stops the refresh timer on completion and clears it when a new phase starts", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream, env: {} });
  display.start("Sources", 3);
  display.start("Enriching", 1, 1);
  expect(vi.getTimerCount()).toBe(1);
  display.event({ event: "article_processing_completed", worker: 1, articleTitle: "Done" });
  expect(vi.getTimerCount()).toBe(0);
  const last = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]);
  expect(last).toContain("\u2588".repeat(24));
  expect(last).toContain("1/1 (100%)");
  const calls = stream.write.mock.calls.length;
  vi.advanceTimersByTime(5000);
  expect(stream.write).toHaveBeenCalledTimes(calls);
  display.stop();
  display.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["article_processing_failed", "article_processing_paused"] as const)(
  "stops animation on %s without claiming completion", (event) => {
    const stream = terminal();
    const display = createProgressDisplay({ stream, env: {} });
    display.start("Enriching", 10, 2, 1);
    display.event({ event, worker: 1, articleTitle: "Pending", error: "Failure" });
    expect(vi.getTimerCount()).toBe(0);
    const frame = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]);
    expect(frame).toContain("1/10 (10%)");
    expect(frame).not.toContain("100%");
  },
);

test("CI, disabled and redirected displays do not schedule background redraws", () => {
  for (const options of [
    { stream: terminal(), env: { CI: "true" } },
    { stream: terminal(), enabled: false, env: {} },
    { stream: { ...terminal(), isTTY: false }, env: {} },
    { stream: terminal(), term: "dumb", env: {} },
  ]) {
    const display = createProgressDisplay(options);
    display.start("Enriching", 5);
    expect(vi.getTimerCount()).toBe(0);
    display.stop();
  }
});

test("elapsed time advances during waits without adding log lines or artificial progress", () => {
  const stream = terminal();
  const display = createProgressDisplay({ stream, env: {} });
  display.start("Enriching", 8, 1, 2);
  display.event({ event: "copilot_attempt_started", articleTitle: "Waiting for AI", worker: 1, attempt: 1 });
  vi.advanceTimersByTime(61_200);
  const frame = stream.write.mock.calls.at(-1)![0];
  expect(frame).toContain("\r\x1b[1A\x1b[J");
  expect(stripVTControlCharacters(frame)).toContain("2/8 (25%)");
  expect(stripVTControlCharacters(frame)).toContain("01:01");
  expect(frame.split("\n")).toHaveLength(2);
  display.log("Warning: wait continues\n", "warning");
  display.stop();
  const count = stream.write.mock.calls.length;
  vi.advanceTimersByTime(5000);
  expect(stream.write).toHaveBeenCalledTimes(count);
});

test("preserves grapheme clusters in clipped titles and adapts on the next narrow-terminal redraw", () => {
  const stream = terminal(70, 5);
  const display = createProgressDisplay({ stream, env: {} });
  display.start("Enriching", 4, 1);
  const title = "e\u0301\u{1f469}\u200d\u{1f4bb}\u{1f1ee}\u{1f1f9}".repeat(12);
  display.event({ event: "article_processing_started", worker: 1, articleTitle: title });
  stream.columns = 35;
  vi.advanceTimersByTime(120);
  const frame = stripVTControlCharacters(stream.write.mock.calls.at(-1)![0]).replaceAll("\r", "");
  expect(frame).toContain("0/4 (0%)");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const wide = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
  for (const line of frame.split("\n")) {
    const width = [...segmenter.segment(line)].reduce((count, part) => count + (wide.test(part.segment) ? 2 : 1), 0);
    expect(width).toBeLessThan(35);
  }
  expect(frame).not.toMatch(/\u200d\.{3}/);
});
