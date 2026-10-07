import { expect, test } from "vitest";
import {
  defaultFrom, parseExecutionControls, parseSpeakerNotesLanguages, rangeFromOptions,
} from "./run-options.js";

const controls = { resume: false, restart: false, requestTimeout: "180", concurrency: "1" };

test("converts numeric controls without changing CLI defaults", () => {
  expect(parseExecutionControls(controls)).toEqual({
    requestTimeoutMs: 180_000, concurrency: 1, limit: undefined,
  });
  expect(parseExecutionControls({ ...controls, requestTimeout: "2147483", concurrency: "8", limit: "10" }))
    .toEqual({ requestTimeoutMs: 2_147_483_000, concurrency: 8, limit: 10 });
  expect(() => parseExecutionControls({ ...controls, resume: true, restart: true }))
    .toThrow("--resume and --restart cannot be used together.");
});

test.each([
  ["requestTimeout", "0", "--request-timeout"],
  ["requestTimeout", "1.5", "--request-timeout"],
  ["requestTimeout", "180s", "--request-timeout"],
  ["requestTimeout", "2147484", "--request-timeout"],
  ["concurrency", "0", "--concurrency"],
  ["concurrency", "9", "--concurrency"],
  ["concurrency", "2workers", "--concurrency"],
  ["limit", "0", "--limit"],
  ["limit", "1garbage", "--limit"],
  ["limit", "9007199254740992", "--limit"],
] as const)("rejects %s=%s before starting work", (key, value, flag) => {
  expect(() => parseExecutionControls({ ...controls, [key]: value })).toThrow(`Invalid ${flag}`);
});

test("canonicalizes requested note locales while preserving their first-requested order", () => {
  expect(parseSpeakerNotesLanguages(" FR-ca,ja,fr-CA,ar ")).toEqual(["fr-CA", "ja", "ar"]);
  expect(() => parseSpeakerNotesLanguages("")).toThrow("--speaker-notes-languages");
  expect(() => parseSpeakerNotesLanguages("en,,ja")).toThrow("--speaker-notes-languages");
});

test("uses inclusive UTC date ranges and rejects invalid calendar dates", () => {
  const range = rangeFromOptions({ from: "2024-02-29", to: "2024-03-01" });
  expect(range.from.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  expect(range.to.toISOString()).toBe("2024-03-01T23:59:59.999Z");
  expect(() => rangeFromOptions({ from: "2026-02-29", to: "2026-03-01" })).toThrow("Invalid calendar date");
  expect(() => rangeFromOptions({ from: "2026-8-1", to: "2026-08-31" })).toThrow("Expected YYYY-MM-DD");
  expect(() => rangeFromOptions({ from: "2026-09-01", to: "2026-08-31" })).toThrow("--from");
});

test("computes the default start without mutating its input clock", () => {
  const now = new Date("2026-10-07T08:00:00Z");
  expect(defaultFrom(now)).toBe("2026-09-07");
  expect(now.toISOString()).toBe("2026-10-07T08:00:00.000Z");
});
