import type { ClaimEvidence } from "./generation.js";
import type { DeckLocalization } from "./locales.js";

export const sections = [
  "Models",
  "Enterprise Admins",
  "Announcements",
  "IDE",
  "Retirements",
] as const;

export type Section = (typeof sections)[number];
export const DEFAULT_ENRICHMENT_CONCURRENCY = 3;
/** A canonical BCP 47 tag. Validate untrusted values with normalizeLocale before use. */
export type SupportedLanguage = string;
export type SlideDetailKey =
  | "modelName"
  | "availability"
  | "keyCapabilities"
  | "useGuidance"
  | "subject"
  | "retirementDate"
  | "reasons"
  | "replacement"
  | "feature"
  | "howToUse"
  | "announcement"
  | "impact"
  | "audience";

export const sectionDetailKeys: Record<Section, readonly SlideDetailKey[]> = {
  Models: ["modelName", "availability", "keyCapabilities", "useGuidance"],
  "Enterprise Admins": ["announcement", "availability", "impact", "audience"],
  Announcements: ["announcement", "availability", "impact", "audience"],
  IDE: ["feature", "availability", "keyCapabilities", "howToUse"],
  Retirements: ["subject", "retirementDate", "reasons", "replacement"],
};

export const explanatoryDetailKeys: ReadonlySet<SlideDetailKey> = new Set([
  "keyCapabilities", "useGuidance", "howToUse", "reasons", "replacement",
]);

export interface SourceLink {
  label: string;
  url: string;
}

export interface ChangelogPost {
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  plainText: string;
  html: string;
  imageUrls: string[];
  links: SourceLink[];
}

/** Content accepted by the slide validator, independent of its source and images. */
export interface GeneratedContent {
  section: Section;
  summary: string;
  notes: string[];
  details: Partial<Record<SlideDetailKey, string>>;
  speakerNotes: Partial<Record<SupportedLanguage, string>>;
  evidence?: ClaimEvidence[];
  localization?: DeckLocalization;
}

export interface EnrichedPost extends ChangelogPost, GeneratedContent {
  imageDataUri?: string;
}

export interface DateRange {
  from: Date;
  to: Date;
}
