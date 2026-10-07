import { expect, test } from "vitest";
import {
  builtinLanguage, isCanonicalLocale, isRtlLocale, localeName, localizationIssues,
  localizationPrompt, normalizeLocale, parseLocalization,
  localizedArticleTitleMaximumCharacters, localizationTextMaximumCharacters,
} from "./locales.js";
import { slideContentIssues, type GeneratedContent } from "./enricher.js";

test.each([
  ["FR-ca", "fr-CA"], ["zh-hant", "zh-Hant"], ["sr-latn-rs", "sr-Latn-RS"],
  ["ar", "ar"], ["hi-IN", "hi-IN"], ["en-u-ca-iso8601", "en-u-ca-iso8601"],
])("accepts and canonicalizes locale %s", (input, canonical) => {
  expect(normalizeLocale(input)).toBe(canonical);
  expect(isCanonicalLocale(canonical)).toBe(true);
  expect(localeName(canonical)).toBeTruthy();
});

test.each(["", "en_US", "not a locale", "--fr", "it,fr"])("rejects malformed locale %s", (input) => {
  expect(() => normalizeLocale(input, "--slides-language")).toThrow("BCP 47");
  expect(isCanonicalLocale(input)).toBe(false);
});

test("recognizes regional built-in languages, right-to-left scripts and localization requirements", () => {
  expect(builtinLanguage("it-CH")).toBe("it");
  expect(builtinLanguage("en-GB")).toBe("en");
  expect(builtinLanguage("fr-CA")).toBeUndefined();
  expect(isRtlLocale("ar")).toBe(true);
  expect(isRtlLocale("az-Arab")).toBe(true);
  expect(isRtlLocale("zh-Hant")).toBe(false);
  expect(localizationPrompt("en", ["it"])).toEqual([]);
  expect(localizationPrompt("fr-CA", ["ja", "ar"]).join(" ")).toContain("localization");
  expect(localizationIssues(undefined, "fr-CA", ["ja"])).toContain("localization.speakerNotes.ja is required");
  expect(() => parseLocalization({ slides: { locale: "fr", text: {} } })).toThrow("translated strings");
});

test("optional localization instructions match their shape and parser limits", () => {
  const translatedSlides = localizationPrompt("fr", ["en"]).join("\n");
  expect(translatedSlides).toContain(`localization.articleTitle must be at most ${localizedArticleTitleMaximumCharacters} characters`);
  expect(translatedSlides).toContain(`at most ${localizationTextMaximumCharacters} characters`);
  expect(translatedSlides).not.toContain("Translate each localization.speakerNotes");
  const translatedNotes = localizationPrompt("en", ["ja"]).join("\n");
  expect(translatedNotes).toContain("every section introduction must retain {count}");
  expect(translatedNotes).not.toContain("Translate localization.articleTitle");
  expect(translatedNotes).not.toContain('"slides":');
});

test.each([
  ["fr", "Les développeurs regroupent leurs sessions et vérifient les modifications avant validation."],
  ["ja", "開発者は関連するセッションをまとめて変更内容を確認できます。"],
  ["ar", "يمكن للمطورين تنظيم الجلسات ومراجعة التغييرات قبل اعتمادها."],
])("does not impose English/Italian grammar or punctuation rules on %s", (locale, summary) => {
  const content: GeneratedContent = {
    section: "Models", summary, notes: ["Premier point concret", "Second point distinct"],
    details: {
      modelName: "Modèle Exemple", availability: "Disponible en préversion",
      keyCapabilities: "Améliore les suggestions pour les développeurs",
      useGuidance: "Utiliser pour les tâches prises en charge; éviter les usages non disponibles",
    },
    speakerNotes: { [locale]: "Presenter text" },
  };
  expect(slideContentIssues(content, "Source article", "Models", [locale], locale)).toEqual([]);
});

test("accepts British English spelling in regional English content", () => {
  const content: GeneratedContent = {
    section: "IDE", summary: "Developers can review agent sessions before accepting proposed changes.",
    notes: ["Review proposed edits", "Confirm preview access"],
    details: {
      feature: "Task-focused editor work", availability: "Preview in supported editors",
      keyCapabilities: "Organise related chats while preserving their context",
      howToUse: "Open the preview and select an existing task",
    },
    speakerNotes: { "en-GB": "Describe the supported workflows." },
  };
  expect(slideContentIssues(content, "Source article", "IDE", ["en-GB"], "en-GB")).toEqual([]);
});
