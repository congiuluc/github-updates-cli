import { sections, sectionDetailKeys, type Section, type SlideDetailKey, type SupportedLanguage } from "./types.js";
import { isRecord } from "./storage.js";

export interface PresentationStrings {
  changelog: string;
  title: string;
  update: string;
  updates: string;
  section: string;
  sectionNames: Record<Section, string>;
  detailLabels: Record<SlideDetailKey, string>;
}

export interface IntroductoryNotes {
  introduction: string;
  sections: Record<Section, string>;
}

export interface DeckLocalization {
  articleTitle?: string;
  evidenceHeading?: string;
  slides?: { locale: SupportedLanguage; text: PresentationStrings };
  speakerNotes?: Partial<Record<SupportedLanguage, IntroductoryNotes>>;
}

export class LocalizationValidationError extends Error {}

/** Canonicalize at input boundaries so note keys, caches and checkpoints use the same locale. */
export function normalizeLocale(value: string, optionName = "language"): SupportedLanguage {
  try {
    const [locale] = Intl.getCanonicalLocales(value.trim());
    if (!locale) throw new RangeError("Empty locale");
    return locale;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new Error(`Invalid ${optionName} locale "${value}". Use a BCP 47 tag such as fr, pt-BR, zh-Hant or ar.`, { cause: error });
  }
}

export function isCanonicalLocale(value: unknown): value is SupportedLanguage {
  if (typeof value !== "string" || !value) return false;
  try { return Intl.getCanonicalLocales(value)[0] === value; }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}

export function builtinLanguage(locale: SupportedLanguage): "en" | "it" | undefined {
  const language = new Intl.Locale(locale).language;
  return language === "en" || language === "it" ? language : undefined;
}

export function localeName(locale: SupportedLanguage, displayLocale = "en"): string {
  const base = new Intl.Locale(locale).baseName;
  return new Intl.DisplayNames([displayLocale], { type: "language" }).of(base) ?? base;
}

export function isRtlLocale(locale: SupportedLanguage): boolean {
  const parsed = new Intl.Locale(locale);
  if ("getTextInfo" in parsed && typeof parsed.getTextInfo === "function") {
    const info: unknown = parsed.getTextInfo();
    if (isRecord(info)) return info.direction === "rtl";
  }
  if ("textInfo" in parsed && isRecord(parsed.textInfo)) return parsed.textInfo.direction === "rtl";
  return new Set(["Arab", "Hebr", "Thaa", "Nkoo", "Adlm", "Rohg", "Syrc", "Mand", "Samr"])
    .has(parsed.maximize().script ?? "");
}

const detailKeys = [...new Set(Object.values(sectionDetailKeys).flat())];
export const localizationTextMaximumCharacters = 2000;
export const localizedArticleTitleMaximumCharacters = 200;

function strings<K extends string>(value: unknown, keys: readonly K[], name: string): Record<K, string> {
  if (!isRecord(value) || keys.some((key) => typeof value[key] !== "string" ||
    !value[key].trim() || value[key].length > localizationTextMaximumCharacters)) {
    throw new LocalizationValidationError(`${name} must contain nonempty translated strings for: ${keys.join(", ")}.`);
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Record<K, string>;
}

/** Validate model/editor-supplied localization; never fill missing translations with invented copy. */
export function parseLocalization(value: unknown): DeckLocalization | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new LocalizationValidationError("localization must be an object.");
  const result: DeckLocalization = {};
  for (const key of ["articleTitle", "evidenceHeading"] as const) {
    if (value[key] !== undefined) result[key] = strings(value, [key], "localization")[key];
  }
  if (result.articleTitle && result.articleTitle.length > localizedArticleTitleMaximumCharacters) {
    throw new LocalizationValidationError(`localization.articleTitle must be at most ${localizedArticleTitleMaximumCharacters} characters.`);
  }
  if (value.slides !== undefined) {
    if (!isRecord(value.slides) || !isCanonicalLocale(value.slides.locale) || !isRecord(value.slides.text)) {
      throw new LocalizationValidationError("localization.slides must contain a canonical locale and translated text.");
    }
    result.slides = {
      locale: value.slides.locale,
      text: {
        ...strings(value.slides.text, ["changelog", "title", "update", "updates", "section"], "localization.slides.text"),
        sectionNames: strings(value.slides.text.sectionNames, sections, "localization.slides.text.sectionNames"),
        detailLabels: strings(value.slides.text.detailLabels, detailKeys, "localization.slides.text.detailLabels"),
      },
    };
  }
  if (value.speakerNotes !== undefined) {
    if (!isRecord(value.speakerNotes)) throw new LocalizationValidationError("localization.speakerNotes must be an object keyed by locale.");
    result.speakerNotes = Object.fromEntries(Object.entries(value.speakerNotes).map(([locale, entry]) => {
      if (!isCanonicalLocale(locale) || !isRecord(entry)) throw new LocalizationValidationError(`Invalid introductory-note locale: ${locale}`);
      return [locale, {
        ...strings(entry, ["introduction"], `localization.speakerNotes.${locale}`),
        sections: strings(entry.sections, sections, `localization.speakerNotes.${locale}.sections`),
      }];
    }));
  }
  return result;
}

/** Completeness and placeholder checks only; translation accuracy still needs human review. */
export function localizationIssues(
  localization: DeckLocalization | undefined, slidesLocale: SupportedLanguage,
  notesLocales: SupportedLanguage[], required = true,
): string[] {
  const issues: string[] = [];
  if (localization?.slides && localization.slides.locale !== slidesLocale) {
    issues.push(`localization.slides.locale must be ${slidesLocale}`);
  }
  if (required && !builtinLanguage(slidesLocale) && !localization?.slides) {
    issues.push(`localization.slides is required to translate the complete deck into ${slidesLocale}`);
  }
  if (required && !builtinLanguage(slidesLocale) && !localization?.articleTitle) {
    issues.push(`localization.articleTitle is required in ${slidesLocale}`);
  }
  if (required && !builtinLanguage(slidesLocale) && !localization?.evidenceHeading) {
    issues.push(`localization.evidenceHeading is required in ${slidesLocale}`);
  }
  for (const locale of notesLocales) {
    const notes = localization?.speakerNotes?.[locale];
    if (required && !builtinLanguage(locale) && !notes) {
      issues.push(`localization.speakerNotes.${locale} is required`);
    }
    if (notes) {
      for (const token of ["{count}", "{from}", "{to}"]) {
        if (!notes.introduction.includes(token)) issues.push(`localization.speakerNotes.${locale}.introduction must retain ${token}`);
      }
      for (const section of sections) if (!notes.sections[section].includes("{count}")) {
        issues.push(`localization.speakerNotes.${locale}.sections.${section} must retain {count}`);
      }
    }
  }
  return issues;
}

export function localizationPrompt(slidesLocale: SupportedLanguage, notesLocales: SupportedLanguage[]): string[] {
  const customNotes = notesLocales.filter((locale) => !builtinLanguage(locale));
  if (builtinLanguage(slidesLocale) && !customNotes.length) return [];
  const shape: Record<string, unknown> = {};
  if (!builtinLanguage(slidesLocale)) {
    shape.articleTitle = "Translate the supplied article title";
    shape.evidenceHeading = "Source evidence: quotations for human review, not an automated factual audit";
    shape.slides = {
      locale: slidesLocale,
      text: {
        changelog: "GITHUB COPILOT - CHANGELOG", title: "What's new in Copilot?",
        update: "UPDATE", updates: "UPDATES", section: "SECTION",
        sectionNames: Object.fromEntries(sections.map((section) => [section, section])),
        detailLabels: Object.fromEntries(detailKeys.map((key) => [key, key])),
      },
    };
  }
  if (customNotes.length) {
    shape.speakerNotes = Object.fromEntries(customNotes.map((locale) => [locale, {
      introduction: "This briefing covers {count} updates published between {from} and {to}.",
      sections: Object.fromEntries(sections.map((section) => [section, `Introduce the {count} updates in the ${section} section.`])),
    }]));
  }
  return [
    `Also return localization using this exact key structure: ${JSON.stringify(shape)}.`,
    `Every localization string must be nonempty and at most ${localizationTextMaximumCharacters} characters. Keep every key in the supplied localization template; translate values only.`,
    ...(!builtinLanguage(slidesLocale) ? [
      `Translate localization.articleTitle, localization.evidenceHeading and all localization.slides.text values into ${localeName(slidesLocale)} (${slidesLocale}); preserve property names and locale tags. localization.articleTitle must be at most ${localizedArticleTitleMaximumCharacters} characters. Keep slide titles and card labels concise.`,
    ] : []),
    ...(customNotes.length ? [
      "Translate each localization.speakerNotes entry into its keyed locale. Each introduction must retain literal {count}, {from} and {to}; every section introduction must retain {count}. These are neutral cover/section introductions, not additional article claims.",
    ] : []),
  ];
}
