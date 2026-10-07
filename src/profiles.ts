import { dirname, resolve } from "node:path";
import { isRecord, readJson } from "./storage.js";

export interface ProfileOptions {
  from?: string;
  to?: string;
  output?: string;
  model?: string;
  limit?: string;
  feed?: string;
  rss?: string[];
  includeAiMl?: boolean;
  ai?: boolean;
  website?: boolean;
  concurrency?: string;
  requestTimeout?: string;
  slidesLanguage?: string;
  speakerNotesLanguages?: string;
  include?: string[];
  exclude?: string[];
  maxCredits?: string;
  cache?: boolean;
  cacheDir?: string;
  stateDir?: string;
  fullArticles?: boolean;
  audience?: string;
  evidence?: boolean;
}

const strings = new Set(["from", "to", "output", "model", "feed", "slidesLanguage", "speakerNotesLanguages",
  "cacheDir", "stateDir", "audience"]);
const numbers = new Set(["limit", "concurrency", "requestTimeout", "maxCredits"]);
const booleans = new Set(["includeAiMl", "ai", "website", "cache", "fullArticles", "evidence"]);
const arrays = new Set(["rss", "include", "exclude"]);

function profileValues(value: unknown, directory: string, description: string): ProfileOptions {
  if (!isRecord(value)) throw new Error(`${description} must be a JSON object.`);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (strings.has(key)) {
      if (typeof entry !== "string" || !entry.trim()) throw new Error(`${description}.${key} must be a nonempty string.`);
      result[key] = entry.trim();
    } else if (numbers.has(key)) {
      if ((typeof entry !== "number" && typeof entry !== "string") || !/^\d+(?:\.\d+)?$/.test(String(entry))) {
        throw new Error(`${description}.${key} must be a nonnegative decimal number.`);
      }
      result[key] = String(entry);
    } else if (booleans.has(key)) {
      if (typeof entry !== "boolean") throw new Error(`${description}.${key} must be true or false.`);
      result[key] = entry;
    } else if (arrays.has(key)) {
      if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string" && item.trim())) {
        throw new Error(`${description}.${key} must be an array of nonempty strings.`);
      }
      result[key] = entry.map((item: string) => item.trim());
    } else {
      throw new Error(`Unknown profile option ${description}.${key}. Credentials and execution actions do not belong in profiles.`);
    }
  }
  for (const key of ["output", "cacheDir", "stateDir", "feed"]) {
    const path = result[key];
    if (typeof path === "string" && !/^https?:\/\//i.test(path)) result[key] = resolve(directory, path);
  }
  if (Array.isArray(result.rss)) result.rss = result.rss.map((path: string) =>
    /^https?:\/\//i.test(path) ? path : resolve(directory, path));
  return result;
}

/**
 * Resolve file defaults, then the selected profile; the CLI applies explicit flags last.
 * Profile paths are relative to this file, unlike command-line paths. No implicit file read.
 */
export async function loadProfile(config: string | undefined, name: string | undefined): Promise<ProfileOptions> {
  if (!config && !name) return {};
  const path = resolve(config ?? ".copilot-changelog.json");
  const document = await readJson(path);
  if (!isRecord(document) || document.version !== 1 || !isRecord(document.profiles) ||
    Object.keys(document).some((key) => !["version", "defaults", "profiles"].includes(key))) {
    throw new Error(`Invalid profile file ${path}. Expected version: 1, optional defaults, and a profiles object.`);
  }
  const defaults = profileValues(document.defaults ?? {}, dirname(path), "defaults");
  const profiles = new Map(Object.entries(document.profiles).map(([key, value]) =>
    [key, profileValues(value, dirname(path), `profiles.${key}`)]));
  if (name && !profiles.has(name)) {
    throw new Error(`Profile "${name}" was not found in ${path}. Available profiles: ${[...profiles.keys()].join(", ") || "(none)"}.`);
  }
  return { ...defaults, ...(name ? profiles.get(name) : {}) };
}
