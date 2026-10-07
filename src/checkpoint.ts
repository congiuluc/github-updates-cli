import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sections, sectionDetailKeys, type Section, type EnrichedPost, type SupportedLanguage } from "./types.js";
import { isAiUsage, type AiUsage } from "./usage.js";
import { isAudience, type Audience } from "./generation.js";
import { isCanonicalLocale, localizationIssues, parseLocalization, LocalizationValidationError } from "./locales.js";
export { withRunLock } from "./run-lock.js";

export interface CheckpointConfig {
  contentVersion: number;
  postUrls: string[];
  model: string;
  useAi: boolean;
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: SupportedLanguage[];
  audience?: Audience;
  evidence?: boolean;
  regeneration?: string;
}

export interface CheckpointState {
  version: 1;
  config: CheckpointConfig;
  completed: EnrichedPost[];
  usage?: AiUsage;
}

export type ExistingRunAction = "resume" | "restart";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isLanguage(value: unknown): value is SupportedLanguage {
  return isCanonicalLocale(value);
}

function isSection(value: unknown): value is Section {
  return sections.some((section) => section === value);
}

function isConfig(value: unknown): value is CheckpointConfig {
  return isRecord(value) &&
    typeof value.contentVersion === "number" &&
    Number.isSafeInteger(value.contentVersion) && value.contentVersion > 0 &&
    isStringArray(value.postUrls) &&
    new Set(value.postUrls).size === value.postUrls.length &&
    isNonEmptyString(value.model) &&
    typeof value.useAi === "boolean" &&
    (value.audience === undefined || isAudience(value.audience)) &&
    (value.evidence === undefined || typeof value.evidence === "boolean") &&
    (value.regeneration === undefined || typeof value.regeneration === "string") &&
    isLanguage(value.slidesLanguage) &&
    Array.isArray(value.speakerNotesLanguages) &&
    value.speakerNotesLanguages.length > 0 &&
    value.speakerNotesLanguages.every(isLanguage) &&
    new Set(value.speakerNotesLanguages).size === value.speakerNotesLanguages.length;
}

/** Structural persistence guard; AI formatting and source-evidence checks live in content-store. */
export function isCompletedPost(
  value: unknown, config: Pick<CheckpointConfig, "speakerNotesLanguages"> & Partial<Pick<CheckpointConfig, "slidesLanguage" | "useAi">>,
): value is EnrichedPost {
  if (!isRecord(value) || !isSection(value.section)) return false;
  if (value.localization !== undefined || config.useAi) {
    try {
      const localization = parseLocalization(value.localization);
      if (localizationIssues(localization, config.slidesLanguage ?? "en", config.speakerNotesLanguages, config.useAi).length) return false;
    } catch (error) {
      if (!(error instanceof LocalizationValidationError)) throw error;
      return false;
    }
  }
  const details = value.details;
  const speakerNotes = value.speakerNotes;
  return isNonEmptyString(value.title) &&
    isNonEmptyString(value.url) &&
    isNonEmptyString(value.publishedAt) &&
    Number.isFinite(Date.parse(value.publishedAt)) &&
    isNonEmptyString(value.plainText) &&
    typeof value.html === "string" &&
    (value.author === undefined || typeof value.author === "string") &&
    isStringArray(value.imageUrls) &&
    Array.isArray(value.links) &&
    value.links.every((link: unknown) =>
      isRecord(link) && typeof link.label === "string" && isNonEmptyString(link.url)) &&
    isNonEmptyString(value.summary) &&
    isStringArray(value.notes) &&
    isRecord(details) &&
    Object.values(details).every((detail) => typeof detail === "string") &&
    sectionDetailKeys[value.section].every((key) => isNonEmptyString(details[key])) &&
    isRecord(speakerNotes) &&
    Object.values(speakerNotes).every((notes) => typeof notes === "string") &&
    config.speakerNotesLanguages.every((language) => isNonEmptyString(speakerNotes[language])) &&
    (value.imageDataUri === undefined || isNonEmptyString(value.imageDataUri)) &&
    (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.every((entry: unknown) =>
      isRecord(entry) && isNonEmptyString(entry.field) && isNonEmptyString(entry.quote) && isNonEmptyString(entry.url))));
}

function isCheckpoint(value: unknown): value is CheckpointState {
  if (!isRecord(value) || value.version !== 1 || !isConfig(value.config) || !Array.isArray(value.completed)) {
    return false;
  }
  if (value.usage !== undefined && !isAiUsage(value.usage)) return false;
  const config = value.config;
  const selectedUrls = new Set(config.postUrls);
  const completedUrls = new Set<string>();
  return value.completed.every((post: unknown) => {
    if (!isCompletedPost(post, config) || !selectedUrls.has(post.url) || completedUrls.has(post.url)) {
      return false;
    }
    completedUrls.add(post.url);
    return true;
  });
}

export function checkpointMatches(
  checkpoint: CheckpointState,
  config: CheckpointConfig,
): boolean {
  const previous = checkpoint.config;
  return (
    previous.contentVersion === config.contentVersion &&
    previous.model === config.model &&
    previous.useAi === config.useAi &&
    (previous.audience ?? "standard") === (config.audience ?? "standard") &&
    (previous.evidence ?? false) === (config.evidence ?? false) &&
    previous.regeneration === config.regeneration &&
    previous.slidesLanguage === config.slidesLanguage &&
    previous.postUrls.length === config.postUrls.length &&
    previous.postUrls.every((url, index) => url === config.postUrls[index]) &&
    previous.speakerNotesLanguages.length === config.speakerNotesLanguages.length &&
    previous.speakerNotesLanguages.every(
      (language, index) => language === config.speakerNotesLanguages[index],
    )
  );
}

export async function loadCheckpoint(path: string): Promise<CheckpointState | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const parsed: unknown = JSON.parse(content);
  if (!isCheckpoint(parsed)) {
    throw new Error(`Invalid checkpoint file: ${path}`);
  }
  return parsed;
}

export async function saveCheckpoint(path: string, state: CheckpointState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function removeCheckpoint(path: string): Promise<void> {
  await rm(path, { force: true });
}
