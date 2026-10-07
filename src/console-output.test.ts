import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { expect, test, vi } from "vitest";
import { consoleColorsEnabled, formatConsoleMessage, terminalFileLink, writeCompletionSummary } from "./console-output.js";

const terminal = () => ({ isTTY: true, write: vi.fn() });

test.each([
  ["info", "\x1b[36m"], ["success", "\x1b[32m"], ["warning", "\x1b[33m"],
  ["error", "\x1b[31m"], ["muted", "\x1b[2m"],
] as const)("distinguishes %s messages without changing their text", (kind, color) => {
  const message = "Visible message\n";
  expect(formatConsoleMessage(message, kind, terminal(), {})).toBe(`${color}${message}\x1b[0m`);
  expect(stripVTControlCharacters(formatConsoleMessage(message, kind, terminal(), {}))).toBe(message);
});

test.each([
  { isTTY: false, env: {} },
  { isTTY: true, env: { NO_COLOR: "" } },
  { isTTY: true, env: { TERM: "dumb", WT_SESSION: "supported" } },
])("keeps console styling plain for %j", ({ isTTY, env }) => {
  const stream = { isTTY, write: vi.fn() };
  expect(consoleColorsEnabled(stream, env)).toBe(false);
  expect(formatConsoleMessage("Warning: pending\n", "warning", stream, env)).toBe("Warning: pending\n");
  expect(terminalFileLink(resolve("deck.pptx"), stream, env)).not.toContain("\x1b");
});

test.each([{ WT_SESSION: "session" }, { TERM_PROGRAM: "vscode" }])(
  "uses an encoded file URI and safe visible path in hyperlink-capable terminals: %j", (env) => {
    const path = resolve("output", "briefing #1 100% 日本語.pptx");
    const link = terminalFileLink(path, terminal(), env);
    expect(link).toBe(`\x1b]8;;${pathToFileURL(path).href}\x1b\\${path}\x1b]8;;\x1b\\`);
    expect(link).toContain("%20");
    expect(link).toContain("%23");
    expect(link).toContain("%25");
    expect(stripVTControlCharacters(link)).toBe(path);
  },
);

test("falls back to a usable file URL in unknown terminals and redirects", () => {
  const path = resolve("deck with spaces.pptx");
  expect(terminalFileLink(path, terminal(), {})).toBe(pathToFileURL(path).href);
  expect(terminalFileLink(path, { isTTY: false, write: vi.fn() }, { WT_SESSION: "session" })).toBe(pathToFileURL(path).href);
  expect(terminalFileLink(path, terminal(), { WT_SESSION: "session", CI: "true" })).not.toContain("\x1b]8");
});

test("does not allow a control sequence in the display path to escape its hyperlink", () => {
  const path = resolve("report\x1b]8;;https://unrelated.example\x07.pptx");
  const link = terminalFileLink(path, terminal(), { WT_SESSION: "session" });
  expect(link.match(/\x1b\]8;;/g)).toHaveLength(2);
  expect(link).not.toContain("\x07");
});

test("ends partial-run output with explicit resume and budget guidance", () => {
  const stream = terminal();
  writeCompletionSummary({
    presentationPath: resolve("partial.pptx"), included: 2, pending: 1, resumable: true, budgetPaused: true,
  }, stream, { TERM: "dumb" });
  const output = stream.write.mock.calls.map(([text]) => text).join("");
  expect(output).toContain("Needs attention: 2 articles");
  expect(output).toContain(`Open deck: ${pathToFileURL(resolve("partial.pptx")).href}`);
  expect(output).toContain("re-run the same command with --resume");
  expect(output).toContain("remove --restart");
  expect(output).toContain("unchanged exhausted budget");
  expect(output).not.toContain("\x1b");
});

test("does not invent deck links for review-only drafts or offer import-only recovery", () => {
  const stream = terminal();
  writeCompletionSummary({
    reviewPath: resolve("review.json"), included: 1, pending: 1, resumable: false, budgetPaused: false,
  }, stream, {});
  const output = stripVTControlCharacters(stream.write.mock.calls.map(([text]) => text).join(""));
  expect(output).not.toContain("Open deck:");
  expect(output).toContain("Open editable content:");
  expect(output).toContain("original source-collection command with --resume");
  expect(output).toContain("--import-json alone cannot restore");
});

test("complete runs do not show an unnecessary resume reminder", () => {
  const stream = terminal();
  writeCompletionSummary({
    presentationPath: resolve("deck.pptx"), included: 1, pending: 0, resumable: false, budgetPaused: false,
  }, stream, {});
  const output = stream.write.mock.calls.map(([text]) => text).join("");
  expect(output).toContain("Complete: 1 article");
  expect(output).not.toContain("--resume");
});
