import { createHash } from "node:crypto";
import { join } from "node:path";
import { isCompletedPost } from "./checkpoint.js";
import { evidenceIssues, isAudience, type Audience } from "./generation.js";
import { isRecord, readJson, writeJson } from "./storage.js";
import { isAiUsage, type AiUsage } from "./usage.js";
import { isCanonicalLocale, localizationIssues, parseLocalization } from "./locales.js";
import type { ChangelogPost, DateRange, EnrichedPost, GeneratedContent, SupportedLanguage } from "./types.js";

export interface GenerationSettings {
  contentVersion: number;
  model: string;
  useAi: boolean;
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: SupportedLanguage[];
  audience: Audience;
  evidence: boolean;
}

export interface ContentDocument {
  version: 1;
  range: { from: string; to: string };
  settings: GenerationSettings;
  articles: EnrichedPost[];
  omittedUrls: string[];
  usage: AiUsage;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sourceFingerprint(post: ChangelogPost): string {
  return fingerprint([post.url, post.title, post.publishedAt, post.plainText, post.html, post.imageUrls, post.links]);
}

/** Exclude date ranges and output formats; include every setting that changes generated text. */
export function contentCacheKey(post: ChangelogPost, settings: GenerationSettings): string {
  return fingerprint([1, sourceFingerprint(post), settings.contentVersion, settings.model, settings.useAi,
    settings.slidesLanguage, settings.speakerNotesLanguages, settings.audience, settings.evidence]);
}

export function generatedContent(post: EnrichedPost): GeneratedContent {
  return {
    section: post.section, summary: post.summary, notes: post.notes, details: post.details,
    speakerNotes: post.speakerNotes, ...(post.evidence ? { evidence: post.evidence } : {}),
    ...(post.localization ? { localization: post.localization } : {}),
  };
}

export async function validateArticle(post: unknown, settings: GenerationSettings, description: string): Promise<void> {
  if (!isCompletedPost(post, settings)) throw new Error(`Invalid article in ${description}: missing or malformed source/content fields.`);
  for (const url of [post.url, ...post.imageUrls, ...post.links.map((link) => link.url)]) {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch (error) { throw new Error(`Invalid URL ${url} in ${description}.`, { cause: error }); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Only HTTP(S) source URLs are allowed in ${description}: ${url}`);
    }
  }
  if (post.imageDataUri && !/^data:image\/(?:png|jpeg|gif);base64,[a-zA-Z0-9+/=\r\n]+$/.test(post.imageDataUri)) {
    throw new Error(`Invalid embedded article image in ${description}. Only PNG, JPEG and GIF data URIs are allowed.`);
  }
  const problems = evidenceIssues(post, post, settings.speakerNotesLanguages, settings.evidence);
  problems.push(...localizationIssues(parseLocalization(post.localization), settings.slidesLanguage,
    settings.speakerNotesLanguages, settings.useAi));
  if (settings.useAi) {
    const { slideContentIssues } = await import("./enricher.js");
    problems.push(...slideContentIssues(post, post.title, post.section, settings.speakerNotesLanguages, settings.slidesLanguage));
  }
  if (problems.length) throw new Error(`Invalid article "${post.title}" in ${description}: ${problems.join("; ")}`);
}

function isSettings(value: unknown): value is GenerationSettings {
  return isRecord(value) && Number.isSafeInteger(value.contentVersion) && Number(value.contentVersion) > 0 &&
    typeof value.model === "string" && value.model.trim().length > 0 && typeof value.useAi === "boolean" &&
    isCanonicalLocale(value.slidesLanguage) &&
    Array.isArray(value.speakerNotesLanguages) && value.speakerNotesLanguages.length > 0 &&
    value.speakerNotesLanguages.every(isCanonicalLocale) &&
    new Set(value.speakerNotesLanguages).size === value.speakerNotesLanguages.length &&
    isAudience(value.audience) && typeof value.evidence === "boolean";
}

/** Validate editable input before it reaches exporters or any paid regeneration request. */
export async function loadContentDocument(path: string): Promise<ContentDocument> {
  const value = await readJson(path);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.range) ||
    typeof value.range.from !== "string" || typeof value.range.to !== "string" ||
    !Number.isFinite(Date.parse(value.range.from)) || !Number.isFinite(Date.parse(value.range.to)) ||
    Date.parse(value.range.from) > Date.parse(value.range.to) ||
    !isSettings(value.settings) || !Array.isArray(value.articles) ||
    !Array.isArray(value.omittedUrls) || !value.omittedUrls.every((url) => typeof url === "string") ||
    !isAiUsage(value.usage)) {
    throw new Error(`Invalid content document ${path}. Expected a version 1 exported briefing.`);
  }
  const articles: EnrichedPost[] = [];
  const urls = new Set<string>();
  for (const post of value.articles) {
    if (!isCompletedPost(post, value.settings)) throw new Error(`Invalid source or article fields in ${path}.`);
    if (urls.has(post.url)) throw new Error(`Duplicate article URL ${post.url} in ${path}.`);
    urls.add(post.url);
    await validateArticle(post, value.settings, path);
    articles.push(post);
  }
  return {
    version: 1, range: { from: value.range.from, to: value.range.to },
    settings: value.settings, articles, omittedUrls: value.omittedUrls, usage: value.usage,
  };
}

export async function saveContentDocument(
  path: string, range: DateRange, settings: GenerationSettings, articles: EnrichedPost[], omittedUrls: string[], usage: AiUsage,
): Promise<void> {
  await writeJson(path, {
    version: 1, range: { from: range.from.toISOString(), to: range.to.toISOString() },
    settings, articles, omittedUrls, usage,
  } satisfies ContentDocument);
}

/** Only an absent file is a cache miss. Invalid entries must not silently trigger paid regeneration. */
export async function readAcceptedContent(
  directory: string, post: ChangelogPost, settings: GenerationSettings,
): Promise<GeneratedContent | undefined> {
  const key = contentCacheKey(post, settings);
  const path = join(directory, `${key}.json`);
  const entry = await readJson(path);
  if (entry === undefined) return undefined;
  if (!isRecord(entry) || entry.version !== 1 || entry.key !== key || !isRecord(entry.content) ||
    Object.keys(entry.content).some((name) => !["section", "summary", "notes", "details", "speakerNotes", "evidence", "localization"].includes(name))) {
    throw new Error(`Invalid accepted-content cache ${path}. Remove that file or use --no-cache.`);
  }
  const combined = { ...post, ...entry.content };
  if (!isCompletedPost(combined, settings)) throw new Error(`Invalid content in cache ${path}. Remove that file or use --no-cache.`);
  await validateArticle(combined, settings, path);
  return generatedContent(combined);
}

export async function saveAcceptedContent(directory: string, post: EnrichedPost, settings: GenerationSettings): Promise<void> {
  const key = contentCacheKey(post, settings);
  await writeJson(join(directory, `${key}.json`), { version: 1, key, content: generatedContent(post) });
}
