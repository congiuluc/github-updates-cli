import { expect, test } from "vitest";
import { evidenceFields, evidenceIssues, mergeRegeneratedContent, parseEvidence, regenerationFields } from "./generation.js";
import type { EnrichedPost } from "./types.js";

const post: EnrichedPost = {
  title: "Example release", url: "https://example.com/release", publishedAt: "2026-08-15T00:00:00Z",
  plainText: "The preview groups related sessions. Administrators must enable access.", html: "",
  imageUrls: [], links: [], section: "IDE", summary: "Sessions are grouped.",
  notes: ["Group sessions", "Enable access"],
  details: { feature: "Grouped sessions", availability: "Preview", keyCapabilities: "Organize sessions", howToUse: "Enable access" },
  speakerNotes: { en: "Discuss the preview.", it: "Presentare l'anteprima." },
};

test("requires literal source evidence for each generated field without claiming semantic verification", () => {
  const evidence = evidenceFields(post, ["en", "it"]).map((field) => ({
    field, quote: "The preview groups related sessions.", url: post.url,
  }));
  expect(evidenceIssues({ ...post, evidence }, post, ["en", "it"], true)).toEqual([]);
  expect(evidenceIssues({ ...post, evidence: [{ field: "summary", quote: "Invented performance.", url: post.url }] }, post, ["en"], true))
    .toContain("evidence for summary must quote the source verbatim");
  expect(evidenceIssues({ ...post, evidence: [{ field: "summary", quote: "The preview groups related sessions.", url: "https://wrong.example" }] }, post, ["en"]))
    .toContain("evidence for summary must link to the supplied article URL");
  expect(() => parseEvidence([{ field: "summary", quote: "", url: post.url }])).toThrow("evidence");
});

test("regenerates selected fields and languages without altering unrelated content or evidence", () => {
  const base = { ...post, evidence: [
    { field: "summary", quote: "The preview groups related sessions.", url: post.url },
    { field: "details.feature", quote: "The preview groups related sessions.", url: post.url },
  ] };
  const changed = {
    ...post, summary: "New summary.", notes: ["Unwanted replacement"], details: { feature: "Unwanted feature" },
    speakerNotes: { en: "Unwanted English", it: "Nuove note." },
    evidence: [{ field: "summary", quote: "Administrators must enable access.", url: post.url }],
  };
  const fields = regenerationFields(base, ["summary"], ["it"]);
  const merged = mergeRegeneratedContent(base, changed, fields);
  expect(merged.summary).toBe("New summary.");
  expect(merged.notes).toEqual(base.notes);
  expect(merged.details).toEqual(base.details);
  expect(merged.speakerNotes).toEqual({ en: base.speakerNotes.en, it: "Nuove note." });
  expect(merged.evidence).toContainEqual(base.evidence[1]);
  expect(() => regenerationFields(base, ["details.retirementDate"], [])).toThrow("Cannot regenerate");
  expect(() => regenerationFields(base, ["speakerNotes.fr"], [])).toThrow("Cannot regenerate");
});
