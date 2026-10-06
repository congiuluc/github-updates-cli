export const sections = [
  "Models",
  "Enterprise Admins",
  "Announcements",
  "IDE",
  "Retirements",
] as const;

export type Section = (typeof sections)[number];
export type SupportedLanguage = "en" | "it";
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

export interface EnrichedPost extends ChangelogPost {
  section: Section;
  summary: string;
  notes: string[];
  details: Partial<Record<SlideDetailKey, string>>;
  speakerNotes: Partial<Record<SupportedLanguage, string>>;
  imageDataUri?: string;
}

export interface DateRange {
  from: Date;
  to: Date;
}
