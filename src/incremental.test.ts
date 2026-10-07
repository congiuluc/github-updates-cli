import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { beginIncremental, completeIncremental, incrementalRange, loadIncrementalState } from "./incremental.js";

test("recovers the exact unfinished range and advances only after successful completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-incremental-"));
  const path = join(directory, "state.json");
  const requested = { from: new Date("2026-08-01"), to: new Date("2026-08-31T23:59:59.999Z") };
  try {
    const state = await loadIncrementalState(path, "team");
    const range = incrementalRange(requested, state, new Date("2026-08-25T10:00:00Z"))!;
    expect(range.to.toISOString()).toBe("2026-08-25T10:00:00.000Z");
    await beginIncremental(path, state, range);
    const recovered = await loadIncrementalState(path, "team");
    expect(incrementalRange(requested, recovered, new Date("2026-09-01"))).toEqual(range);
    expect(recovered.through).toBeUndefined();
    await completeIncremental(path, recovered, range, ["https://example.com/one"], ["2026-08-10"]);
    const completed = await loadIncrementalState(path, "team");
    expect(completed.pending).toBeUndefined();
    expect(completed.nextFrom).toBe("2026-08-10T00:00:00.000Z");
    expect(completed.deliveredUrls).toEqual(["https://example.com/one"]);
    expect(incrementalRange(requested, completed)!.from.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    await expect(loadIncrementalState(path, "other-profile")).rejects.toThrow("Invalid incremental state");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
