import { describe, expect, it } from "vitest";
import { renderWebsite } from "./html.js";
import type { EnrichedPost } from "./types.js";

const post: EnrichedPost = {
  title: "Copilot update",
  url: "https://github.blog/changelog/example",
  publishedAt: "2026-08-15T10:00:00.000Z",
  plainText: "Details",
  html: "<p>Details</p>",
  imageUrls: [],
  links: [{ label: "Docs", url: "https://docs.github.com/" }],
  section: "Models",
  summary: "A concise summary.",
  notes: ["One useful note."],
  details: {
    modelName: "Copilot update",
    availability: "Generally available",
    keyCapabilities: "Improved coding assistance",
    useGuidance: "Use for coding tasks",
  },
  speakerNotes: {
    en: "English notes.",
  },
};

describe("renderWebsite", () => {
  it("creates a self-contained, sectioned and searchable page", () => {
    const html = renderWebsite(
      [post],
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T23:59:59Z"),
    );
    expect(html).toContain('id="models"');
    expect(html).toContain("A concise summary.");
    expect(html).toContain('id="search"');
    expect(html).toContain("--cp-accent");
    expect(html).not.toContain('href="./');
  });

  it("renders the Enterprise Admins section for enterprise administration updates", () => {
    const html = renderWebsite(
      [{ ...post, section: "Enterprise Admins" }],
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T23:59:59Z"),
    );

    expect(html).toContain('id="enterprise-admins"');
    expect(html).toContain('href="#enterprise-admins">Enterprise Admins</a>');
  });
});
