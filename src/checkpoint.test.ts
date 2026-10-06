import { join } from "node:path";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  checkpointMatches,
  loadCheckpoint,
  saveCheckpoint,
  withRunLock,
  type CheckpointState,
} from "./checkpoint.js";

let directory: string | undefined;

test("rejects competing runs without changing the owner's checkpoint or lock", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-run-lock-"));
  const path = join(directory, "run.lock");
  await withRunLock(path, async () => {
    const owner = await readFile(path, "utf8");
    await expect(withRunLock(path, async () => {})).rejects.toThrow("already running");
    expect(await readFile(path, "utf8")).toBe(owner);
  });
  await expect(access(path)).rejects.toThrow();
  await expect(withRunLock(path, async () => "recovered")).resolves.toBe("recovered");
});

test("releases the run lock when generation fails", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-run-lock-error-"));
  const path = join(directory, "run.lock");
  await expect(withRunLock(path, async () => {
    throw new Error("Generation failed");
  })).rejects.toThrow("Generation failed");
  await expect(access(path)).rejects.toThrow();
});

test.each([
  ["invalid", "{incomplete"],
  ["stale", JSON.stringify({ pid: 2147483647, hostname: hostname(), token: "old" })],
  ["another host", JSON.stringify({ pid: process.pid, hostname: "another-host", token: "old" })],
])("preserves an %s lock and gives explicit recovery instructions", async (_name, content) => {
  directory = await mkdtemp(join(tmpdir(), "copilot-run-lock-stale-"));
  const path = join(directory, "run.lock");
  await writeFile(path, content);
  await expect(withRunLock(path, async () => {})).rejects.toThrow("confirming no run is active");
  expect(await readFile(path, "utf8")).toBe(content);
});

function validCheckpoint(): CheckpointState {
  return {
    version: 1,
    config: {
      contentVersion: 6,
      postUrls: ["https://example.com/update"],
      model: "auto",
      useAi: true,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
    },
    completed: [{
      title: "Update", url: "https://example.com/update",
      publishedAt: "2026-08-15T12:00:00Z", plainText: "Article content.", html: "<p>Article content.</p>",
      imageUrls: [], links: [], section: "IDE", summary: "Improves review.",
      notes: ["Review changes"],
      details: {
        feature: "Review changes", availability: "Available in VS Code",
        keyCapabilities: "Improve review", howToUse: "Open the editor",
      },
      speakerNotes: { en: "Explain the update." },
    }],
  };
}

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("persists and reloads completed entries", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-checkpoint-"));
  const path = join(directory, "checkpoint.json");
  const state: CheckpointState = {
    version: 1,
    config: {
      contentVersion: 2,
      postUrls: ["https://example.com/update"],
      model: "auto",
      useAi: true,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en", "it"],
    },
    completed: [],
  };

  await saveCheckpoint(path, state);

  await expect(loadCheckpoint(path)).resolves.toEqual(state);
  expect(checkpointMatches(state, state.config)).toBe(true);
  expect(checkpointMatches(state, { ...state.config, slidesLanguage: "it" })).toBe(false);
  expect(checkpointMatches(state, { ...state.config, contentVersion: 6 })).toBe(false);
});

test("accepts a fully populated checkpoint and validates its compatibility", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-checkpoint-valid-"));
  const path = join(directory, "checkpoint.json");
  const state = validCheckpoint();
  await saveCheckpoint(path, state);
  expect(await loadCheckpoint(path)).toEqual(state);
  expect(checkpointMatches(state, state.config)).toBe(true);
});

test.each([
  ["null", () => null],
  ["missing language array", (state: CheckpointState) => ({ ...state, config: { ...state.config, speakerNotesLanguages: undefined } })],
  ["invalid language", (state: CheckpointState) => ({ ...state, config: { ...state.config, slidesLanguage: "fr" } })],
  ["invalid content version", (state: CheckpointState) => ({ ...state, config: { ...state.config, contentVersion: "4" } })],
  ["non-string URL", (state: CheckpointState) => ({ ...state, config: { ...state.config, postUrls: [42] } })],
  ["duplicate URLs", (state: CheckpointState) => ({ ...state, config: { ...state.config, postUrls: [...state.config.postUrls, ...state.config.postUrls] } })],
  ["incomplete completed entry", (state: CheckpointState) => ({ ...state, completed: [{ url: state.config.postUrls[0] }] })],
  ["null completed entry", (state: CheckpointState) => ({ ...state, completed: [null] })],
  ["missing required details", (state: CheckpointState) => ({ ...state, completed: [{ ...state.completed[0], details: {} }] })],
  ["missing requested notes", (state: CheckpointState) => ({ ...state, completed: [{ ...state.completed[0], speakerNotes: {} }] })],
  ["invalid date", (state: CheckpointState) => ({ ...state, completed: [{ ...state.completed[0], publishedAt: "invalid" }] })],
  ["empty source", (state: CheckpointState) => ({ ...state, completed: [{ ...state.completed[0], plainText: "" }] })],
  ["malformed links", (state: CheckpointState) => ({ ...state, completed: [{ ...state.completed[0], links: [{ label: "Docs" }] }] })],
  ["foreign completed URL", (state: CheckpointState) => ({ ...state, completed: [{ ...state.completed[0], url: "https://example.com/other" }] })],
  ["duplicate completed entry", (state: CheckpointState) => ({ ...state, completed: [...state.completed, ...state.completed] })],
] as const)("rejects a structurally invalid checkpoint: %s", async (_name, malformed) => {
  directory = await mkdtemp(join(tmpdir(), "copilot-checkpoint-invalid-"));
  const path = join(directory, "checkpoint.json");
  await writeFile(path, JSON.stringify(malformed(validCheckpoint())));
  await expect(loadCheckpoint(path)).rejects.toThrow("Invalid checkpoint file:");
});
