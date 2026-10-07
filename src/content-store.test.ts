import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  contentCacheKey, loadContentDocument, readAcceptedContent, saveAcceptedContent, saveContentDocument,
  type GenerationSettings,
} from "./content-store.js";
import { emptyAiUsage } from "./usage.js";
import type { EnrichedPost } from "./types.js";

const settings: GenerationSettings = {
  contentVersion: 6, model: "auto", useAi: false, slidesLanguage: "en",
  speakerNotesLanguages: ["en"], audience: "standard", evidence: false,
};
const article: EnrichedPost = {
  title: "Article", url: "https://example.com/article", publishedAt: "2026-08-15T00:00:00Z",
  plainText: "Readable source.", html: "<p>Readable source.</p>", imageUrls: [], links: [],
  section: "IDE", summary: "Summary.", notes: ["Useful notes"],
  details: { feature: "Feature", availability: "Preview", keyCapabilities: "Improve review", howToUse: "Open the editor" },
  speakerNotes: { en: "Presenter notes." },
};
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("reuses accepted content only for the same source and generation settings", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-content-cache-"));
  await saveAcceptedContent(directory, article, settings);
  expect(await readAcceptedContent(directory, article, settings)).toMatchObject({ summary: "Summary." });
  for (const changed of [
    { ...settings, model: "other" }, { ...settings, audience: "executive" as const },
    { ...settings, slidesLanguage: "it" as const }, { ...settings, evidence: true },
    { ...settings, speakerNotesLanguages: ["en", "it"] as ("en" | "it")[] }, { ...settings, contentVersion: 7 },
  ]) expect(await readAcceptedContent(directory, article, changed)).toBeUndefined();
  expect(await readAcceptedContent(directory, { ...article, plainText: "Changed source." }, settings)).toBeUndefined();
});

test("reports corrupt accepted content rather than silently spending credits to replace it", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-corrupt-cache-"));
  const path = join(directory, `${contentCacheKey(article, settings)}.json`);
  await writeFile(path, JSON.stringify({ version: 1, key: "wrong", content: {} }));
  await expect(readAcceptedContent(directory, article, settings)).rejects.toThrow("use --no-cache");
});

test("round-trips editable content and rejects invalid edits and unsafe source URLs", async () => {
  directory = await mkdtemp(join(tmpdir(), "copilot-content-document-"));
  const path = join(directory, "review.json");
  await saveContentDocument(path, { from: new Date("2026-08-01"), to: new Date("2026-08-31") },
    settings, [article], [], emptyAiUsage());
  const document = await loadContentDocument(path);
  expect(document.articles).toEqual([article]);
  await writeFile(path, JSON.stringify({ ...document, articles: [{ ...article, url: "javascript:alert(1)" }] }));
  await expect(loadContentDocument(path)).rejects.toThrow("Only HTTP(S)");
  await writeFile(path, JSON.stringify({ ...document, articles: [{ ...article, details: {} }] }));
  await expect(loadContentDocument(path)).rejects.toThrow("Invalid source or article");
});
