import type { ProfileOptions } from "./profiles.js";
import { normalizeLocale } from "./locales.js";
import type { Audience } from "./generation.js";
import type { DateRange, SupportedLanguage } from "./types.js";

/** Commander/profile values before conversion to numeric controls and canonical locale lists. */
export interface CliOptions extends ProfileOptions {
  from: string;
  to: string;
  output: string;
  model: string;
  limit?: string;
  feed?: string;
  rss: string[];
  includeAiMl: boolean;
  ai: boolean;
  website: boolean;
  resume: boolean;
  restart: boolean;
  verbose: boolean;
  concurrency: string;
  requestTimeout: string;
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: string;
  config?: string;
  profile?: string;
  dryRun: boolean;
  include: string[];
  exclude: string[];
  cache: boolean;
  exportJson?: string;
  importJson?: string;
  reviewOnly: boolean;
  fullArticles: boolean;
  sinceLastRun: boolean;
  audience: Audience;
  evidence: boolean;
  regenerate: string[];
  regenerateField: string[];
  regenerateLanguage: string[];
}

/** Bump only when accepted content becomes incompatible; not for refactors or layout-only edits. */
export const contentVersion = 6;

export function parseLanguage(value: string, optionName: string): SupportedLanguage {
  return normalizeLocale(value, optionName);
}

export function parseSpeakerNotesLanguages(value: string): SupportedLanguage[] {
  const languages = [...new Set(value.split(",").map((item) => parseLanguage(item, "--speaker-notes-languages")))];
  if (!languages.length) throw new Error("--speaker-notes-languages requires at least one language.");
  return languages;
}

function parseDate(value: string, endOfDay: boolean): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date "${value}".`);
  }
  return date;
}

export function rangeFromOptions(options: Pick<CliOptions, "from" | "to">): DateRange {
  const range = { from: parseDate(options.from, false), to: parseDate(options.to, true) };
  if (range.from > range.to) throw new Error("--from must be earlier than or equal to --to.");
  return range;
}

export function defaultFrom(now = new Date()): string {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}

export interface ExecutionControls {
  requestTimeoutMs: number;
  limit?: number;
  concurrency: number;
}

/** Validate execution limits before acquiring locks, downloading sources or spending credits. */
export function parseExecutionControls(
  options: Pick<CliOptions, "resume" | "restart" | "requestTimeout" | "limit" | "concurrency">,
): ExecutionControls {
  if (options.resume && options.restart) {
    throw new Error("--resume and --restart cannot be used together.");
  }
  const requestTimeoutMs = Number(options.requestTimeout) * 1000;
  if (!/^\d+$/.test(options.requestTimeout) || !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1000 || requestTimeoutMs > 2_147_483_647) {
    throw new Error(`Invalid --request-timeout value "${options.requestTimeout}". Use a positive whole number of seconds up to 2147483.`);
  }
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (options.limit !== undefined &&
    (!/^\d+$/.test(options.limit) || !Number.isSafeInteger(limit) || Number(options.limit) < 1)) {
    throw new Error(
      `Invalid --limit value "${options.limit}". Use a positive whole number, for example --limit 10.`,
    );
  }
  const concurrency = Number(options.concurrency);
  if (!/^\d+$/.test(options.concurrency) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error(`Invalid --concurrency value "${options.concurrency}". Use an integer from 1 to 8.`);
  }
  return { requestTimeoutMs, limit, concurrency };
}
