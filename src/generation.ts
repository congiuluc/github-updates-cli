import { sectionDetailKeys, type EnrichedPost, type GeneratedContent, type SupportedLanguage } from "./types.js";
import { isRecord } from "./storage.js";

export const audiences = ["standard", "executive", "developer", "administrator"] as const;
export type Audience = (typeof audiences)[number];
export const audienceInstructions: Record<Audience, string> = {
  standard: "",
  executive: "Write for executives: prioritize business relevance, decision points, adoption risks and source-backed impact. Explain technical terms. Never invent ROI, savings or performance claims.",
  developer: "Write for developers: prioritize concrete capabilities, supported workflows, implementation prerequisites, limitations and the first practical action. Retain source-backed technical detail.",
  administrator: "Write for administrators: prioritize rollout, eligibility, permissions, policy controls, governance, migration deadlines and operational actions. Do not infer administrative controls absent from the source.",
};

export interface ClaimEvidence {
  field: string;
  quote: string;
  url: string;
}

export interface RegenerationTarget {
  baseline: EnrichedPost;
  /** Empty means a full rewrite; otherwise only these paths may change. */
  fields: string[];
}

export function isAudience(value: unknown): value is Audience {
  return audiences.some((audience) => audience === value);
}

export function parseEvidence(value: unknown): ClaimEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) &&
    typeof entry.field === "string" && typeof entry.quote === "string" && entry.quote.trim() &&
    typeof entry.url === "string")) {
    throw new Error("evidence must be an array of field, quote, and url strings.");
  }
  return value.map((entry) => ({ field: entry.field, quote: entry.quote.trim(), url: entry.url }));
}

export function evidenceFields(content: GeneratedContent, languages: SupportedLanguage[]): string[] {
  return [
    "summary", ...content.notes.map((_, index) => `notes.${index}`),
    ...sectionDetailKeys[content.section].map((key) => `details.${key}`),
    ...languages.map((language) => `speakerNotes.${language}`),
  ];
}

/** Verify quotation provenance and coverage, not whether a claim follows from the quote. */
export function evidenceIssues(
  content: GeneratedContent, source: { plainText: string; url: string }, languages: SupportedLanguage[], required = false,
): string[] {
  const evidence = content.evidence ?? [];
  const fields = new Set(evidenceFields(content, languages));
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const text = normalize(source.plainText);
  const issues: string[] = [];
  for (const entry of evidence) {
    if (!fields.has(entry.field)) issues.push(`evidence field ${entry.field} does not exist`);
    if (entry.url !== source.url) issues.push(`evidence for ${entry.field} must link to the supplied article URL`);
    if (!normalize(entry.quote) || !text.includes(normalize(entry.quote))) {
      issues.push(`evidence for ${entry.field} must quote the source verbatim`);
    }
  }
  if (required) for (const field of fields) {
    if (!evidence.some((entry) => entry.field === field)) issues.push(`evidence is required for ${field}`);
  }
  return issues;
}

export function regenerationFields(post: EnrichedPost, fields: string[], languages: SupportedLanguage[]): string[] {
  const selected = [...new Set([...fields, ...languages.map((language) => `speakerNotes.${language}`)])];
  const valid = new Set(["summary", "notes", ...sectionDetailKeys[post.section].map((key) => `details.${key}`),
    ...Object.keys(post.speakerNotes).map((language) => `speakerNotes.${language}`)]);
  for (const field of selected) {
    if (!valid.has(field)) throw new Error(`Cannot regenerate "${field}" for "${post.title}". Available fields: ${[...valid].join(", ")}.`);
  }
  return selected;
}

/** Preserve unselected accepted fields even when the model returns unrelated edits. */
export function mergeRegeneratedContent(base: EnrichedPost, replacement: GeneratedContent, fields: string[]): GeneratedContent {
  if (!fields.length) return replacement;
  const selected = new Set(fields);
  const changes = (field: string) => selected.has(field) || (field.startsWith("notes.") && selected.has("notes"));
  return {
    section: base.section,
    summary: selected.has("summary") ? replacement.summary : base.summary,
    notes: selected.has("notes") ? replacement.notes : base.notes,
    details: Object.fromEntries(sectionDetailKeys[base.section].map((key) => [
      key, selected.has(`details.${key}`) ? replacement.details[key] : base.details[key],
    ])),
    speakerNotes: Object.fromEntries(Object.entries(base.speakerNotes).map(([language, value]) => [
      language, selected.has(`speakerNotes.${language}`) ? replacement.speakerNotes[language] : value,
    ])),
    ...((base.evidence || replacement.evidence) ? { evidence: [
      ...(base.evidence ?? []).filter((entry) => !changes(entry.field)),
      ...(replacement.evidence ?? []).filter((entry) => changes(entry.field)),
    ] } : {}),
    ...(base.localization ? { localization: base.localization } : {}),
  };
}

export function formatEvidence(post: EnrichedPost): string {
  if (!post.evidence?.length) return "";
  return `\n\n${post.localization?.evidenceHeading ?? "Source evidence (quotes for human review, not an automated factual audit)"}:\n` +
    post.evidence.map((entry) => `${entry.field}: "${entry.quote}"\n${entry.url}`).join("\n\n");
}
