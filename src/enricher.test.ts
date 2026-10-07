import { afterEach, expect, test, vi } from "vitest";
import {
  classifySection,
  enrichWithCopilot,
  generateSlideReadyContent,
  isNewModelAvailabilityPost,
  sectionDetailKeys,
  SlideReviewFailedError,
  slideContentIssues,
  type EnrichmentCopilotClient,
  type GeneratedContent,
} from "./enricher.js";
import type { ChangelogPost, Section } from "./types.js";

const presenterScript = [
  "This update improves how developers organize agent work inside the editor.",
  "Explain that related sessions can remain grouped, which makes context easier to find and review.",
  "Highlight the rollout status and the supported editor before demonstrating the workflow.",
  "Then show how to open the Agents view, group related sessions, and inspect generated changes before merging.",
  "The practical takeaway is faster review with less navigation overhead.",
  "Remind the audience to confirm availability for their current channel and organizational policy before adopting the feature.",
].join(" ");

function explanatoryContent(section: Section): GeneratedContent {
  return {
    section,
    summary: "Copilot gives teams clearer options for their daily development workflow.",
    notes: ["Review supported workflows", "Verify organizational prerequisites"],
    details: {
      modelName: "Example model", feature: "Grouped agent sessions", subject: "Legacy service",
      availability: "Available to eligible teams", retirementDate: "September 30",
      keyCapabilities: "Improve code review with focused suggestions",
      useGuidance: "Use for code review; avoid for unsupported workflows",
      howToUse: "Open Agents and group related sessions",
      reasons: "Legacy service support is ending",
      replacement: "Select the supported service and verify configuration",
    },
    speakerNotes: { en: presenterScript },
  };
}

test.each([
  ["Models", "keyCapabilities"], ["Models", "useGuidance"],
  ["IDE", "keyCapabilities"], ["IDE", "howToUse"],
  ["Retirements", "reasons"], ["Retirements", "replacement"],
] as const)("preserves richer %s/%s content and rewrites rather than truncating over-limit values", async (section, key) => {
  const content = explanatoryContent(section);
  const prefix = key === "useGuidance" ? "Use for code; avoid for " : "Improve ";
  const wordValue = (count: number) => prefix + Array(count - prefix.trim().split(/\s+/).length).fill("dato").join(" ");
  const charValue = (count: number) => prefix + "dato ".repeat(5) + "x".repeat(count - prefix.length - 25);
  for (const value of [wordValue(36), charValue(250)]) {
    content.details[key] = value;
    const send = vi.fn().mockResolvedValue(JSON.stringify(content));
    const result = await generateSlideReadyContent(send, "Initial prompt", ["en"], "Article title", section);
    expect(result.details[key]).toBe(value);
    expect(send).toHaveBeenCalledTimes(1);
  }
  for (const value of [wordValue(37), charValue(251)]) {
    content.details[key] = value;
    const corrected = explanatoryContent(section);
    const send = vi.fn().mockResolvedValueOnce(JSON.stringify(content)).mockResolvedValueOnce(JSON.stringify(corrected));
    expect(slideContentIssues(content)).toContain(`${key} must be at most 36 words and 250 characters`);
    const result = await generateSlideReadyContent(send, "Initial prompt", ["en"], "Article title", section);
    expect(result.details[key]).toBe(corrected.details[key]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toContain(`${key} must be at most 36 words and 250 characters`);
    expect(send.mock.calls[1][0]).toContain("eligibility conditions");
  }
});

test.each([
  ["Models", "modelName", 18, 130], ["Models", "availability", 26, 170],
  ["IDE", "feature", 18, 130], ["IDE", "availability", 26, 170],
  ["Retirements", "subject", 18, 130], ["Retirements", "retirementDate", 26, 170],
] as const)("retains compact limits for %s/%s", (section, key, words, characters) => {
  const content = explanatoryContent(section);
  const issue = `${key} must be at most ${words} words and ${characters} characters`;
  for (const value of [Array(words).fill("dato").join(" "), "x".repeat(characters)]) {
    content.details[key] = value;
    expect(slideContentIssues(content)).not.toContain(issue);
  }
  for (const value of [Array(words + 1).fill("dato").join(" "), "x".repeat(characters + 1)]) {
    content.details[key] = value;
    expect(slideContentIssues(content)).toContain(issue);
  }
});

test.each(["announcement", "impact"] as const)(
  "allows richer %s content without truncation and enforces both expanded limits",
  async (key) => {
    const content: GeneratedContent = {
      section: "Announcements",
      summary: "Copilot gives administrators clearer control over enterprise configuration.",
      notes: ["Review organizational policies", "Coordinate rollout with team owners"],
      details: {
        announcement: "Organization owners can configure access for individual development teams",
        availability: "Rolling out to Business and Enterprise",
        impact: "Reduces configuration drift and helps administrators coordinate access across teams",
        audience: "Organization owners and administrators",
      },
      speakerNotes: { en: presenterScript },
    };
    for (const value of [Array(44).fill("dato").join(" "), "dato ".repeat(8) + "x".repeat(260)]) {
      content.details[key] = value;
      const send = vi.fn().mockResolvedValue(JSON.stringify(content));
      const result = await generateSlideReadyContent(send, "Initial prompt", ["en"], "Policy controls", "Announcements");
      expect(result.details[key]).toBe(value);
      expect(send).toHaveBeenCalledTimes(1);
    }
    for (const value of [Array(45).fill("dato").join(" "), "dato ".repeat(8) + "x".repeat(261)]) {
      content.details[key] = value;
      expect(slideContentIssues(content)).toContain(`${key} must be at most 44 words and 300 characters`);
    }
    for (const secondary of ["availability", "audience"] as const) {
      content.details[secondary] = "x".repeat(171);
      expect(slideContentIssues(content)).toContain(`${secondary} must be at most 26 words and 170 characters`);
    }
  },
);

function changelogPost(title: string, plainText: string): ChangelogPost {
  return {
    title,
    url: "https://github.blog/changelog/example",
    publishedAt: "2026-08-31T10:00:00.000Z",
    plainText,
    html: `<p>${plainText}</p>`,
    imageUrls: [],
    links: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("reports AI content that is not slide-ready", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary:
      "This very long summary repeats the article and includes far too many implementation details, version numbers, configuration options, navigation instructions, caveats, examples, rollout phases, administrative prerequisites, unsupported assumptions, secondary background information, and several unrelated observations that do not belong on a presentation slide.",
    notes: ["Short note", "Another short note"],
    details: {
      feature: "Agent sessions",
      availability: "Available in supported versions",
      keyCapabilities:
        "Grouped sessions, navigation, review, terminals, browsers, prompts, plugins, models, settings, transcripts, and many more capabilities...",
      howToUse: "Open Agents and group related sessions",
    },
    speakerNotes: { en: presenterScript },
  };

  expect(slideContentIssues(content)).toEqual(
    expect.arrayContaining([
      "summary must be at most 32 words and 220 characters",
      "keyCapabilities must be a complete standalone phrase without filler or ellipses",
    ]),
  );
});

test("accepts presentation-ready AI content without revision", async () => {
  const sendPrompt = vi.fn().mockResolvedValue(JSON.stringify({
    section: "IDE",
    summary: "Agent sessions keep related work organized and make review faster.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Rolling out in VS Code",
      keyCapabilities: "Organize chats, accelerate review, clarify navigation",
      howToUse: "Open Agents and group related sessions",
    },
    speakerNotes: { en: presenterScript },
  }));

  await expect(
    generateSlideReadyContent(sendPrompt, "Initial prompt", ["en"], "Article title"),
  ).resolves.toMatchObject({ section: "IDE", details: { feature: "Grouped agent sessions" } });
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

test("requests a rewrite instead of truncating generated capability points", async () => {
  const generated = {
    section: "IDE",
    summary: "Visual Studio improves agent workflows with clearer controls and faster review.",
    notes: ["Configure agent behavior per task", "Review generated changes before committing"],
    details: {
      feature: "Agent workflow improvements",
      availability: "Available in current Visual Studio channels",
      keyCapabilities:
        "Improve debugging; customize agent behavior; accelerate review; organize sessions; simplify navigation",
      howToUse: "Update Visual Studio and open the Copilot tools",
    },
    speakerNotes: { en: presenterScript },
  };
  const corrected = {
    ...generated,
    details: {
      ...generated.details,
      keyCapabilities: "Improve debugging and agent customization; accelerate review; organize sessions and simplify navigation",
    },
  };
  const sendPrompt = vi.fn()
    .mockResolvedValueOnce(JSON.stringify(generated))
    .mockResolvedValueOnce(JSON.stringify(corrected));

  await expect(
    generateSlideReadyContent(sendPrompt, "Initial prompt", ["en"], "Article title"),
  ).resolves.toMatchObject({
    details: {
      keyCapabilities: corrected.details.keyCapabilities,
    },
  });
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(sendPrompt.mock.calls[1][0]).toContain("keyCapabilities must prioritize");
});

test("rejects four detail points when validating content directly", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary: "Visual Studio improves agent workflows with clearer controls and faster review.",
    notes: ["Configure agent behavior per task", "Review generated changes before committing"],
    details: {
      feature: "Agent workflow improvements",
      availability: "Available in current Visual Studio channels",
      keyCapabilities: "Improve debugging; customize agents; accelerate review; organize sessions",
      howToUse: "Update Visual Studio and open the Copilot tools",
    },
    speakerNotes: { en: presenterScript },
  };

  expect(slideContentIssues(content)).toContain(
    "keyCapabilities must prioritize 2-3 semicolon-separated points instead of an exhaustive list",
  );
});

test.each([
  "Migrate to Gemini 3.8 Flash, Kimi K3, or Claude Opus 5; verify administrator access before October 2",
  "Gemini 3.8 Flash, Kimi K3, and Claude Opus 5; update workflows and integrations before October 2",
  "Migrate to Gemini 3.8 Flash, Kimi K3, or Claude Opus 5; update workflows before October 2; Business and Enterprise admins may need to enable access",
])("preserves recorded retirement replacements without treating commas as points: %s", async (replacement) => {
  const content: GeneratedContent = {
    section: "Retirements",
    summary: "Teams must migrate affected Copilot workflows before the October deadline.",
    notes: ["Update workflows and integrations before the deadline", "Verify administrator access to replacement models"],
    details: {
      subject: "Model Alpha, Model Beta, Model Gamma, and Model Delta",
      retirementDate: "October 2, 2026",
      reasons: "The source does not state a reason.",
      replacement,
    },
    speakerNotes: { en: presenterScript },
  };
  const sendPrompt = vi.fn().mockResolvedValue(JSON.stringify(content));
  const result = await generateSlideReadyContent(
    sendPrompt, "Initial prompt", ["en"],
    "Upcoming deprecation of selected GitHub Copilot models", "Retirements",
  );
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  expect(result).toEqual(content);
});

test("does not confuse commas in dates or qualifiers with separate points", () => {
  const content: GeneratedContent = {
    section: "Retirements",
    summary: "Teams must migrate affected Copilot workflows before the October deadline.",
    notes: ["Update integrations", "Confirm model access"],
    details: {
      subject: "Model Alpha, Model Beta, Model Gamma, and Model Delta",
      retirementDate: "October 2, 2026, at 00:00 UTC, for all supported surfaces",
      reasons: "Not stated.",
      replacement: "Choose a supported model; confirm access; update integrations;",
    },
    speakerNotes: {},
  };
  expect(slideContentIssues(content)).toEqual([]);
  expect(slideContentIssues({
    ...content,
    details: { ...content.details, replacement: "Choose a model; confirm access; update integrations; migrate scheduled jobs" },
  })).toContain("replacement must prioritize 2-3 semicolon-separated points instead of an exhaustive list");
});

test("asks Copilot to revise noncompliant slide copy", async () => {
  const invalid = {
    section: "IDE",
    summary: "A useful update...",
    notes: ["Group related chats", "Review changes"],
    details: {
      feature: "Agent sessions",
      availability: "See the source",
      keyCapabilities: "Organize chats and clarify navigation",
      howToUse: "Open Agents",
    },
    speakerNotes: { en: presenterScript },
  };
  const valid = {
    ...invalid,
    summary: "Agent sessions keep related work organized and simplify review.",
    details: { ...invalid.details, availability: "Rolling out in VS Code" },
  };
  const sendPrompt = vi.fn()
    .mockResolvedValueOnce(JSON.stringify(invalid))
    .mockResolvedValueOnce(JSON.stringify(valid));

  await generateSlideReadyContent(sendPrompt, "Initial prompt", ["en"], "Article title");

  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(sendPrompt.mock.calls[1][0]).toContain("Revise your previous response");
  expect(sendPrompt.mock.calls[1][0]).toContain("without filler or ellipses");
});

test("accepts additional benefit-oriented capability verbs", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary: "Visual Studio gains clearer agent controls and more efficient review workflows.",
    notes: ["Configure agent behavior for each task", "Review generated changes before committing"],
    details: {
      feature: "Agent controls and review improvements",
      availability: "Available in current Visual Studio channels",
      keyCapabilities: "Provides finer controls, streamlines review, supports shared agents",
      howToUse: "Update Visual Studio and open the Copilot tools",
    },
    speakerNotes: { en: "Presenter notes." },
  };

  expect(slideContentIssues(content)).not.toContain(
    "keyCapabilities must begin with a benefit-oriented action",
  );
});

test.each([
  "Enhances debugging, customizes agent behavior, improves code review",
  "Migliora il debugging, semplifica la revisione, organizza le sessioni",
  "Prepare pull requests by resolving review feedback, failed checks, and merge conflicts; extend Copilot and Claude agent sessions to each multi-root workspace folder; organize related chats hierarchically and identify sessions needing attention.",
])("accepts benefit-oriented capability phrasing: %s", (keyCapabilities) => {
  const content: GeneratedContent = {
    section: "IDE",
    summary: "Visual Studio gains clearer agent controls and more efficient review workflows.",
    notes: ["Configure agent behavior for each task", "Review generated changes before committing"],
    details: {
      feature: "Agent controls and review improvements",
      availability: "Available in current Visual Studio channels",
      keyCapabilities,
      howToUse: "Update Visual Studio and open the Copilot tools",
    },
    speakerNotes: { en: "Presenter notes." },
  };

  expect(slideContentIssues(content)).not.toContain(
    "keyCapabilities must begin with a benefit-oriented action",
  );
  expect(slideContentIssues(content)).not.toContain(
    "keyCapabilities must be at most 36 words and 250 characters",
  );
});

test.each([
  "Use Gemini 3.7 Flash for rapid iteration; avoid it for workloads requiring the strongest reasoning",
  "Usa Gemini 3.7 Flash per iterazioni rapide; evitalo per attività che richiedono il ragionamento più avanzato",
])("accepts model-specific use and avoidance guidance: %s", (useGuidance) => {
  const content: GeneratedContent = {
    section: "Models",
    summary: "Gemini 3.7 Flash brings fast model responses to supported GitHub Copilot experiences.",
    notes: ["Choose it for rapid coding iterations", "Confirm availability in supported Copilot surfaces"],
    details: {
      modelName: "Gemini 3.7 Flash",
      availability: "Available in supported GitHub Copilot experiences",
      keyCapabilities: "Accelerate iteration, reduce latency, support everyday coding",
      useGuidance,
    },
    speakerNotes: { en: "Presenter notes." },
  };

  expect(slideContentIssues(content)).not.toContain(
    "useGuidance must explicitly state both when to use and when to avoid the model",
  );
});

test("traces Copilot responses and validation results", async () => {
  const response = JSON.stringify({
    section: "IDE",
    summary: "Agent sessions keep related work organized and make review faster.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Rolling out in VS Code",
      keyCapabilities: "Organize chats, accelerate review, clarify navigation",
      howToUse: "Open Agents and group related sessions",
    },
    speakerNotes: { en: presenterScript },
  });
  const trace = vi.fn().mockResolvedValue(undefined);

  await generateSlideReadyContent(
    vi.fn().mockResolvedValue(response),
    "Initial prompt",
    ["en"],
    "Article title",
    "IDE",
    trace,
  );

  expect(trace).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "copilot_response_received",
      response,
    }),
  );
  expect(trace).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "slide_validation_completed",
      issues: [],
    }),
  );
});

test("retries transient Copilot request failures", async () => {
  const valid = {
    section: "IDE",
    summary: "Agent sessions keep related work organized and make review faster.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Rolling out in VS Code",
      keyCapabilities: "Organizes chats, accelerates review, clarifies navigation",
      howToUse: "Open Agents and group related sessions",
    },
    speakerNotes: { en: presenterScript },
  };
  const sendPrompt = vi.fn()
    .mockRejectedValueOnce(new Error("Temporary SDK failure"))
    .mockResolvedValueOnce(JSON.stringify(valid));

  await expect(
    generateSlideReadyContent(sendPrompt, "Initial prompt", ["en"], "Article title"),
  ).resolves.toMatchObject({ details: { feature: "Grouped agent sessions" } });
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(sendPrompt.mock.calls[1][0]).toContain("Initial prompt");
  expect(sendPrompt.mock.calls[1][0]).toContain("Temporary SDK failure");
});

test("passes the latest request error without accumulating retry prompts or losing validation feedback", async () => {
  const valid = explanatoryContent("IDE");
  const invalid = { ...valid, summary: "A useful update..." };
  const send = vi.fn()
    .mockResolvedValueOnce(JSON.stringify(invalid))
    .mockRejectedValueOnce(new Error("First request error"))
    .mockRejectedValueOnce(new Error("Second request error"))
    .mockResolvedValueOnce(JSON.stringify(valid));
  await expect(generateSlideReadyContent(send, "Original source task", ["en"], "Article title"))
    .resolves.toMatchObject({ section: "IDE", summary: valid.summary, speakerNotes: valid.speakerNotes });
  expect(send.mock.calls[2][0]).toContain("First request error");
  expect(send.mock.calls[2][0]).toContain("summary must be one complete sentence without line breaks or ellipses");
  expect(send.mock.calls[3][0]).toContain("Second request error");
  expect(send.mock.calls[3][0]).not.toContain("First request error");
  expect(send.mock.calls[3][0].match(/Original source task/g)).toHaveLength(1);
  expect(send.mock.calls[3][0]).toContain("summary must be one complete sentence without line breaks or ellipses");
});

test("does not retry an SDK timeout on a still-busy session", async () => {
  const sendPrompt = vi.fn().mockRejectedValue(
    new Error("Timeout after 180000ms waiting for session.idle"),
  );
  await expect(generateSlideReadyContent(
    sendPrompt, "Initial prompt", ["en"], "Slow article",
  )).rejects.toThrow(/after 1 attempt[\s\S]*--request-timeout/);
  expect(sendPrompt).toHaveBeenCalledTimes(1);
});

test("uses one initial attempt and three corrective retries", async () => {
  const invalid = JSON.stringify({
    section: "IDE",
    summary: "A useful update...",
    notes: ["Group related chats", "Review changes"],
    details: {
      feature: "Agent sessions",
      availability: "See the source",
      keyCapabilities: "Capabilities for agent workflows",
      howToUse: "Open Agents",
    },
    speakerNotes: { en: presenterScript },
  });
  const sendPrompt = vi.fn().mockResolvedValue(invalid);

  await expect(
    generateSlideReadyContent(sendPrompt, "Initial prompt", ["en"], "Article title"),
  ).rejects.toThrow(
    /after 4 attempts[\s\S]*Last problem: summary must be one complete sentence[\s\S]*Suggested action:/,
  );
  expect(sendPrompt).toHaveBeenCalledTimes(4);
});

test("uses a reviewer after corrective retries are exhausted", async () => {
  const invalid = JSON.stringify({
    section: "IDE",
    summary: "A useful update...",
    notes: ["Group related chats", "Review changes"],
    details: {
      feature: "Agent sessions",
      availability: "See the source",
      keyCapabilities: "Capabilities for agent workflows",
      howToUse: "Open Agents",
    },
    speakerNotes: { en: presenterScript },
  });
  const valid = JSON.stringify({
    section: "IDE",
    summary: "VS Code agent sessions organize related work and preserve context for later review.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Rolling out in VS Code",
      keyCapabilities: "Organize related chats by task; preserve session context; review proposed changes before merging",
      howToUse: "Open Agents, select the relevant session, then review its proposed changes",
    },
    speakerNotes: { en: presenterScript },
  });
  const sendPrompt = vi.fn().mockResolvedValue(invalid);
  const sendReviewerPrompt = vi.fn().mockResolvedValue(valid);
  const trace = vi.fn().mockResolvedValue(undefined);

  await expect(generateSlideReadyContent(
    sendPrompt,
    "Initial prompt with source article",
    ["en"],
    "Article title",
    "IDE",
    trace,
    undefined,
    sendReviewerPrompt,
  )).resolves.toMatchObject({ details: { feature: "Grouped agent sessions" } });

  expect(sendPrompt).toHaveBeenCalledTimes(4);
  expect(sendReviewerPrompt).toHaveBeenCalledTimes(1);
  expect(sendReviewerPrompt.mock.calls[0][0]).toContain("Initial prompt with source article");
  expect(sendReviewerPrompt.mock.calls[0][0]).toContain("Rejected response:");
  expect(trace).toHaveBeenCalledWith(expect.objectContaining({
    event: "copilot_attempt_started",
    attempt: 5,
    agent: "reviewer",
  }));
});

test("requests a rewrite of oversized title details without dropping the last point", async () => {
  const generated = {
    section: "Announcements",
    summary: "GitHub Copilot gives administrators more control over enterprise configuration.",
    notes: ["Review the new controls", "Update policies for affected organizations"],
    details: {
      announcement:
        "Adds policy controls; expands model settings; improves rollout visibility; simplifies administration",
      availability: "Available to enterprise administrators",
      impact: "Reduces configuration drift and makes policy changes easier to coordinate",
      audience: "Enterprise owners and Copilot administrators",
    },
    speakerNotes: { en: presenterScript },
  };
  const corrected = {
    ...generated,
    details: {
      ...generated.details,
      announcement: "Simplifies administration with policy controls, expanded model settings and clearer rollout visibility",
    },
  };
  const sendPrompt = vi.fn()
    .mockResolvedValueOnce(JSON.stringify(generated))
    .mockResolvedValueOnce(JSON.stringify(corrected));

  const result = await generateSlideReadyContent(
    sendPrompt,
    "Initial prompt",
    ["en"],
    "Enterprise Copilot controls",
    "Announcements",
  );

  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(result.details.announcement).toBe(corrected.details.announcement);
  expect(slideContentIssues(result, "Enterprise Copilot controls", "Announcements", ["en"])).toEqual([]);
});

test.each(["availability", "summary", "notes", "note"] as const)(
  "does not silently discard conditions from oversized %s",
  async (field) => {
    const content = {
      section: "IDE",
      summary: "Agent sessions keep related work organized and make review faster.",
      notes: ["Group related chats by task", "Review generated changes before merging"],
      details: {
        feature: "Grouped agent sessions",
        availability: "Rolling out in VS Code",
        keyCapabilities: "Organize chats, accelerate review, clarify navigation",
        howToUse: "Open Agents and group related sessions",
      },
      speakerNotes: { en: presenterScript },
    };
    if (field === "availability") {
      content.details.availability =
        "Available to all Copilot plans; supported in VS Code; enabled by default; except Business and Enterprise";
    } else if (field === "summary") {
      content.summary =
        "Agent sessions let developers organize all their work with clearer navigation and faster review while keeping every related task together in the editor and sharing useful context across their daily workflows except on Enterprise plans.";
    } else if (field === "notes") {
      content.notes.push("Confirm editor availability", "Review organization policy", "Not available on Enterprise plans");
    } else {
      content.notes[0] =
        "Group related chats by task and review all generated changes carefully before merging them into shared repositories except when organizational policy prohibits this workflow.";
    }
    const sendPrompt = vi.fn().mockResolvedValue(JSON.stringify(content));

    await expect(generateSlideReadyContent(
      sendPrompt, "Initial prompt", ["en"], "Article title", "IDE",
    )).rejects.toThrow("after 4 attempts");
    expect(sendPrompt).toHaveBeenCalledTimes(4);
    expect(sendPrompt.mock.calls[1][0]).toContain("exceptions");
  },
);

test("accepts a corrective rewrite that preserves the final eligibility exception", async () => {
  const original = {
    section: "IDE",
    summary: "Agent sessions keep related work organized and make review faster.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Available to all Copilot plans; supported in VS Code; enabled by default; except Business and Enterprise",
      keyCapabilities: "Organize chats, accelerate review, clarify navigation",
      howToUse: "Open Agents and group related sessions",
    },
    speakerNotes: { en: presenterScript },
  };
  const corrected = {
    ...original,
    details: {
      ...original.details,
      availability: "Enabled by default in VS Code on all Copilot plans except Business and Enterprise",
    },
  };
  const sendPrompt = vi.fn()
    .mockResolvedValueOnce(JSON.stringify(original))
    .mockResolvedValueOnce(JSON.stringify(corrected));

  const result = await generateSlideReadyContent(sendPrompt, "Initial prompt", ["en"], "Article title", "IDE");
  expect(sendPrompt).toHaveBeenCalledTimes(2);
  expect(result).toEqual(corrected);
  expect(sendPrompt.mock.calls[1][0]).toContain("Keep valid, concrete details in unaffected fields");
  expect(sendPrompt.mock.calls[1][0]).toContain("remove repetition and filler before source-backed mechanisms");
  expect(sendPrompt.mock.calls[1][0]).toContain("Keep the original detail targets where the source supports them, without adding facts");
});

test("accepts common benefit-oriented capability verbs", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary: "Visual Studio adds organization agents, reasoning controls, and inline change review.",
    notes: ["Publish shared agents across repositories", "Tune reasoning effort for each task"],
    details: {
      feature: "Custom agents and Git change review",
      availability: "Available in Visual Studio 2026",
      keyCapabilities:
        "Share specialized agents organization-wide; tune reasoning depth; catch findings before pull requests",
      howToUse: "Ask the Git agent to review uncommitted changes",
    },
    speakerNotes: { en: presenterScript },
  };

  expect(slideContentIssues(content)).not.toContain(
    "keyCapabilities must begin with a benefit-oriented action",
  );
});

test("rejects publication dates presented as availability", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary: "Teams can standardize editor model choices while administrators retain policy control.",
    notes: ["Choose approved models in the editor", "Keep organizational policy centrally governed"],
    details: {
      feature: "Model selection and policy controls",
      availability: "Supported IDEs, announced August 15",
      keyCapabilities: "Standardize model choice, enforce policy, govern previews",
      howToUse: "Choose an approved model in the editor",
    },
    speakerNotes: { en: "Presenter notes." },
  };

  expect(slideContentIssues(content)).toContain(
    "availability must describe product status, eligibility, plans, or supported surfaces, not the article date",
  );
});

test("rejects feature cards that substantially repeat the article title", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary: "Developers gain finer control over reasoning, shared agents, and code review workflows.",
    notes: ["Tune reasoning depth for each task", "Share custom agents across development teams"],
    details: {
      feature: "Visual Studio Copilot August Update",
      availability: "Visual Studio 2026 Insiders and General channels",
      keyCapabilities: "Control reasoning depth; share custom agents; review changes before pull requests",
      howToUse: "Select thinking effort or invoke Git agent before committing",
    },
    speakerNotes: { en: "Presenter notes." },
  };

  expect(
    slideContentIssues(content, "GitHub Copilot in Visual Studio — August update"),
  ).toContain("feature must name the concrete changes instead of repeating the article title");
});

test("allows a concise feature label to overlap with the summary", () => {
  const content: GeneratedContent = {
    section: "IDE",
    summary:
      "GitHub Copilot for JetBrains adds enterprise-managed plugin governance, MCP server controls, and centralized telemetry.",
    notes: [
      "Require or block plugins and approved marketplaces",
      "Prevent connections to unauthorized MCP servers",
    ],
    details: {
      feature: "Plugin governance, MCP server controls, and centralized telemetry",
      availability: "Available in the latest GitHub Copilot plugin for JetBrains",
      keyCapabilities: "Enforce plugin rules, block unauthorized servers, standardize telemetry",
      howToUse: "Update the plugin, then apply organization policies to a pilot team",
    },
    speakerNotes: { en: presenterScript },
  };

  expect(slideContentIssues(content)).not.toContain(
    "feature must add a distinct fact instead of repeating the summary",
  );
});

test("classifies only newly available models in Models", () => {
  const launch = changelogPost(
    "Claude Sonnet 5 is now available in GitHub Copilot",
    "Claude Sonnet 5 is rolling out to Copilot Pro and Business customers. It improves coding and agent workflows.",
  );
  const policy = changelogPost(
    "New model selection controls for GitHub Copilot",
    "Administrators can control which existing models are available to members through organization policy.",
  );
  const ide = changelogPost(
    "Model picker improvements in Visual Studio",
    "Visual Studio now makes it easier to compare and select supported Copilot models.",
  );
  const incidentalMention = changelogPost(
    "Copilot coding agent workflow improvements",
    "GPT-5 is now available to agent users. The update focuses on queue management and session review.",
  );

  expect(isNewModelAvailabilityPost(launch)).toBe(true);
  expect(classifySection(launch)).toBe("Models");
  expect(isNewModelAvailabilityPost(policy)).toBe(false);
  expect(classifySection(policy)).toBe("Announcements");
  expect(isNewModelAvailabilityPost(ide)).toBe(false);
  expect(classifySection(ide)).toBe("IDE");
  expect(isNewModelAvailabilityPost(incidentalMention)).toBe(false);
  expect(classifySection(incidentalMention)).toBe("Announcements");
});

test("classifies only enterprise owner and administrator updates in Enterprise Admins", () => {
  const ownerSetting = changelogPost(
    "Enterprise owners can configure Copilot coding agent access",
    "GitHub Enterprise owners can now enforce the setting across organizations in the GitHub.com enterprise settings portal.",
  );
  const administratorPolicy = changelogPost(
    "New policy controls for GitHub Enterprise Cloud",
    "Administrators of a GitHub Enterprise account can configure the policy on the enterprise policies page.",
  );
  const ghesManagementConsole = changelogPost(
    "GHES administrators can configure Copilot access",
    "GitHub Enterprise Server administrators can manage the setting through the GHES Management Console.",
  );
  const enterpriseManagedPermissions = changelogPost(
    "Enterprise managed permissions for GitHub Copilot agent operations",
    "If you administer GitHub Copilot Business or GitHub Copilot Enterprise, you can now centrally control which agent operations are blocked, require human approval, or can proceed without a prompt. Managed permissions cover shell commands, file reads and edits, and network domains.",
  );
  const enterpriseMemberFeature = changelogPost(
    "Copilot Spaces are available on GitHub Enterprise Cloud",
    "Enterprise members can use Spaces to share development context.",
  );
  const organizationAdminFeature = changelogPost(
    "Organization administrators can manage Copilot access",
    "The setting is available to organization owners on Business plans.",
  );
  const apiOnlyAdministration = changelogPost(
    "Enterprise owners can configure Copilot access through the API",
    "GitHub Enterprise administrators can manage this policy using REST API endpoints and the CLI.",
  );
  const genericAdminAnnouncement = changelogPost(
    "New controls for enterprise administrators",
    "GitHub Enterprise administrators can review the new feature announcement.",
  );

  expect(classifySection(ownerSetting)).toBe("Enterprise Admins");
  expect(classifySection(administratorPolicy)).toBe("Enterprise Admins");
  expect(classifySection(ghesManagementConsole)).toBe("Enterprise Admins");
  expect(classifySection(enterpriseManagedPermissions)).toBe("Enterprise Admins");
  expect(classifySection(enterpriseMemberFeature)).toBe("Announcements");
  expect(classifySection(organizationAdminFeature)).toBe("Announcements");
  expect(classifySection(apiOnlyAdministration)).toBe("Announcements");
  expect(classifySection(genericAdminAnnouncement)).toBe("Announcements");
});

test("keeps model retirements out of Models", () => {
  const retirement = changelogPost(
    "Retirement of GPT-4.1 in GitHub Copilot",
    "GPT-4.1 will be retired on October 1 and replaced by GPT-5.",
  );

  expect(isNewModelAvailabilityPost(retirement)).toBe(false);
  expect(classifySection(retirement)).toBe("Retirements");
});

test.each([
  ["New VS Code agent controls", "You can now remove completed sessions from the sidebar.", "IDE"],
  ["Copilot can remove obsolete files", "VS Code users can remove files during agent tasks.", "IDE"],
  ["GPT-4 is retiring", "GPT-4 will stop serving requests next month.", "Retirements"],
  ["Upcoming model deprecations", "Older models are being replaced.", "Retirements"],
  ["GPT-4 has been removed from GitHub Copilot", "Use GPT-5 instead.", "Retirements"],
  ["GPT-5 is now available", "GPT-5 is available in Copilot. Remove old sessions to organize your work.", "Models"],
])("classifies the source topic rather than an operational verb: %s", (title, text, section) => {
  expect(classifySection(changelogPost(title, text))).toBe(section);
});

test("requires Copilot to preserve the preclassified section", async () => {
  const wrongSection = {
    section: "Models",
    summary: "Administrators gain clearer controls for models already offered in GitHub Copilot.",
    notes: ["Apply model policies by organization", "Review existing model access before rollout"],
    details: {
      modelName: "Existing model policy controls",
      availability: "Available to organization administrators",
      keyCapabilities: "Controls model access, clarifies governance, supports policy rollout",
      useGuidance: "Use for organization governance; avoid for individual model selection.",
    },
    speakerNotes: { en: presenterScript },
  };
  const correctSection = {
    section: "Announcements",
    summary: "Administrators gain clearer controls for models already offered in GitHub Copilot.",
    notes: ["Apply model policies by organization", "Review existing model access before rollout"],
    details: {
      announcement: "Organization controls govern access to existing models",
      availability: "Available to GitHub Copilot organization administrators",
      impact: "Centralizes model governance and requires administrators to review access policies",
      audience: "Organization owners managing GitHub Copilot model access",
    },
    speakerNotes: { en: presenterScript },
  };
  const sendPrompt = vi.fn()
    .mockResolvedValueOnce(JSON.stringify(wrongSection))
    .mockResolvedValueOnce(JSON.stringify(correctSection));

  await expect(
    generateSlideReadyContent(
      sendPrompt,
      "Initial prompt",
      ["en"],
      "New model selection controls",
      "Announcements",
    ),
  ).resolves.toMatchObject({ section: "Announcements" });
  expect(sendPrompt.mock.calls[1][0]).toContain("section must be Announcements");
});

test("keeps slide content concise without AI", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const post: ChangelogPost = {
    title: "GitHub Copilot in VS Code adds many agent workflow improvements",
    url: "https://github.blog/changelog/example",
    publishedAt: "2026-08-31T10:00:00.000Z",
    plainText:
      "The release improves agent sessions, review workflows, navigation, prompts, plugins, tools, model switching, browser integration, terminal output, transcript search, custom instructions, and many experimental settings across several versions. Users can update VS Code and enable experimental settings to explore every individual enhancement and configuration described in the full release notes.",
    html: "<p>Long release description.</p>",
    imageUrls: [],
    links: [],
  };

  const [result] = await enrichWithCopilot([post], {
    model: "auto",
    useAi: false,
    slidesLanguage: "en",
    speakerNotesLanguages: ["en"],
  });

  expect(result.summary.split(/\s+/).length).toBeLessThanOrEqual(24);
  expect(result.summary.length).toBeLessThanOrEqual(160);
  expect(result.summary).not.toContain("...");
  for (const key of sectionDetailKeys[result.section]) {
    const detail = result.details[key] ?? "";
    expect(detail.split(/\s+/).length).toBeLessThanOrEqual(18);
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail).not.toContain("...");
  }
});

test("does not label unrelated RSS content as a Copilot announcement", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const [result] = await enrichWithCopilot([
    changelogPost("Database replication release", "Database replication adds automatic failover. Operators can configure standby nodes."),
  ], { model: "auto", useAi: false, slidesLanguage: "en", speakerNotesLanguages: ["en"] });
  expect(result.section).toBe("Announcements");
  expect(result.details.audience).toBe("Users and administrators affected by this change.");
  expect(JSON.stringify(result.details)).not.toContain("Copilot");
});

test("enriches articles with bounded parallelism while preserving order", async () => {
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeRequests -= 1;
    return { ok: false };
  }));
  const posts: ChangelogPost[] = Array.from({ length: 4 }, (_, index) => ({
    title: `Copilot update ${index + 1}`,
    url: `https://github.blog/changelog/update-${index + 1}`,
    publishedAt: "2026-08-31T10:00:00.000Z",
    plainText: `Update ${index + 1} improves workflows for developers and administrators.`,
    html: "<p>Update details.</p>",
    imageUrls: [],
    links: [],
  }));

  const results = await enrichWithCopilot(posts, {
    model: "auto",
    useAi: false,
    slidesLanguage: "en",
    speakerNotesLanguages: ["en"],
    concurrency: 2,
  });

  expect(maximumActiveRequests).toBe(2);
  expect(results.map((post) => post.url)).toEqual(posts.map((post) => post.url));
});

test.each([
  { concurrency: undefined, expectedConcurrency: 1 },
  { concurrency: 2, expectedConcurrency: 2 },
])("uses one client and independent article sessions with concurrency $concurrency", async ({ concurrency, expectedConcurrency }) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  let activeSessions = 0;
  let maximumActiveSessions = 0;
  let sessionsCreated = 0;
  const disconnectedSessions: number[] = [];
  const generated = JSON.stringify({
    section: "Announcements",
    summary: "GitHub Copilot improves workflows while giving teams clearer operational guidance.",
    notes: ["Review the announced workflow changes", "Confirm availability for affected Copilot users"],
    details: {
      announcement: "Copilot introduces clearer workflow guidance for development teams",
      availability: "Available to the Copilot users identified in the announcement",
      impact: "Clarifies expected workflows and helps teams prepare the required adoption steps",
      audience: "Developers and administrators using the affected GitHub Copilot capabilities",
    },
    speakerNotes: { en: presenterScript },
  });
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(async (config) => {
      expect(config?.availableTools).toEqual([]);
      if (concurrency === undefined) expect(activeSessions).toBe(0);
      const sessionIndex = sessionsCreated++;
      maximumActiveSessions = Math.max(maximumActiveSessions, ++activeSessions);
      return {
        sendAndWait: async () => {
          activeRequests += 1;
          maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
          await new Promise((resolve) => setTimeout(resolve, 25));
          activeRequests -= 1;
          return { data: { content: generated } };
        },
        abort: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeSessions -= 1;
          disconnectedSessions.push(sessionIndex);
        }),
      };
    }),
  };
  const posts = [
    changelogPost("Copilot workflow update one", "The workflow now provides clearer guidance."),
    changelogPost("Copilot workflow update two", "The workflow now supports simpler adoption."),
    changelogPost("Copilot workflow update three", "The workflow now improves team coordination."),
  ];
  const clientFactory = vi.fn(() => client);

  const results = await enrichWithCopilot(posts, {
    model: "auto",
    useAi: true,
    slidesLanguage: "en",
    speakerNotesLanguages: ["en"],
    concurrency,
    clientFactory,
  });

  expect(clientFactory).toHaveBeenCalledTimes(1);
  expect(client.start).toHaveBeenCalledTimes(1);
  expect(client.stop).toHaveBeenCalledTimes(1);
  expect(maximumActiveRequests).toBe(expectedConcurrency);
  expect(maximumActiveSessions).toBe(expectedConcurrency);
  expect(activeSessions).toBe(0);
  expect(disconnectedSessions.sort()).toEqual([0, 1, 2]);
  expect(sessionsCreated).toBe(3);
  expect(results.map((post) => post.title)).toEqual(posts.map((post) => post.title));
});

test.each(["en", "it"] as const)("requests concrete slide explanations with valid %s examples", async (language) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const sendAndWait = vi.fn(async ({ prompt }: { prompt: string }) => {
    expect(prompt).toContain(`Write summary, notes, and detail values in ${language === "it" ? "Italian" : "English"}.`);
    expect(prompt).toContain("source-backed change, mechanism, practical effect, supported workflow, and essential constraints");
    expect(prompt).toContain("pair the named capability or change with how it works or what it changes for the user");
    expect(prompt).toContain("Use the available word and character budget for facts, not adjectives");
    expect(prompt).toContain("Do not pad short sources or invent missing instructions");
    expect(prompt).toContain("never copy its facts unless supported by the actual article");
    expect(prompt).not.toContain("Agent sessions stay organized while developers review changes faster.");
    const prefix = "Illustrative output: ";
    const exampleLine = prompt.split("\n\n").find((line) => line.startsWith(prefix));
    expect(exampleLine).toBeDefined();
    const example: Pick<GeneratedContent, "summary" | "details"> = JSON.parse(exampleLine!.slice(prefix.length));
    const content = { ...explanatoryContent("IDE"), ...example };
    expect(slideContentIssues(content)).toEqual([]);
    for (const key of ["keyCapabilities", "howToUse"] as const) {
      expect(content.details[key].trim().split(/\s+/).length).toBeGreaterThanOrEqual(28);
      expect(content.details[key]).toContain("diff");
    }
    expect(content.details.howToUse).toContain(language === "it" ? "contesto salvato" : "saved context");
    return { data: { content: JSON.stringify(content) } };
  });
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(async (config) => {
      expect(config.systemMessage.content).toContain("informative slide explanations, not terse labels or marketing slogans");
      return {
        sendAndWait,
        abort: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
  const result = await enrichWithCopilot(
    [changelogPost("VS Code agent session groups", "VS Code now groups agent sessions by task.")],
    {
      model: "auto", useAi: true, slidesLanguage: language, speakerNotesLanguages: ["en"],
      clientFactory: () => client,
    },
  );
  expect(result).toHaveLength(1);
  expect(sendAndWait).toHaveBeenCalledTimes(1);
});

test("downloads article images while Copilot content is being generated", async () => {
  let generationFinished = false;
  let imageStartedDuringGeneration = false;
  vi.stubGlobal("fetch", vi.fn(async () => {
    imageStartedDuringGeneration = !generationFinished;
    return { ok: false };
  }));
  const generated = JSON.stringify({
    section: "Announcements",
    summary: "GitHub Copilot improves workflows while giving teams clearer operational guidance.",
    notes: ["Review the announced workflow changes", "Confirm availability for affected Copilot users"],
    details: {
      announcement: "Copilot introduces clearer workflow guidance for development teams",
      availability: "Available to the Copilot users identified in the announcement",
      impact: "Clarifies expected workflows and helps teams prepare the required adoption steps",
      audience: "Developers and administrators using the affected GitHub Copilot capabilities",
    },
    speakerNotes: { en: presenterScript },
  });
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(async () => ({
      sendAndWait: async ({ prompt }) => {
        expect(prompt).toContain("44 words and 300 characters");
        expect(prompt).toContain("Models keyCapabilities and useGuidance, IDE keyCapabilities and howToUse, and Retirements reasons and replacement");
        expect(prompt).toContain("28-34 words per card, at most 36 words and 250 characters");
        expect(prompt).toContain("keep prerequisites and caveats needed to act correctly on the slide");
        expect(prompt).toContain("concrete workloads and source-stated limitations or trade-offs");
        expect(prompt).toContain("essential setup or prerequisite");
        expect(prompt).toContain("required migration action or verification");
        expect(prompt).toContain("Never invent details to fill space");
        await new Promise((resolve) => setTimeout(resolve, 20));
        generationFinished = true;
        return { data: { content: generated } };
      },
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    })),
  };

  await enrichWithCopilot(
    [changelogPost("Copilot workflow update", "The workflow now provides clearer guidance.")],
    {
      model: "auto",
      useAi: true,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
      clientFactory: () => client,
    },
  );

  expect(imageStartedDuringGeneration).toBe(true);
});

test("resolves a Copilot model display name to its model ID", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  let sessionModel: string | undefined;
  const generated = JSON.stringify({
    section: "Announcements",
    summary: "GitHub Copilot improves workflows while giving teams clearer operational guidance.",
    notes: ["Review the announced workflow changes", "Confirm availability for affected Copilot users"],
    details: {
      announcement: "Copilot introduces clearer workflow guidance for development teams",
      availability: "Available to the Copilot users identified in the announcement",
      impact: "Clarifies expected workflows and helps teams prepare the required adoption steps",
      audience: "Developers and administrators using the affected GitHub Copilot capabilities",
    },
    speakerNotes: { en: presenterScript },
  });
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([
      {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        capabilities: {},
      },
    ]),
    createSession: vi.fn(async (config) => {
      sessionModel = config.model;
      return {
        sendAndWait: async () => ({ data: { content: generated } }),
        abort: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };

  await enrichWithCopilot(
    [changelogPost("Copilot workflow update", "The workflow now provides clearer guidance.")],
    {
      model: "GPT-5 mini",
      useAi: true,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
      clientFactory: () => client,
    },
  );

  expect(sessionModel).toBe("gpt-5-mini");
});

test("reports available Copilot models when the requested model is unavailable", async () => {
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([
      {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        capabilities: {},
      },
    ]),
    createSession: vi.fn(),
  };

  await expect(
    enrichWithCopilot(
      [changelogPost("Copilot workflow update", "The workflow now provides clearer guidance.")],
      {
        model: "missing-model",
        useAi: true,
        slidesLanguage: "en",
        speakerNotesLanguages: ["en"],
        clientFactory: () => client,
      },
    ),
  ).rejects.toThrow(
    'Copilot model "missing-model" is not available. Available models: GPT-5 mini (gpt-5-mini).',
  );
  expect(client.createSession).not.toHaveBeenCalled();
  expect(client.stop).toHaveBeenCalledTimes(1);
});

test.each(["start", "listModels", "createSession"] as const)(
  "stops the Copilot client when %s fails",
  async (stage) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const error = new Error(`${stage} failed`);
    const client: EnrichmentCopilotClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      listModels: vi.fn().mockResolvedValue([{ id: "test-model", name: "Test model", capabilities: {} }]),
      createSession: vi.fn(),
    };
    vi.mocked(client[stage]!).mockRejectedValue(error);

    await expect(enrichWithCopilot(
      [changelogPost("Copilot workflow update", "The workflow now provides clearer guidance.")],
      {
        model: "test-model", useAi: true, slidesLanguage: "en",
        speakerNotesLanguages: ["en"], clientFactory: () => client,
      },
    )).rejects.toThrow(`${stage} failed`);
    expect(client.stop).toHaveBeenCalledTimes(1);
  },
);

test.each(["throws", "returns errors"])("preserves startup and cleanup errors when stop %s", async (mode) => {
  const primary = new Error("Startup failed");
  const cleanup = new Error("Cleanup failed");
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockRejectedValue(primary),
    stop: mode === "throws"
      ? vi.fn().mockRejectedValue(cleanup)
      : vi.fn().mockResolvedValue([cleanup]),
    createSession: vi.fn(),
  };

  await expect(enrichWithCopilot([], {
    model: "auto", useAi: true, slidesLanguage: "en",
    speakerNotesLanguages: ["en"], clientFactory: () => client,
  })).rejects.toThrow(/Startup failed[\s\S]*Cleanup failed/);
  expect(client.stop).toHaveBeenCalledTimes(1);
});

test.each([undefined, 90_000])("aborts timed-out requests before disconnecting (timeout: %s)", async (requestTimeoutMs) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const order: string[] = [];
  const sendAndWait = vi.fn(async () => {
    order.push("send");
    throw new Error(`Timeout after ${requestTimeoutMs ?? 180_000}ms waiting for session.idle`);
  });
  const abort = vi.fn(async () => { order.push("abort"); });
  const disconnect = vi.fn(async () => { order.push("disconnect"); });
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(async () => { order.push("stop"); }),
    createSession: vi.fn().mockResolvedValue({ sendAndWait, abort, disconnect }),
  };
  await expect(enrichWithCopilot([
    changelogPost("Slow article", "Source content."),
    changelogPost("Queued article", "Other source content."),
  ], {
    model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
    concurrency: 1, requestTimeoutMs, clientFactory: () => client,
  })).rejects.toThrow(/after 1 attempt/);
  expect(sendAndWait).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ prompt: expect.any(String) }), requestTimeoutMs ?? 180_000,
  );
  expect(order).toEqual(["send", "abort", "disconnect", "stop"]);
  expect(client.createSession).toHaveBeenCalledTimes(1);
});

test("accepts a response after the former 60-second limit without a second request", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const generated = {
    section: "IDE",
    summary: "Agent sessions keep related work organized and make review faster.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Rolling out in VS Code",
      keyCapabilities: "Organize chats, accelerate review, clarify navigation",
      howToUse: "Open Agents and group related sessions",
    },
    speakerNotes: { en: presenterScript },
  };
  const sendAndWait = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 90_000));
    return { data: { content: JSON.stringify(generated) } };
  });
  const abort = vi.fn().mockResolvedValue(undefined);
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({
      sendAndWait, abort, disconnect: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const assertion = expect(enrichWithCopilot(
    [changelogPost("Agent view organization", "VS Code now groups related agent chats.")],
    {
      model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
      clientFactory: () => client,
    },
  )).resolves.toMatchObject([generated]);
  await vi.advanceTimersByTimeAsync(90_000);
  await assertion;
  expect(sendAndWait).toHaveBeenCalledTimes(1);
  expect(abort).not.toHaveBeenCalled();
});

test("creates a separate reviewer session only after four invalid responses", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const invalid = JSON.stringify({
    section: "IDE",
    summary: "A useful update...",
    notes: ["Group chats", "Review changes"],
    details: {
      feature: "Agent sessions",
      availability: "See the source",
      keyCapabilities: "Capabilities for workflows",
      howToUse: "Open Agents",
    },
    speakerNotes: { en: presenterScript },
  });
  const valid = JSON.stringify({
    section: "IDE",
    summary: "VS Code agent sessions organize related work and preserve context for later review.",
    notes: ["Group related chats by task", "Review generated changes before merging"],
    details: {
      feature: "Grouped agent sessions",
      availability: "Rolling out in VS Code",
      keyCapabilities: "Organize related chats by task; preserve session context; review proposed changes before merging",
      howToUse: "Open Agents, select the relevant session, then review its proposed changes",
    },
    speakerNotes: { en: presenterScript },
  });
  const primaryDisconnect = vi.fn().mockResolvedValue(undefined);
  const reviewerDisconnect = vi.fn().mockResolvedValue(undefined);
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn()
      .mockResolvedValueOnce({
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: invalid } }),
        abort: vi.fn(),
        disconnect: primaryDisconnect,
      })
      .mockResolvedValueOnce({
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: valid } }),
        abort: vi.fn(),
        disconnect: reviewerDisconnect,
      }),
  };

  await expect(enrichWithCopilot(
    [changelogPost("Agent session improvements", "VS Code groups related agent chats and preserves context.")],
    {
      model: "auto",
      useAi: true,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
      clientFactory: () => client,
    },
  )).resolves.toMatchObject([{ details: { feature: "Grouped agent sessions" } }]);

  expect(client.createSession).toHaveBeenCalledTimes(2);
  expect(client.createSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
    systemMessage: expect.objectContaining({ content: expect.stringContaining("content reviewer") }),
  }));
  expect(primaryDisconnect).toHaveBeenCalledTimes(1);
  expect(reviewerDisconnect).toHaveBeenCalledTimes(1);
});

test("omits a slide that fails final review and continues with the next article", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const invalid = JSON.stringify({
    section: "IDE",
    summary: "A useful update...",
    notes: ["Group chats", "Review changes"],
    details: {
      feature: "Agent sessions",
      availability: "See the source",
      keyCapabilities: "Capabilities for workflows",
      howToUse: "Open Agents",
    },
    speakerNotes: { en: presenterScript },
  });
  const valid = JSON.stringify({
    section: "Announcements",
    summary: "GitHub Copilot adds workflow guidance that helps development teams prepare for the announced change.",
    notes: ["Review the changed workflow", "Confirm availability before adoption"],
    details: {
      announcement: "GitHub Copilot introduces clearer workflow guidance for development teams",
      availability: "Available to users identified in the announcement",
      impact: "Explains the changed workflow and the concrete adoption steps teams should prepare",
      audience: "Developers and administrators using the affected Copilot capabilities",
    },
    speakerNotes: { en: presenterScript },
  });
  let sessionNumber = 0;
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(async () => {
      const content = sessionNumber < 2 ? invalid : valid;
      sessionNumber += 1;
      return {
        sendAndWait: vi.fn().mockResolvedValue({ data: { content } }),
        abort: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
  const first = {
    ...changelogPost("Agent session improvements", "VS Code groups related agent chats."),
    url: "https://github.blog/changelog/agent-session-improvements",
  };
  const second = {
    ...changelogPost("Copilot workflow update", "GitHub Copilot adds workflow guidance."),
    url: "https://github.blog/changelog/copilot-workflow-update",
  };
  const trace = vi.fn().mockResolvedValue(undefined);

  const result = await enrichWithCopilot([first, second], {
    model: "auto",
    useAi: true,
    slidesLanguage: "en",
    speakerNotesLanguages: ["en"],
    clientFactory: () => client,
    trace,
  });

  expect(result.map((post) => post.url)).toEqual([second.url]);
  expect(client.createSession).toHaveBeenCalledTimes(3);
  expect(trace).toHaveBeenCalledWith(expect.objectContaining({
    event: "article_review_skipped",
    articleTitle: first.title,
  }));
  expect(trace).toHaveBeenCalledWith(expect.objectContaining({
    event: "article_processing_completed",
    articleTitle: second.title,
  }));
});

test("stops peer retries and queued articles after a timeout", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const slowSend = vi.fn().mockRejectedValue(new Error("Timeout after 180000ms waiting for session.idle"));
  const peerSend = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { data: { content: "{}" } };
  });
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn()
      .mockResolvedValueOnce({
        sendAndWait: slowSend, abort: vi.fn(), disconnect: vi.fn(),
      })
      .mockResolvedValueOnce({
        sendAndWait: peerSend, abort: vi.fn(), disconnect: vi.fn(),
      }),
  };
  await expect(enrichWithCopilot([
    changelogPost("Slow article", "Source content."),
    changelogPost("Active article", "Other source content."),
    changelogPost("Queued article", "Queued source content."),
  ], {
    model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
    concurrency: 2, clientFactory: () => client,
  })).rejects.toThrow(/after 1 attempt/);
  expect(slowSend).toHaveBeenCalledTimes(1);
  expect(peerSend).toHaveBeenCalledTimes(1);
  expect(client.createSession).toHaveBeenCalledTimes(2);
});

test("bounds a stuck send and a stuck abort, then still disconnects and stops", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const sendAndWait = vi.fn(() => new Promise<undefined>(() => {}));
  const abort = vi.fn(() => new Promise<void>(() => {}));
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ sendAndWait, abort, disconnect }),
  };
  const assertion = expect(enrichWithCopilot(
    [changelogPost("Slow article", "Source content.")],
    {
      model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
      requestTimeoutMs: 25, clientFactory: () => client,
    },
  )).rejects.toThrow(/timed out after 25ms[\s\S]*abort timed out/);
  await vi.advanceTimersByTimeAsync(10_025);
  await assertion;
  expect(sendAndWait).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(client.stop).toHaveBeenCalledTimes(1);
});

test("bounds graceful cleanup and tries forceStop without hiding the failure", async () => {
  vi.useFakeTimers();
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockRejectedValue(new Error("Startup failed")),
    stop: vi.fn(() => new Promise<void>(() => {})),
    forceStop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(),
  };
  const assertion = expect(enrichWithCopilot([], {
    model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
    clientFactory: () => client,
  })).rejects.toThrow(/Startup failed[\s\S]*cleanup timed out/);
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(client.forceStop).toHaveBeenCalledTimes(1);
});

test("preserves graceful and forced cleanup errors", async () => {
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockRejectedValue(new Error("Startup failed")),
    stop: vi.fn().mockResolvedValue([new Error("Graceful stop failed")]),
    forceStop: vi.fn().mockRejectedValue(new Error("Forced stop failed")),
    createSession: vi.fn(),
  };
  await expect(enrichWithCopilot([], {
    model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
    clientFactory: () => client,
  })).rejects.toThrow(/Startup failed[\s\S]*Graceful stop failed[\s\S]*Forced stop failed/);
});

test("preserves generation errors when session disconnection also fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const disconnect = vi.fn().mockRejectedValue(new Error("Session disconnect failed"));
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({
      sendAndWait: vi.fn().mockRejectedValue(new Error("Generation service unavailable")),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect,
    }),
  };
  await expect(enrichWithCopilot(
    [changelogPost("Copilot workflow update", "The workflow now provides clearer guidance.")],
    {
      model: "auto", useAi: true, slidesLanguage: "en",
      speakerNotesLanguages: ["en"], clientFactory: () => client,
    },
  )).rejects.toThrow(/Generation service unavailable[\s\S]*Session disconnect failed/);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(client.stop).toHaveBeenCalledTimes(1);
});

test("drains in-flight workers before propagating an enrichment failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: false };
  }));
  const posts: ChangelogPost[] = Array.from({ length: 3 }, (_, index) => ({
    title: `Copilot update ${index + 1}`,
    url: `https://github.blog/changelog/update-${index + 1}`,
    publishedAt: "2026-08-31T10:00:00.000Z",
    plainText: `Update ${index + 1} improves workflows for developers.`,
    html: "<p>Update details.</p>",
    imageUrls: [],
    links: [],
  }));
  const completed: string[] = [];

  await expect(
    enrichWithCopilot(posts, {
      model: "auto",
      useAi: false,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
      concurrency: 2,
      onPostEnriched: async (post) => {
        completed.push(post.url);
        if (post.url.endsWith("update-1")) throw new Error("Checkpoint failed");
      },
    }),
  ).rejects.toThrow("Checkpoint failed");

  expect(completed).toEqual(expect.arrayContaining([
    "https://github.blog/changelog/update-1",
    "https://github.blog/changelog/update-2",
  ]));
});

test("treats an empty reviewer response as a response failure, not rejected slide content", async () => {
  let failure: unknown;
  try {
    await generateSlideReadyContent(async () => "{}", "Task", ["en"], "Article",
      "IDE", undefined, undefined, async () => undefined);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(SlideReviewFailedError);
  expect(String(failure)).toContain("empty response");
});

test.each(["copilot_response_received", "slide_validation_completed"])(
  "does not send another prompt when %s trace logging fails", async (failedEvent) => {
    const send = vi.fn().mockResolvedValue(JSON.stringify(explanatoryContent("IDE")));
    await expect(generateSlideReadyContent(send, "Task", ["en"], "Article", "IDE", async ({ event }) => {
      if (event === failedEvent) throw new Error("Trace write failed");
    })).rejects.toThrow("Trace write failed");
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test.each(["runtime startup", "model discovery", "session creation", "reviewer session creation"])(
  "bounds %s and still stops the runtime", async (operation) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const never = () => new Promise<never>(() => {});
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "{}" } }),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    let created = 0;
    const client: EnrichmentCopilotClient = {
      start: operation === "runtime startup" ? never : vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      listModels: operation === "model discovery" ? never : vi.fn().mockResolvedValue([]),
      createSession: async () => {
        created++;
        if (operation === "session creation" ||
            (operation === "reviewer session creation" && created === 2)) return never();
        return session;
      },
    };
    const assertion = expect(enrichWithCopilot([changelogPost("Article", "Source.")], {
      model: operation === "model discovery" ? "specific-model" : "auto",
      useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
      requestTimeoutMs: 25, clientFactory: () => client,
    })).rejects.toThrow(`Copilot ${operation} timed out after 25ms`);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(client.stop).toHaveBeenCalledTimes(1);
  },
);

test("attempts both session cleanups and preserves validation and cleanup failures", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const primaryDisconnect = vi.fn().mockRejectedValue(new Error("Primary cleanup failed"));
  const reviewerDisconnect = vi.fn().mockRejectedValue(new Error("Reviewer cleanup failed"));
  let created = 0;
  const client: EnrichmentCopilotClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: async () => ({
      sendAndWait: vi.fn().mockResolvedValue({ data: { content: "{}" } }),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: created++ === 0 ? primaryDisconnect : reviewerDisconnect,
    }),
  };
  await expect(enrichWithCopilot([changelogPost("Article", "Source.")], {
    model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
    clientFactory: () => client,
  })).rejects.toThrow(/unsupported section[\s\S]*Reviewer cleanup failed[\s\S]*Primary cleanup failed/);
  expect(primaryDisconnect).toHaveBeenCalledTimes(1);
  expect(reviewerDisconnect).toHaveBeenCalledTimes(1);
});

test.each(["article_review_skipped", "article_processing_failed"])(
  "drains peers when logging %s fails and does not start queued articles", async (failedEvent) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const activity: string[] = [];
    let releasePeer!: () => void;
    const peerReady = new Promise<void>((resolve) => { releasePeer = resolve; });
    let created = 0;
    const client: EnrichmentCopilotClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(async () => { activity.push("stopped"); }),
      createSession: async () => {
        const index = created++;
        return {
          sendAndWait: async () => {
            if (index === 1) {
              await peerReady;
              return { data: { content: JSON.stringify(explanatoryContent("IDE")) } };
            }
            if (failedEvent === "article_processing_failed") throw new Error("Request failed");
            return { data: { content: "{}" } };
          },
          abort: async () => {}, disconnect: async () => {},
        };
      },
    };
    const run = enrichWithCopilot([
      changelogPost("First VS Code feature", "VS Code adds tools."),
      changelogPost("Second VS Code feature", "VS Code adds tools."),
      changelogPost("Queued VS Code feature", "VS Code adds tools."),
    ], {
      model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"],
      concurrency: 2, clientFactory: () => client,
      onPostEnriched: async () => { activity.push("checkpointed"); },
      trace: async ({ event }) => {
        if (event === failedEvent) {
          activity.push("trace failed");
          throw new Error("Trace disk full");
        }
      },
    });
    const assertion = expect(run).rejects.toThrow("Trace disk full");
    await vi.waitFor(() => expect(activity).toContain("trace failed"));
    expect(activity).not.toContain("stopped");
    releasePeer();
    await assertion;
    expect(activity.indexOf("checkpointed")).toBeLessThan(activity.indexOf("stopped"));
    expect(created).toBe(failedEvent === "article_review_skipped" ? 3 : 2);
  },
);
