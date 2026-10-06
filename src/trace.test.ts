import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTraceLogger } from "./trace.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("serializes trace events as JSON lines with a shared run identifier", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-trace-"));
  const path = join(directory, "run.trace.jsonl");
  const trace = createTraceLogger(path);

  await Promise.all([
    trace.log("first_event", { value: 1 }),
    trace.log("second_event", { value: 2 }),
  ]);

  const entries = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries.map((entry) => entry.event)).toEqual(["first_event", "second_event"]);
  expect(entries.every((entry) => entry.runId === trace.runId)).toBe(true);
});

test("streams each trace line during execution in the same order as the file", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-trace-live-"));
  const path = join(directory, "run.trace.jsonl");
  const lines: string[] = [];
  const trace = createTraceLogger(path, {
    onLine: async (line) => {
      await Promise.resolve();
      lines.push(line);
    },
  });

  await trace.log("run_started");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).event).toBe("run_started");

  await Promise.all([
    trace.log("copilot_attempt_started", { prompt: "First line\nSecond line" }),
    trace.log("run_failed", { error: "Service unavailable" }),
  ]);
  expect(lines).toHaveLength(3);
  expect(lines.join("")).toBe(await readFile(path, "utf8"));
  expect(lines.every((line) => line.trim().split("\n").length === 1)).toBe(true);
});

test("does not write to the console by default", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-trace-quiet-"));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await createTraceLogger(join(directory, "run.trace.jsonl")).log("run_started");
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
});

test("propagates live log output failures instead of silently ignoring them", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-trace-failure-"));
  const path = join(directory, "run.trace.jsonl");
  const trace = createTraceLogger(path, {
    onLine: async () => { throw new Error("Output stream failed"); },
  });
  await expect(trace.log("run_started")).rejects.toThrow("Output stream failed");
  expect(await readFile(path, "utf8")).toContain('"event":"run_started"');
});
