import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readThroughNewsCache } from "./news-cache.js";

let cacheDirectory: string | undefined;

afterEach(async () => {
  if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  cacheDirectory = undefined;
});

test("reuses a fresh local news copy", async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-news-cache-"));
  const fetchContent = vi.fn().mockResolvedValue("<article>News</article>");

  const first = await readThroughNewsCache("https://example.com/news", 60_000, fetchContent, {
    cacheDirectory,
    now: () => 1_000,
  });
  const second = await readThroughNewsCache("https://example.com/news", 60_000, fetchContent, {
    cacheDirectory,
    now: () => 2_000,
  });

  expect(first).toBe("<article>News</article>");
  expect(second).toBe(first);
  expect(fetchContent).toHaveBeenCalledTimes(1);
});

test("refreshes an expired local news copy", async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-news-cache-"));
  const fetchContent = vi.fn()
    .mockResolvedValueOnce("old")
    .mockResolvedValueOnce("new");

  await readThroughNewsCache("https://example.com/news", 60_000, fetchContent, {
    cacheDirectory,
    now: () => 1_000,
  });
  const refreshed = await readThroughNewsCache(
    "https://example.com/news",
    60_000,
    fetchContent,
    { cacheDirectory, now: () => 62_000 },
  );

  expect(refreshed).toBe("new");
  expect(fetchContent).toHaveBeenCalledTimes(2);
});

test("deduplicates concurrent downloads of the same news URL", async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-news-cache-"));
  const fetchContent = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "news";
  });

  const results = await Promise.all([
    readThroughNewsCache("https://example.com/news", 60_000, fetchContent, { cacheDirectory }),
    readThroughNewsCache("https://example.com/news", 60_000, fetchContent, { cacheDirectory }),
  ]);

  expect(results).toEqual(["news", "news"]);
  expect(fetchContent).toHaveBeenCalledTimes(1);
});

test.each(["null", "[]", '"string"', "42", "{broken", '{"version":1,"cachedAt":null}'])(
  "refreshes a malformed cached record: %s", async (content) => {
    cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-news-cache-invalid-"));
    const url = "https://example.com/news";
    const path = join(cacheDirectory, `${createHash("sha256").update(url).digest("hex")}.json`);
    await writeFile(path, content);
    const fetchContent = vi.fn().mockResolvedValue("fresh source");
    await expect(readThroughNewsCache(url, 60_000, fetchContent, { cacheDirectory }))
      .resolves.toBe("fresh source");
    expect(fetchContent).toHaveBeenCalledTimes(1);
  },
);
