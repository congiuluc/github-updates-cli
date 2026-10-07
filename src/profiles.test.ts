import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadProfile } from "./profiles.js";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("loads a named profile over defaults with config-relative paths and numeric options", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-profiles-"));
  const path = join(directory, "profiles.json");
  await writeFile(path, JSON.stringify({
    version: 1, defaults: { model: "auto", concurrency: 1, website: true },
    profiles: { team: { concurrency: 2, output: "briefings", rss: ["news.xml", "https://example.com/rss"], audience: "developer" } },
  }));
  expect(await loadProfile(path, "team")).toEqual({
    model: "auto", concurrency: "2", website: true, output: join(directory, "briefings"),
    rss: [join(directory, "news.xml"), "https://example.com/rss"], audience: "developer",
  });
  await expect(loadProfile(path, "missing")).rejects.toThrow('Profile "missing"');
});

test.each([{ token: "not-a-real-token" }, { rss: [5] }, { ai: "false" }, { concurrency: -1 }])(
  "rejects invalid profile values instead of silently ignoring them: %j", async (options) => {
    directory = await mkdtemp(join(tmpdir(), "copilot-bad-profile-"));
    const path = join(directory, "profiles.json");
    await writeFile(path, JSON.stringify({ version: 1, profiles: { team: options } }));
    await expect(loadProfile(path, "team")).rejects.toThrow();
  },
);

test("does not implicitly load a profile for existing commands", async () => {
  expect(await loadProfile(undefined, undefined)).toEqual({});
});
