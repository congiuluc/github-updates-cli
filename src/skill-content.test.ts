import { expect, test } from "vitest";
import { buildSkillPrompt, parseSkillRecord, skillRecordIssues } from "./skill-content.js";
import type { ChangelogPost } from "./types.js";

const post: ChangelogPost = {
  title: "Copilot improves agent sessions",
  url: "https://github.blog/changelog/2026-08-15-agent-sessions",
  publishedAt: "2026-08-15T10:00:00.000Z",
  changelogType: "Improvement",
  plainText: "Copilot groups related agent sessions in VS Code.",
  html: "<p>Copilot groups related agent sessions in VS Code.</p>",
  imageUrls: [],
  links: [],
};

const generated = {
  section: "ide",
  category: "ide",
  status: "NON INDICATO",
  hero_value: "IDE",
  hero_label: "Sessioni agente raggruppate",
  summary: "Copilot raggruppa le sessioni correlate in VS Code.",
  points: ["Raggruppa le sessioni correlate", "Conserva il contesto del lavoro", "Rende le sessioni più facili da trovare"],
  availability: "VS Code; altri dettagli non indicati.",
  how_to: "La procedura non è indicata.",
  facts: ["VS Code", "Sessioni agente", "Copilot"],
};

test("binds immutable article metadata to the source rather than the model response", () => {
  const record = parseSkillRecord(JSON.stringify({
    ...generated, id: 99, title: "Invented", date: "2026-01-01",
    url: "https://example.com", type: "Release",
  }), post, 1);
  expect(record).toMatchObject({
    ...generated, id: 1, title: post.title, date: "2026-08-15",
    url: post.url, type: "Improvement",
  });
  expect(skillRecordIssues(record)).toEqual([]);
  expect(buildSkillPrompt(post)).toContain("Source type: Improvement");
});

test("rejects malformed or overlong skill records rather than silently truncating them", () => {
  for (const invalid of [
    { ...generated, section: "release" },
    { ...generated, status: "GA?", hero_value: "1234567890" },
    { ...generated, points: ["Uno", "Due"] },
    { ...generated, facts: ["Uno", "Due", "x".repeat(27)] },
    { ...generated, summary: "Fonte: https://example.com" },
    { ...generated, section: "retired", migrations: [["Vecchio", "2026-02-31", "Nuovo"]] },
  ]) {
    expect(() => parseSkillRecord(JSON.stringify(invalid), post, 1)).toThrow();
  }
  expect(() => parseSkillRecord("not JSON", post, 1)).toThrow(/valid JSON/);
  expect(() => parseSkillRecord(JSON.stringify(generated), { ...post, changelogType: undefined }, 1))
    .toThrow(/type is missing/);
});
