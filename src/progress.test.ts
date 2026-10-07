import { expect, test, vi } from "vitest";
import { createProgressDisplay } from "./progress.js";

function terminal(columns = 100, rows = 24) {
  return { isTTY: true, columns, rows, write: vi.fn() };
}

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
    expect(Array.from(line).reduce((width, char) => width + (char.codePointAt(0)! > 0xff ? 2 : 1), 0))
      .toBeLessThan(36);
  }
});

test.each([{ isTTY: false }, { isTTY: true, enabled: false }, { isTTY: true, term: "dumb" }])(
  "leaves redirected, verbose and dumb terminals untouched: %j", (options) => {
    const stream = { ...terminal(), isTTY: options.isTTY };
    const display = createProgressDisplay({ stream, ...options });
    display.start("Enriching", 3, 2);
    display.update(1, "First");
    display.stop();
    expect(stream.write).not.toHaveBeenCalled();
    display.log("Normal log\n");
    expect(stream.write).toHaveBeenCalledWith("Normal log\n");
  },
);
