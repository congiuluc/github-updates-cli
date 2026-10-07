import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { sections, sectionDetailKeys, type Section, type EnrichedPost, type SupportedLanguage } from "./types.js";
import { isAiUsage, type AiUsage } from "./usage.js";

export interface CheckpointConfig {
  contentVersion: number;
  postUrls: string[];
  model: string;
  useAi: boolean;
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: SupportedLanguage[];
}

export interface CheckpointState {
  version: 1;
  config: CheckpointConfig;
  completed: EnrichedPost[];
  usage?: AiUsage;
}

export type ExistingRunAction = "resume" | "restart";

export async function withRunLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID() });
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    let description = "An existing or incomplete run lock was found";
    try {
      const previous: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isRecord(previous) && Number.isSafeInteger(previous.pid) &&
          typeof previous.pid === "number" && previous.pid > 0 &&
          previous.hostname === hostname()) {
        try {
          process.kill(previous.pid, 0);
          description = `A run is already running (PID ${previous.pid})`;
        } catch (probeError) {
          if (!(probeError instanceof Error) || !("code" in probeError)) throw probeError;
          if (probeError.code === "ESRCH") description = `A stale run lock from PID ${previous.pid} was found`;
          else if (probeError.code === "EPERM") description = `A run is already running (PID ${previous.pid})`;
          else throw probeError;
        }
      }
    } catch (readError) {
      if (!(readError instanceof SyntaxError) &&
          !(readError instanceof Error && "code" in readError && readError.code === "ENOENT")) {
        throw new Error(`Could not inspect run lock ${path}: ${String(readError)}`, { cause: readError });
      }
    }
    throw new Error(
      `${description}: ${path}. Remove this lock only after confirming no run is active, then retry with --resume. --restart does not override a run lock.`,
    );
  });
  let failure: { error: unknown } | undefined;
  let ownerWritten = false;
  try {
    try {
      await handle.writeFile(owner, "utf8");
      ownerWritten = true;
    } finally {
      await handle.close();
    }
    return await operation();
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      if (ownerWritten && await readFile(path, "utf8") !== owner) {
        throw new Error(`Run lock ownership changed; preserving ${path}.`);
      }
      await rm(path);
    } catch (error) {
      if (!failure) throw error;
      throw new AggregateError([failure.error, error],
        `${String(failure.error)}\nRun lock cleanup also failed: ${String(error)}`, { cause: failure.error });
    }
  }
}

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
  return value === "en" || value === "it";
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
    isLanguage(value.slidesLanguage) &&
    Array.isArray(value.speakerNotesLanguages) &&
    value.speakerNotesLanguages.length > 0 &&
    value.speakerNotesLanguages.every(isLanguage) &&
    new Set(value.speakerNotesLanguages).size === value.speakerNotesLanguages.length;
}

function isCompletedPost(value: unknown, config: CheckpointConfig): value is EnrichedPost {
  if (!isRecord(value) || !isSection(value.section)) return false;
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
    (value.imageDataUri === undefined || isNonEmptyString(value.imageDataUri));
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
