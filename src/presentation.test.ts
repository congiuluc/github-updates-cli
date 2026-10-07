import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { afterEach, expect, test, vi } from "vitest";
import { writePresentation } from "./presentation.js";
import type { EnrichedPost } from "./types.js";
import { sectionDetailKeys } from "./types.js";
import { sections } from "./types.js";
import { parseLocalization } from "./locales.js";

let outputDirectory: string | undefined;

test.each([
  ["ja", "開発者向けの新しい機能を紹介して関連する作業の変更内容と必要な設定を詳しく説明します"],
  ["ar", "تحديثات المطورين ومراجعة الجلسات"],
] as const)("renders localized headings and appropriate text direction for %s", async (locale, translatedTitle) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-locale-deck-"));
  const label = locale === "ja" ? "新機能" : "التحديثات";
  const localization = parseLocalization({
    articleTitle: translatedTitle,
    evidenceHeading: label,
    slides: { locale, text: {
      changelog: label, title: label, update: label, updates: label, section: label,
      sectionNames: Object.fromEntries(sections.map((section) => [section, label])),
      detailLabels: Object.fromEntries([...new Set(Object.values(sectionDetailKeys).flat())].map((key) => [key, label])),
    } },
    speakerNotes: { [locale]: {
      introduction: `${label}: {count}, {from}, {to}`,
      sections: Object.fromEntries(sections.map((section) => [section, `${label}: {count}`])),
    } },
  });
  const post: EnrichedPost = {
    title: "Original source title", url: "https://example.com/source", publishedAt: "2026-08-15T00:00:00Z",
    plainText: "Source text.", html: "", imageUrls: [], links: [],
    section: "IDE", summary: `${label}。`, notes: [label, label],
    details: { feature: label, availability: label, keyCapabilities: label, howToUse: label },
    speakerNotes: { [locale]: label }, localization,
  };
  const path = await writePresentation([post], outputDirectory, new Date("2026-08-01"), new Date("2026-08-31"),
    { slidesLanguage: locale, speakerNotesLanguages: [locale] });
  const zip = await JSZip.loadAsync(await readFile(path));
  const hero = await zip.file("ppt/slides/slide3.xml")!.async("string");
  expect(hero).not.toContain("Original source title");
  expect(hero).toContain(label);
  const texts = [...hero.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
  if (locale === "ja") {
    expect(texts.filter((text) => translatedTitle.includes(text)).length).toBeGreaterThan(1);
    expect(texts.join("")).toContain(translatedTitle);
  } else {
    expect(hero).toContain('rtl="1"');
  }
  const coverNotes = await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string");
  expect(coverNotes).toContain(label);
  expect(coverNotes).not.toContain("{count}");
});

test("retains claim quotations in article speaker notes", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-evidence-notes-"));
  const post: EnrichedPost = {
    title: "Source-backed update", url: "https://example.com/source", publishedAt: "2026-08-15T00:00:00Z",
    plainText: "The preview requires administrator approval.", html: "", imageUrls: [], links: [],
    section: "IDE", summary: "Administrators approve access to the preview.", notes: ["Confirm eligibility"],
    details: { feature: "Preview access", availability: "Preview", keyCapabilities: "Improve access controls", howToUse: "Request approval" },
    speakerNotes: { en: "Explain approval requirements." },
    evidence: [{ field: "summary", quote: "The preview requires administrator approval.", url: "https://example.com/source" }],
  };
  const path = await writePresentation([post], outputDirectory, new Date("2026-08-01"), new Date("2026-08-31"),
    { slidesLanguage: "en", speakerNotesLanguages: ["en"] });
  const zip = await JSZip.loadAsync(await readFile(path));
  for (const slide of [3, 4]) {
    const notes = await zip.file(`ppt/notesSlides/notesSlide${slide}.xml`)!.async("string");
    expect(notes).toContain("The preview requires administrator approval.");
    expect(notes).toContain("https://example.com/source");
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

test.each([
  ["Announcements", "en"], ["Announcements", "it"],
  ["Enterprise Admins", "en"], ["Enterprise Admins", "it"],
  ["Models", "en"], ["Models", "it"],
  ["IDE", "en"], ["IDE", "it"],
  ["Retirements", "en"], ["Retirements", "it"],
] as const)("renders %s cards with complete, contained maximum-length %s text", async (section, language) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-announcement-layout-"));
  const announcements = section === "Announcements" || section === "Enterprise Admins";
  const word = announcements ? (language === "it" ? "dettaglio " : "detail ")
    : language === "it" ? "integrazione " : "configuration ";
  const main = word.repeat(50).slice(0, announcements ? 300 : 250);
  const values = announcements ? [main, main.slice(0, 170), main, main.slice(0, 170)]
    : [main.slice(0, 130), main.slice(0, 170), main, main];
  const post: EnrichedPost = {
    title: "Organization policy controls",
    url: "https://github.blog/changelog/example",
    publishedAt: "2026-08-15T10:00:00.000Z",
    plainText: "", html: "", imageUrls: [], links: [],
    section, summary: "Copilot gives teams clearer policy controls.",
    notes: [], speakerNotes: {},
    details: Object.fromEntries(sectionDetailKeys[section].map((key, index) => [key, values[index]])),
  };
  const path = await writePresentation([post], outputDirectory, new Date("2026-08-01"),
    new Date("2026-08-31"), { slidesLanguage: language, speakerNotesLanguages: [] });
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file("ppt/slides/slide4.xml")!.async("string");
  const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
  const coordinate = (shape: string, tag: string, attribute: string) =>
    Number(shape.match(new RegExp(`<a:${tag}[^>]*\\b${attribute}="(\\d+)"`))?.[1]) / 914400;
  const x = (shape: string) => coordinate(shape, "off", "x");
  const y = (shape: string) => coordinate(shape, "off", "y");
  const w = (shape: string) => coordinate(shape, "ext", "cx");
  const h = (shape: string) => coordinate(shape, "ext", "cy");
  const cards = shapes.filter(shape => shape.includes('prst="roundRect"'));
  expect(cards).toHaveLength(4);
  expect(w(cards[0])).toBeCloseTo(w(cards[1]) * (announcements ? 2 : 1), 5);
  expect(w(cards[2])).toBeCloseTo(w(cards[3]) * (announcements ? 2 : 1), 5);
  expect(x(cards[1]) - x(cards[0]) - w(cards[0])).toBeCloseTo(0.37, 5);
  expect(x(cards[1]) + w(cards[1])).toBeCloseTo(12.63, 5);
  cards.forEach((card, index) => {
    const lines = shapes.filter(shape => shape.includes("<a:t>") &&
      Math.abs(x(shape) - x(card) - 0.25) < 0.001 &&
      y(shape) >= y(card) + 0.47 && y(shape) < y(card) + h(card));
    const text = lines.flatMap(shape => [...shape.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(match => match[1])).join(" ");
    expect(text).toBe(values[index].trim());
    if (!announcements && index >= 2) expect(lines).toHaveLength(5);
    lines.forEach(line => {
      expect(x(line) + w(line)).toBeLessThanOrEqual(x(card) + w(card) - 0.24);
      expect(y(line) + h(line)).toBeLessThanOrEqual(y(card) + h(card) - 0.2);
      const size = Number(line.match(/<a:rPr[^>]*\bsz="(\d+)"/)?.[1]) / 100;
      expect(size).toBeGreaterThanOrEqual(announcements ? (index % 2 === 0 ? 12 : 9.9) : index < 2 ? 12 : 11.7);
    });
  });
});

test.each(["Models", "IDE", "Retirements"] as const)("embeds the GitHub theme and preserves equal cards for %s", async (section) => {
  const write = vi.spyOn(PptxGenJS.prototype, "write");
  const writeFile = vi.spyOn(PptxGenJS.prototype, "writeFile");
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-presentation-"));
  const post: EnrichedPost = {
    title:
      "A deliberately long GitHub Copilot changelog title that wraps cleanly across two lines",
    url: "https://github.blog/changelog/2026-08-15-example",
    publishedAt: "2026-08-15T10:00:00.000Z",
    plainText: "Example changelog content.",
    html: "<p>Example changelog content.</p>",
    imageUrls: [],
    links: [],
    section,
    summary: "A concise summary that remains separated from a two-line title.",
    notes: [],
    details: {
      modelName: "Example model",
      availability: "Generally available",
      keyCapabilities: "Fast and accurate",
      useGuidance: "Use for coding assistance",
      feature: "Editor workflows",
      howToUse: "Open the editor",
      subject: "Previous release",
      retirementDate: "Next month",
      reasons: "Updated release",
      replacement: "Use the supported release",
    },
    speakerNotes: { en: "Example speaker notes." },
  };

  const path = await writePresentation(
    [post],
    outputDirectory,
    new Date("2026-08-01T00:00:00.000Z"),
    new Date("2026-08-31T00:00:00.000Z"),
    { slidesLanguage: "en", speakerNotesLanguages: ["en"] },
  );
  expect(path).toBe(
    join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx"),
  );
  expect(write).toHaveBeenCalledExactlyOnceWith({ outputType: "nodebuffer" });
  expect(writeFile).not.toHaveBeenCalled();

  const zip = await JSZip.loadAsync(await readFile(path));
  const theme = await zip.file("ppt/theme/theme1.xml")?.async("string");
  expect(theme).toContain('name="GitHub"');
  expect(theme).toContain('<a:accent1><a:srgbClr val="0FBF3E"/></a:accent1>');
  expect(theme).toContain('<a:accent2><a:srgbClr val="8534F3"/></a:accent2>');

  const newsSlides = await Promise.all(
    ["ppt/slides/slide3.xml", "ppt/slides/slide4.xml"].map(async (name) =>
      zip.file(name)?.async("string"),
    ),
  );
  for (const slide of newsSlides) {
    expect(slide).toContain("Aug 15, 2026");
    expect(slide).toContain("github.blog/changelog");
  }
  expect(newsSlides[0]).not.toContain("IMAGE UNAVAILABLE");
  const cards = newsSlides[1]!.match(/<p:sp>[\s\S]*?<\/p:sp>/g)!
    .filter(shape => shape.includes('prst="roundRect"'));
  expect(cards).toHaveLength(4);
  cards.forEach(card => expect(card).toContain('cx="5285232"'));
  expect(await zip.file("ppt/notesSlides/notesSlide3.xml")?.async("string"))
    .toContain("Example speaker notes.");

  const allSlides = await Promise.all(
    ["slide1.xml", "slide2.xml", "slide3.xml", "slide4.xml"].map(async (name) =>
      zip.file(`ppt/slides/${name}`)?.async("string"),
    ),
  );
  for (const slide of allSlides) {
    expect(slide).toContain("GitHub Copilot logo");
  }
});

test("does not write a presentation when in-memory export fails", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-presentation-export-error-"));
  vi.spyOn(PptxGenJS.prototype, "write").mockRejectedValue(new Error("Export failed"));
  await expect(writePresentation([], outputDirectory, new Date("2026-08-01"),
    new Date("2026-08-31"), { slidesLanguage: "en", speakerNotesLanguages: ["en"] },
  )).rejects.toThrow("Export failed");
  expect(await readdir(outputDirectory)).toEqual([]);
});
