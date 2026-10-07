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
  it("marks right-to-left article content with its locale and direction", () => {
    const html = renderWebsite([{ ...post, summary: "ملخص التحديث" }], new Date("2026-08-01"), new Date("2026-08-31"), "ar");
    expect(html).toContain('lang="ar" dir="rtl"');
    expect(html).toContain("ملخص التحديث");
  });

  it("includes escaped source quotations in an expandable review panel", () => {
    const html = renderWebsite([{ ...post, evidence: [{
      field: "summary", quote: "Use <preview> & verify eligibility.", url: post.url,
    }] }], new Date("2026-08-01"), new Date("2026-08-31"));
    expect(html).toContain('<details class="evidence"><summary>Source evidence</summary>');
    expect(html).toContain("Use &lt;preview&gt; &amp; verify eligibility.");
    expect(html).toContain("not an automated factual audit");
  });

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
