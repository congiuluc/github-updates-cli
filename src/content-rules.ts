import { explanatoryDetailKeys, type Section, type SlideDetailKey } from "./types.js";

export interface TextLimits {
  maximumWords: number;
  maximumCharacters: number;
}

/** Hard acceptance limits shared by the initial prompt and response validator. */
export const slideContentLimits = {
  summary: { maximumWords: 32, maximumCharacters: 220 },
  note: { maximumWords: 16, maximumCharacters: 110 },
  minimumNotes: 2,
  maximumNotes: 4,
  maximumDetailPoints: 3,
  minimumAnnouncementWords: 6,
  minimumImpactWords: 8,
} as const;

export const titleDetailKeys: ReadonlySet<SlideDetailKey> = new Set([
  "modelName", "subject", "feature", "announcement",
]);

export function detailContentLimits(section: Section, key: SlideDetailKey): TextLimits {
  if ((section === "Announcements" || section === "Enterprise Admins") &&
    (key === "announcement" || key === "impact")) {
    return { maximumWords: 44, maximumCharacters: 300 };
  }
  if (explanatoryDetailKeys.has(key)) return { maximumWords: 36, maximumCharacters: 250 };
  if (titleDetailKeys.has(key)) return { maximumWords: 18, maximumCharacters: 130 };
  return { maximumWords: 26, maximumCharacters: 170 };
}
