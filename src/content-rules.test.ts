import { expect, test } from "vitest";
import { detailContentLimits, slideContentLimits } from "./content-rules.js";
import { slideContentIssues } from "./enricher.js";
import { sections, sectionDetailKeys, type GeneratedContent, type Section } from "./types.js";

function content(section: Section): GeneratedContent {
  return {
    section,
    summary: "Teams can adopt the announced workflow while preserving required approval controls.",
    notes: ["Check the stated access requirements", "Review affected workflows before enabling changes"],
    details: Object.fromEntries(sectionDetailKeys[section].map((key) => [key, "Distinct source-backed details for this particular card"])),
    speakerNotes: { en: "Presenter script." },
  };
}

test("keeps summary and note character boundaries unchanged", () => {
  const sample = content("IDE");
  const summaryError = `summary must be at most ${slideContentLimits.summary.maximumWords} words and ${slideContentLimits.summary.maximumCharacters} characters`;
  sample.summary = `${"x".repeat(slideContentLimits.summary.maximumCharacters - 1)}.`;
  expect(slideContentIssues(sample)).not.toContain(summaryError);
  sample.summary = `${"x".repeat(slideContentLimits.summary.maximumCharacters)}.`;
  expect(slideContentIssues(sample)).toContain(summaryError);
  const noteError = `note 1 must be at most ${slideContentLimits.note.maximumWords} words and ${slideContentLimits.note.maximumCharacters} characters`;
  sample.notes[0] = "x".repeat(slideContentLimits.note.maximumCharacters);
  expect(slideContentIssues(sample)).not.toContain(noteError);
  sample.notes[0] += "x";
  expect(slideContentIssues(sample)).toContain(noteError);
});

test.each(sections)("shared budgets match actual acceptance boundaries for every %s detail", (section) => {
  for (const key of sectionDetailKeys[section]) {
    const sample = content(section);
    const { maximumWords, maximumCharacters } = detailContentLimits(section, key);
    const problem = `${key} must be at most ${maximumWords} words and ${maximumCharacters} characters`;
    sample.details[key] = "x".repeat(maximumCharacters);
    expect(slideContentIssues(sample)).not.toContain(problem);
    sample.details[key] += "x";
    expect(slideContentIssues(sample)).toContain(problem);
    sample.details[key] = Array(maximumWords).fill("fact").join(" ");
    expect(slideContentIssues(sample)).not.toContain(problem);
    sample.details[key] += " fact";
    expect(slideContentIssues(sample)).toContain(problem);
  }
});
