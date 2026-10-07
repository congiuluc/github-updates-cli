import type { AssistantUsageEvent, SessionEventHandler } from "@github/copilot-sdk";
import { expect, test, vi } from "vitest";
import { createUsageTracker, emptyAiUsage, formatAiUsage, addAiUsage, isAiUsage } from "./usage.js";

function session() {
  let listener: SessionEventHandler | undefined;
  return {
    on: vi.fn((handler: SessionEventHandler) => {
      listener = handler;
      return () => { listener = undefined; };
    }),
    emit(id: string, data: AssistantUsageEvent["data"]) {
      listener?.({ id, data, type: "assistant.usage", ephemeral: true, timestamp: "", parentId: null });
    },
  };
}

test("captures concurrent sessions, retries and reviewer usage without duplicate events", async () => {
  const saved = vi.fn().mockResolvedValue(undefined);
  const tracker = createUsageTracker(saved);
  const primary = session();
  const reviewer = session();
  const a = tracker.watch(primary);
  const b = tracker.watch(reviewer);
  await Promise.all([a.startRequest(), b.startRequest()]);
  primary.emit("a", { model: "model", inputTokens: 10, outputTokens: 3, copilotUsage: { totalNanoAiu: 1_250_000_000 } });
  primary.emit("a", { model: "model", inputTokens: 10, outputTokens: 3, copilotUsage: { totalNanoAiu: 1_250_000_000 } });
  reviewer.emit("b", { model: "model", inputTokens: 20, outputTokens: 4, copilotUsage: { totalNanoAiu: 500_000_000 } });
  await a.startRequest();
  primary.emit("c", { model: "model", copilotUsage: { totalNanoAiu: 250_000_000 } });
  a.dispose();
  b.dispose();
  await tracker.flush();
  expect(saved.mock.calls.at(-1)?.[0]).toEqual({
    ...emptyAiUsage(), requests: 3, usageEvents: 3, creditReports: 3,
    totalNanoAiu: 2_000_000_000, inputTokens: 30, outputTokens: 7,
  });
});

test("persists pending requests before sending and never calls premium multipliers AI credits", async () => {
  const saved = vi.fn().mockResolvedValue(undefined);
  const tracker = createUsageTracker(saved);
  const sdkSession = session();
  const watched = tracker.watch(sdkSession);
  await watched.startRequest();
  expect(saved.mock.calls[0][0].unreportedRequests).toBe(1);
  sdkSession.emit("cost-only", { model: "model", cost: 5, inputTokens: 50 });
  await tracker.flush();
  const usage = saved.mock.calls.at(-1)![0];
  expect(usage.totalNanoAiu).toBe(0);
  expect(formatAiUsage(usage)).toContain("unavailable");
  expect(formatAiUsage({ ...usage, totalNanoAiu: 1e9, creditReports: 1, historyIncomplete: true }))
    .toContain("at least 1");
});

test("accounts for late usage during abort and sessions without usage support", async () => {
  const saved = vi.fn().mockResolvedValue(undefined);
  const tracker = createUsageTracker(saved);
  const sdkSession = session();
  const watched = tracker.watch(sdkSession);
  await watched.startRequest();
  watched.markInterrupted();
  sdkSession.emit("during-abort", { model: "model", copilotUsage: { totalNanoAiu: 0 } });
  watched.dispose();
  await tracker.watch({}).startRequest();
  await tracker.flush();
  expect(saved.mock.calls.at(-1)?.[0]).toMatchObject({
    requests: 2, unreportedRequests: 1, creditReports: 1, totalNanoAiu: 0, historyIncomplete: true,
  });
});

test("surfaces persistence and malformed SDK usage errors without unhandled rejections", async () => {
  const tracker = createUsageTracker(async () => { throw new Error("Disk full"); });
  await expect(tracker.watch({}).startRequest()).rejects.toThrow("Disk full");
  const invalid = createUsageTracker(async () => {});
  const sdkSession = session();
  const watched = invalid.watch(sdkSession);
  await watched.startRequest();
  sdkSession.emit("invalid", { model: "model", copilotUsage: { totalNanoAiu: -1 } });
  await expect(invalid.flush()).rejects.toThrow("Invalid Copilot usage");
});

test("adds current usage to resumed totals without double counting and validates checkpoints", () => {
  const previous = { ...emptyAiUsage(), totalNanoAiu: 2e9, requests: 2, creditReports: 2, usageEvents: 2 };
  const current = { ...emptyAiUsage(), totalNanoAiu: 0.5e9, requests: 1, creditReports: 1, usageEvents: 1 };
  const total = addAiUsage(previous, current);
  expect(total.totalNanoAiu).toBe(2.5e9);
  expect(formatAiUsage(total)).toContain("2.5");
  expect(isAiUsage(total)).toBe(true);
  expect(isAiUsage({ ...total, totalNanoAiu: -1 })).toBe(false);
  expect(isAiUsage({ ...total, requests: "3" })).toBe(false);
  expect(isAiUsage({ ...total, unreportedRequests: 4 })).toBe(false);
  expect(isAiUsage({ ...total, creditReports: 4 })).toBe(false);
  expect(formatAiUsage(emptyAiUsage())).toContain("0");
});
