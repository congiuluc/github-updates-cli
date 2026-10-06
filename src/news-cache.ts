import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const NEWS_INDEX_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
export const NEWS_ARTICLE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedNews {
  version: 1;
  url: string;
  cachedAt: number;
  content: string;
}

interface NewsCacheOptions {
  cacheDirectory?: string;
  now?: () => number;
}

const pendingReads = new Map<string, Promise<string>>();

export function defaultNewsCacheDirectory(): string {
  return join(tmpdir(), "copilot-changelog-cli", "news-v1");
}

function cachePath(cacheDirectory: string, url: string): string {
  const key = createHash("sha256").update(url).digest("hex");
  return join(cacheDirectory, `${key}.json`);
}

async function readFreshEntry(
  path: string,
  url: string,
  maximumAgeMs: number,
  now: number,
): Promise<string | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    typeof entry !== "object" || entry === null || Array.isArray(entry) ||
    !("version" in entry) || entry.version !== 1 ||
    !("url" in entry) || entry.url !== url ||
    !("cachedAt" in entry) || typeof entry.cachedAt !== "number" || !Number.isFinite(entry.cachedAt) ||
    !("content" in entry) || typeof entry.content !== "string" ||
    entry.cachedAt > now ||
    now - entry.cachedAt > maximumAgeMs
  ) {
    return undefined;
  }
  return entry.content;
}

async function writeEntry(path: string, entry: CachedNews): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(entry), "utf8");
  try {
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readThroughNewsCache(
  url: string,
  maximumAgeMs: number,
  fetchContent: () => Promise<string>,
  options: NewsCacheOptions = {},
): Promise<string> {
  const cacheDirectory = options.cacheDirectory ?? defaultNewsCacheDirectory();
  const path = cachePath(cacheDirectory, url);
  const pending = pendingReads.get(path);
  if (pending) return pending;

  const operation = (async () => {
    const now = options.now?.() ?? Date.now();
    const cached = await readFreshEntry(path, url, maximumAgeMs, now);
    if (cached !== undefined) return cached;

    const content = await fetchContent();
    await writeEntry(path, { version: 1, url, cachedAt: now, content });
    return content;
  })();
  pendingReads.set(path, operation);
  try {
    return await operation;
  } finally {
    pendingReads.delete(path);
  }
}
