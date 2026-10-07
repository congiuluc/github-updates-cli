import { expect, test } from "vitest";
import { buildEnrichmentPrompt } from "./enrichment-prompt.js";
import { sections, sectionDetailKeys, type ChangelogPost, type EnrichedPost } from "./types.js";
import { detailContentLimits, slideContentLimits } from "./content-rules.js";

const source: ChangelogPost = {
  title: "Preview adds grouped sessions",
  url: "https://example.com/update",
  publishedAt: "2026-08-15T12:00:00Z",
  plainText: "Grouped sessions retain context. Administrators must enable access.",
  html: "", imageUrls: [], links: [],
};

test.each(sections)("builds the same required JSON shape and source task for %s", (section) => {
  const prompt = buildEnrichmentPrompt(source, {
    slidesLanguage: "en", speakerNotesLanguages: ["en", "it"],
  }, section);
  const shapeLine = prompt.split("\n\n").find((line) => line.startsWith("Return strict JSON"));
  const shape = JSON.parse(shapeLine!.slice(shapeLine!.indexOf("Example shape: ") + "Example shape: ".length));
  expect(shape.section).toBe(section);
  expect(Object.keys(shape.details)).toEqual(sectionDetailKeys[section]);
  expect(Object.keys(shape.speakerNotes)).toEqual(["en", "it"]);
  expect(shape.notes.length).toBeGreaterThanOrEqual(slideContentLimits.minimumNotes);
  expect(shape.notes.length).toBeLessThanOrEqual(slideContentLimits.maximumNotes);
  expect(prompt).toContain(`Required section: ${section}. Do not choose a different section.`);
  expect(prompt).toContain(`Title: ${source.title}`);
  expect(prompt).toContain(`Published: ${source.publishedAt}`);
  expect(prompt).toContain(`Article: ${source.plainText}`);
  expect(prompt).toContain("Do not assume the article concerns GitHub or Copilot");
});

test.each(sections)("exposes every hard validator limit and only the assigned %s guidance", (section) => {
  const prompt = buildEnrichmentPrompt(source, { slidesLanguage: "en", speakerNotesLanguages: ["en"] }, section);
  expect(prompt).toContain(`summary: at most ${slideContentLimits.summary.maximumWords} words and ${slideContentLimits.summary.maximumCharacters} characters.`);
  expect(prompt).toContain(`notes: ${slideContentLimits.minimumNotes}-${slideContentLimits.maximumNotes} separate strings; each at most ${slideContentLimits.note.maximumWords} words and ${slideContentLimits.note.maximumCharacters} characters.`);
  for (const key of sectionDetailKeys[section]) {
    const limits = detailContentLimits(section, key);
    expect(prompt).toContain(`details.${key}: at most ${limits.maximumWords} words and ${limits.maximumCharacters} characters`);
  }
  for (const other of sections.filter((value) => value !== section)) {
    expect(prompt).not.toContain(`\n\n${other}:`);
  }
  expect(prompt).toContain("FINAL COMPLIANCE CHECK BEFORE SENDING");
  expect(prompt).toContain("EVERY word AND character cap");
  expect(prompt).toContain("not essential qualifiers");
  expect(prompt).toContain("not a hard length limit");
  expect(prompt.length).toBeLessThan(section === "IDE" ? 7600 : 6200);
  if (section !== "IDE") {
    expect(prompt).not.toContain("Illustrative output:");
    expect(prompt).not.toContain("howToUse");
  }
  if (section === "Announcements" || section === "Enterprise Admins") {
    expect(prompt).toContain(`at least ${slideContentLimits.minimumAnnouncementWords} meaningful words`);
    expect(prompt).toContain(`at least ${slideContentLimits.minimumImpactWords} meaningful words`);
    expect(prompt).not.toContain("keyCapabilities");
    expect(prompt).not.toContain("useGuidance");
  }
});

test.each(["fr-CA", "ja", "ar"])("does not require English action wording or English minimum word counts for %s", (locale) => {
  const prompt = buildEnrichmentPrompt(source, { slidesLanguage: locale, speakerNotesLanguages: [locale] }, "Models");
  expect(prompt).toContain("naturally translated into the requested locale, not an English word");
  expect(prompt).toContain('equivalent of "Use for ...; avoid for ..." in the requested locale');
  expect(prompt).not.toContain('must explicitly use "Use for');
  const announcement = buildEnrichmentPrompt(source, { slidesLanguage: locale, speakerNotesLanguages: [locale] }, "Announcements");
  expect(announcement).not.toContain("at least 6 meaningful words");
  expect(announcement).not.toContain("at least 8 meaningful words");
  expect(announcement).toContain("locale-appropriate sentence punctuation");
});

test("keeps locale, evidence, audience and field-revision instructions together", () => {
  const baseline: EnrichedPost = {
    ...source, section: "IDE", summary: "A complete summary.", notes: ["A concrete point"],
    details: { feature: "Grouped sessions" }, speakerNotes: { "fr-CA": "Texte." },
  };
  const prompt = buildEnrichmentPrompt(source, {
    slidesLanguage: "fr-CA", speakerNotesLanguages: ["fr-CA"], audience: "administrator", evidence: true,
  }, "IDE", { baseline, fields: ["summary"] });
  expect(prompt).toContain("Write for administrators:");
  expect(prompt).toContain("Write summary, notes, and detail values in Canadian French.");
  expect(prompt).toContain("Use the exact slide locale fr-CA");
  expect(prompt).toContain("Also return localization using this exact key structure:");
  expect(prompt).toContain("Also return an evidence array.");
  expect(prompt).toContain(`Use exactly this source URL: ${source.url}.`);
  expect(prompt).toContain("Change only these fields: summary.");
  expect(prompt).toContain(`Accepted content to revise: ${JSON.stringify(baseline)}`);
});

test("keeps the established 12000-character source budget", () => {
  const prompt = buildEnrichmentPrompt({ ...source, plainText: "x".repeat(12_000) + "NOT_IN_PROMPT" }, {
    slidesLanguage: "en", speakerNotesLanguages: ["en"],
  }, "IDE");
  expect(prompt).toContain(`Article: ${"x".repeat(12_000)}`);
  expect(prompt).not.toContain("NOT_IN_PROMPT");
});
