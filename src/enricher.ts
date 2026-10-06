import type { CopilotClient } from "@github/copilot-sdk";
import { load } from "cheerio";
import {
  sections,
  sectionDetailKeys,
  explanatoryDetailKeys,
  type ChangelogPost,
  type EnrichedPost,
  type Section,
  type SlideDetailKey,
  type SupportedLanguage,
} from "./types.js";
export { sectionDetailKeys } from "./types.js";
import {
  NEWS_ARTICLE_CACHE_MAX_AGE_MS,
  readThroughNewsCache,
} from "./news-cache.js";

export interface GeneratedContent {
  section: Section;
  summary: string;
  notes: string[];
  details: Partial<Record<SlideDetailKey, string>>;
  speakerNotes: Partial<Record<SupportedLanguage, string>>;
}

export interface EnrichmentTraceEvent {
  event:
    | "article_processing_started"
    | "article_processing_completed"
    | "article_processing_failed"
    | "article_review_skipped"
    | "copilot_attempt_started"
    | "copilot_response_received"
    | "copilot_request_failed"
    | "slide_validation_completed"
    | "image_download_failed";
  articleTitle: string;
  attempt?: number;
  progress?: number;
  prompt?: string;
  response?: string | null;
  issues?: string[];
  error?: string;
  agent?: "enricher" | "reviewer";
}

export interface EnrichmentCopilotSession {
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<
    { data: { content?: string } } | undefined
  >;
  abort(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface EnrichmentCopilotClient {
  start(): Promise<unknown>;
  stop(): Promise<Error[] | void>;
  forceStop?(): Promise<void>;
  listModels?(): ReturnType<CopilotClient["listModels"]>;
  createSession(
    config: Parameters<CopilotClient["createSession"]>[0],
  ): Promise<EnrichmentCopilotSession>;
}

function combineCleanupError(primary: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [primary, cleanupError],
    `${primary instanceof Error ? primary.message : String(primary)}\nCopilot cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    { cause: primary },
  );
}

class CopilotRequestTimeoutError extends Error {
  constructor(timeoutMs: number, operation = "request") {
    super(`Copilot ${operation} timed out after ${timeoutMs}ms.`);
  }
}

export class SlideReviewFailedError extends Error {}

function isCopilotTimeout(error: unknown): boolean {
  return error instanceof CopilotRequestTimeoutError ||
    (error instanceof Error && /^Timeout after \d+ms waiting for session\.idle$/.test(error.message));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveModelId(
  client: EnrichmentCopilotClient,
  requestedModel: string,
): Promise<string> {
  if (requestedModel.toLowerCase() === "auto") return requestedModel;
  if (!client.listModels) {
    throw new Error("The Copilot client cannot list models to resolve the requested model.");
  }

  const models = await client.listModels();
  const normalizedRequest = requestedModel.trim().toLowerCase();
  const match = models.find(
    (model) =>
      model.id.toLowerCase() === normalizedRequest ||
      model.name.trim().toLowerCase() === normalizedRequest,
  );
  if (match) return match.id;

  const availableModels = models
    .map((model) => `${model.name} (${model.id})`)
    .sort((left, right) => left.localeCompare(right));
  throw new Error(
    `Copilot model "${requestedModel}" is not available. Available models: ${
      availableModels.length > 0 ? availableModels.join(", ") : "none"
    }.`,
  );
}

const titleDetailKeys = new Set<SlideDetailKey>([
  "modelName",
  "subject",
  "feature",
  "announcement",
]);

const benefitOrientedActionPattern =
  /^(?:(?:access|add|allow|accelerate|apply|automate|boost|bring|build|catch|choose|clarify|connect|control|coordinate|create|customize|cut|debug|deliver|detect|discover|edit|enable|enforce|enhance|expand|find|generate|govern|help|improve|introduce|let|maintain|manage|modernize|monitor|navigate|optimize|organize|pin|prepare|protect|provide|publish|reduce|review|run|select|share|simplify|speed|standardize|streamline|strengthen|support|surface|track|tune|unlock|update|use|validate)(?:s|es)?|(?:accedi|accelera|aggiorna|aggiunge|abilita|applica|automatizza|chiarisce|collega|condividi|consente|controlla|coordina|crea|fornisce|genera|gestisce|governa|individua|migliora|modernizza|monitora|naviga|organizza|ottimizza|permette|potenzia|prepara|pubblica|regola|riduce|rende|semplifica|standardizza|supporta|valida|velocizza))\b/i;

function beginsWithBenefitOrientedAction(value: string): boolean {
  return benefitOrientedActionPattern.test(value.trim());
}

function hasUseAndAvoidGuidance(value: string): boolean {
  const describesUse =
    /(?:\buse\b[^;!?]{0,100}\bfor\b|\bbest\s+(?:used|suited)\s+for\b|\bideal\s+for\b|\b(?:usa|usare|usalo)\b[^;!?]{0,100}\bper\b|\bideale\s+per\b|\bconsigliat[oa]\s+per\b)/i.test(
      value,
    );
  const describesAvoidance =
    /(?:\bavoid(?:\s+it)?(?:\s+for)?\b|\bnot\s+(?:recommended|suited)\s+for\b|\bskip\b|\bdo\s+not\s+use\b|\bevita(?:lo)?\b|\bnon\s+(?:è\s+)?consigliat[oa]\s+per\b|\bnon\s+usarlo\b)/i.test(
      value,
    );
  return describesUse && describesAvoidance;
}

function shortenText(
  text: string,
  maximumWords: number,
  maximumCharacters: number,
  completeSentence = true,
): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return normalized;

  const words = normalized.split(" ");
  let shortened = words.slice(0, maximumWords).join(" ");
  const contentLimit = completeSentence ? maximumCharacters - 1 : maximumCharacters;
  while (shortened.length > contentLimit && shortened.includes(" ")) {
    shortened = shortened.slice(0, shortened.lastIndexOf(" "));
  }
  if (shortened === normalized) return shortened;

  const firstClause = shortened.search(/[,;:]/);
  if (completeSentence && firstClause >= 55) {
    shortened = shortened.slice(0, firstClause);
  }
  shortened = shortened.replace(/[,:;.-]+$/, "");
  while (/\b(and|or|with|while|including|for|to|of|in|on|the|a|an)$/i.test(shortened)) {
    shortened = shortened.slice(0, shortened.lastIndexOf(" ")).replace(/[,:;.-]+$/, "");
  }
  return completeSentence ? `${shortened}.` : shortened;
}

function simplifyDeterministicContent(content: GeneratedContent): GeneratedContent {
  return {
    ...content,
    summary: shortenText(content.summary, 24, 160),
    notes: content.notes.slice(0, 4).map((note) => shortenText(note, 12, 90)),
    details: Object.fromEntries(
      sectionDetailKeys[content.section].map((key) => [
        key,
        shortenText(
          content.details[key] ?? "",
          titleDetailKeys.has(key) ? 14 : 18,
          titleDetailKeys.has(key) ? 100 : 120,
          !titleDetailKeys.has(key),
        ),
      ]),
    ),
  };
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function endsWithDanglingWord(value: string): boolean {
  return /\b(and|or|with|while|including|for|to|of|in|on|the|a|an)[.!?]?$/i.test(value.trim());
}

function substantiallyRepeatsTitle(value: string, articleTitle: string): boolean {
  const ignored = new Set([
    "and", "copilot", "github", "in", "of", "the", "to", "update", "updates", "upcoming",
  ]);
  const tokens = value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => !ignored.has(token)) ?? [];
  if (tokens.length < 3) return false;
  const titleTokens = new Set(
    articleTitle.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
  );
  return tokens.filter((token) => titleTokens.has(token)).length / tokens.length >= 0.85;
}

function normalizedContentTokens(value: string): string[] {
  const ignored = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "copilot", "for", "from",
    "github", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  ]);
  return value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length > 2 && !ignored.has(token)) ?? [];
}

function substantiallyRepeats(value: string, comparison: string): boolean {
  const tokens = normalizedContentTokens(value);
  if (tokens.length < 5) return false;
  const comparisonTokens = new Set(normalizedContentTokens(comparison));
  return tokens.filter((token) => comparisonTokens.has(token)).length / tokens.length >= 0.8;
}

const retirementPattern =
  /\b(retire(?:d|s|ments?)?|retiring|deprecat(?:e[ds]?|ing|ions?)|sunset(?:s|ting)?|no longer (?:available|supported)|removal of (?:support|access)|removed from (?:github )?copilot)\b/i;
const idePattern = /\b(vs code|visual studio|jetbrains|xcode|eclipse|ide)\b/i;
const namedModelPattern =
  /\b(?:gpt[-\s]?\d(?:\.\d+)?(?:[-\s][a-z0-9]+)*|o[134](?:[-\s][a-z0-9]+)*|claude(?:\s+\d(?:\.\d+)?)?(?:\s+(?:opus|sonnet|haiku))?(?:\s+\d(?:\.\d+)?)?|gemini(?:\s+\d(?:\.\d+)?)?(?:\s+(?:pro|flash))?|grok(?:\s+\d(?:\.\d+)?)?|llama(?:\s+\d(?:\.\d+)?)?(?:\s+[a-z0-9]+)?|deepseek(?:[-\s][a-z0-9.]+)?|mistral(?:\s+[a-z0-9.]+)?|codex(?:[-\s][a-z0-9.]+)?)\b/i;
const modelAvailabilityPattern =
  /\b(?:now|newly)?\s*available\b|\bgeneral(?:ly)? available\b|\bpublic preview\b|\brolling out\b|\blaunch(?:ed|es|ing)?\b|\bintroduc(?:e|es|ed|ing)\b|\bcomes? to (?:github )?copilot\b/i;
const nonLaunchModelTopicPattern =
  /\bmodel (?:comparison|controls?|management|picker|polic(?:y|ies)|pricing|selection|settings?)\b|\b(?:billing|multipliers?|premium requests?)\b/i;
const enterpriseAdminPattern =
  /\b(?:(?:github\s+)?enterprise(?:\s+(?:account|cloud|server))?|ghe(?:c|s)?)\s+(?:owners?|admins?|administrators?)\b|\b(?:owners?|admins?|administrators?)\s+of\s+(?:a\s+)?(?:(?:github\s+)?enterprise(?:\s+(?:account|cloud|server))?|ghe(?:c|s)?)\b|\badminister(?:s|ed|ing)?\s+github copilot (?:business|enterprise)(?:\s+or\s+github copilot (?:business|enterprise))?\b/i;
const enterpriseAdministrationPattern =
  /\b(?:settings?|permissions?|restrictions?|polic(?:y|ies)|administration|administer|configuration|configure|configured|controls?|enforce|govern|manage|managed|management)\b/i;
const enterprisePortalPattern =
  /\b(?:github(?:\.com)?|github enterprise(?: cloud| server)?|ghe(?:c|s)?)(?:\s+(?:web\s+)?(?:portal|settings?|admin(?:istration)?|management|console|interface|ui|website))\b|\b(?:portal|settings?|admin(?:istration)?|management|console|interface|ui|website)\s+(?:in|on|for|through|via)\s+(?:github(?:\.com)?|github enterprise(?: cloud| server)?|ghe(?:c|s)?)\b|\benterprise(?:\s+account)?\s+(?:settings?|polic(?:y|ies)|administration|management)\s+(?:page|portal|console|interface|ui)\b|\bmanagement console\b/i;
const enterpriseManagedSettingsPattern =
  /\benterprise managed (?:permissions?|settings?|polic(?:y|ies)|controls?|restrictions?)\b/i;

export function isNewModelAvailabilityPost(post: ChangelogPost): boolean {
  const title = post.title.trim();
  const leadingSentences = post.plainText
    .split(/(?<=[.!?])\s+/)
    .slice(0, 3)
    .join(" ");
  const evidence = `${title}. ${leadingSentences}`;
  if (retirementPattern.test(evidence)) return false;
  if (nonLaunchModelTopicPattern.test(title)) return false;

  return (
    (namedModelPattern.test(title) || /\bnew (?:ai )?models?\b/i.test(title)) &&
    modelAvailabilityPattern.test(evidence)
  );
}

export function classifySection(post: ChangelogPost): Section {
  const evidence = `${post.title} ${post.plainText
    .split(/(?<=[.!?])\s+/)
    .slice(0, 3)
    .join(" ")}`;
  if (retirementPattern.test(evidence)) return "Retirements";
  if (
    enterpriseAdminPattern.test(evidence) &&
    enterpriseAdministrationPattern.test(evidence) &&
    (enterprisePortalPattern.test(evidence) || enterpriseManagedSettingsPattern.test(evidence))
  ) {
    return "Enterprise Admins";
  }
  if (isNewModelAvailabilityPost(post)) return "Models";
  if (idePattern.test(evidence)) return "IDE";
  return "Announcements";
}

export function slideContentIssues(
  content: GeneratedContent,
  articleTitle?: string,
  expectedSection?: Section,
  speakerNotesLanguages: SupportedLanguage[] = [],
): string[] {
  const issues: string[] = [];
  if (expectedSection && content.section !== expectedSection) {
    issues.push(`section must be ${expectedSection}`);
  }
  if (wordCount(content.summary) > 32 || content.summary.length > 220) {
    issues.push("summary must be at most 32 words and 220 characters");
  }
  if (
    /[\r\n]/.test(content.summary) ||
    /\.{3}|…/.test(content.summary) ||
    !/[.!?]$/.test(content.summary.trim()) ||
    endsWithDanglingWord(content.summary)
  ) {
    issues.push("summary must be one complete sentence without line breaks or ellipses");
  }
  if (/^(?:this|the) (?:announcement|change|release|update)\b/i.test(content.summary.trim())) {
    issues.push("summary must lead with the product or capability, not a generic update reference");
  }
  if (
    articleTitle &&
    content.summary.toLocaleLowerCase().includes(articleTitle.trim().toLocaleLowerCase())
  ) {
    issues.push("summary must not repeat the full article title");
  }
  if (content.notes.length < 2 || content.notes.length > 4) {
    issues.push("notes must contain 2-4 bullets");
  }
  content.notes.forEach((note, index) => {
    if (wordCount(note) > 16 || note.length > 110) {
      issues.push(`note ${index + 1} must be at most 16 words and 110 characters`);
    }
    if (/[\r\n]|\.{3}|…/.test(note) || endsWithDanglingWord(note)) {
      issues.push(`note ${index + 1} must be a complete standalone phrase without ellipses`);
    }
  });
  for (const key of sectionDetailKeys[content.section]) {
    const value = content.details[key] ?? "";
    const expanded =
      (content.section === "Announcements" || content.section === "Enterprise Admins") &&
      (key === "announcement" || key === "impact");
    const explanatory = explanatoryDetailKeys.has(key);
    const maximumWords = expanded ? 44 : explanatory ? 36 : titleDetailKeys.has(key) ? 18 : 26;
    const maximumCharacters = expanded ? 300 : explanatory ? 250 : titleDetailKeys.has(key) ? 130 : 170;
    if (wordCount(value) > maximumWords || value.length > maximumCharacters) {
      issues.push(`${key} must be at most ${maximumWords} words and ${maximumCharacters} characters`);
    }
    if (
      /[\r\n]|\.{3}|…/.test(value) ||
      endsWithDanglingWord(value) ||
      /(?:see|read|check)\s+(?:the\s+)?(?:source|article|documentation)/i.test(value)
    ) {
      issues.push(`${key} must be a complete standalone phrase without filler or ellipses`);
    }
    // Commas can separate model names, dates, or qualifiers within one point.
    if (value.split(";").filter((point) => point.trim()).length > 3) {
      issues.push(`${key} must prioritize 2-3 semicolon-separated points instead of an exhaustive list`);
    }
    if (
      key === "availability" &&
      /\b(?:announced|published|posted)\s+(?:on\s+)?(?:\d{1,4}(?:[-/]\d{1,2})?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(value)
    ) {
      issues.push("availability must describe product status, eligibility, plans, or supported surfaces, not the article date");
    }
    if (
      key === "keyCapabilities" &&
      !beginsWithBenefitOrientedAction(value)
    ) {
      issues.push("keyCapabilities must begin with a benefit-oriented action");
    }
    if (key === "announcement" && wordCount(value) < 6) {
      issues.push("announcement must state the specific change, not only name its topic");
    }
    if (key === "impact" && wordCount(value) < 8) {
      issues.push("impact must cover the main consequence and required action");
    }
    if (
      articleTitle &&
      (key === "feature" || key === "announcement") &&
      substantiallyRepeatsTitle(value, articleTitle)
    ) {
      issues.push(`${key} must name the concrete changes instead of repeating the article title`);
    }
    if (!titleDetailKeys.has(key) && substantiallyRepeats(value, content.summary)) {
      issues.push(`${key} must add a distinct fact instead of repeating the summary`);
    }
    if (
      key === "useGuidance" &&
      !hasUseAndAvoidGuidance(value)
    ) {
      issues.push("useGuidance must explicitly state both when to use and when to avoid the model");
    }
  }
  for (const language of speakerNotesLanguages) {
    const notes = content.speakerNotes[language] ?? "";
    const count = wordCount(notes);
    if (count < 80 || count > 140) {
      issues.push(`speakerNotes.${language} must contain 80-140 words`);
    }
  }
  return issues;
}

function isSection(value: unknown): value is Section {
  return typeof value === "string" && (sections as readonly string[]).includes(value);
}

function parseGeneratedContent(
  content: string,
  speakerNotesLanguages: SupportedLanguage[],
): GeneratedContent {
  const candidate = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  if (!isSection(parsed.section)) {
    throw new Error(`Copilot returned an unsupported section: ${String(parsed.section)}`);
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("Copilot returned an empty summary.");
  }
  if (
    !Array.isArray(parsed.notes) ||
    parsed.notes.length === 0 ||
    !parsed.notes.every((note) => typeof note === "string" && note.trim())
  ) {
    throw new Error("Copilot returned invalid notes.");
  }
  const details = parsed.details as Record<string, unknown> | undefined;
  const requiredKeys = sectionDetailKeys[parsed.section];
  if (!details || requiredKeys.some((key) => typeof details[key] !== "string" || !String(details[key]).trim())) {
    throw new Error(`Copilot returned invalid ${parsed.section} details.`);
  }
  const speakerNotes = parsed.speakerNotes as Record<string, unknown> | undefined;
  if (!speakerNotes || speakerNotesLanguages.some(
    (language) => typeof speakerNotes[language] !== "string" || !String(speakerNotes[language]).trim(),
  )) {
    throw new Error("Copilot returned invalid speaker notes.");
  }
  return {
    section: parsed.section,
    summary: parsed.summary.trim(),
    notes: parsed.notes.map((note) => note.trim()),
    details: Object.fromEntries(
      requiredKeys.map((key) => [key, String(details[key]).trim()]),
    ),
    speakerNotes: Object.fromEntries(
      speakerNotesLanguages.map((language) => [language, String(speakerNotes[language]).trim()]),
    ),
  };
}

export async function generateSlideReadyContent(
  sendPrompt: (prompt: string) => Promise<string | undefined>,
  initialPrompt: string,
  speakerNotesLanguages: SupportedLanguage[],
  articleTitle: string,
  expectedSection?: Section,
  trace?: (event: EnrichmentTraceEvent) => Promise<void>,
  shouldRetry?: () => boolean,
  sendReviewerPrompt?: (prompt: string) => Promise<string | undefined>,
): Promise<GeneratedContent> {
  let prompt = initialPrompt;
  let lastProblem = "Copilot returned no content.";
  let problemKind: "empty" | "request" | "validation" = "empty";
  let lastContent: string | undefined;
  const maximumAttempts = 4;
  let attempts = 0;
  let requestTimedOut = false;
  const validate = async (
    content: string, attempt: number, agent?: "reviewer",
  ): Promise<GeneratedContent | undefined> => {
    let candidate: GeneratedContent | undefined;
    let issues: string[];
    try {
      candidate = parseGeneratedContent(content, speakerNotesLanguages);
      issues = slideContentIssues(candidate, articleTitle, expectedSection, speakerNotesLanguages);
    } catch (error) {
      issues = [error instanceof Error ? error.message : String(error)];
    }
    await trace?.({ event: "slide_validation_completed", articleTitle, attempt, issues, ...(agent ? { agent } : {}) });
    if (!issues.length) return candidate;
    lastProblem = issues.join("; ");
    return undefined;
  };
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (attempt > 1 && shouldRetry?.() === false) break;
    attempts = attempt;
    let content: string | undefined;
    await trace?.({
      event: "copilot_attempt_started",
      articleTitle,
      attempt,
      prompt,
    });
    try {
      content = await sendPrompt(prompt);
      lastContent = content;
    } catch (error) {
      problemKind = "request";
      requestTimedOut = isCopilotTimeout(error);
      lastProblem = `Copilot request failed: ${error instanceof Error ? error.message : String(error)}`;
      await trace?.({
        event: "copilot_request_failed",
        articleTitle,
        attempt,
        error: lastProblem,
      });
      if (requestTimedOut) break;
      continue;
    }
    await trace?.({
      event: "copilot_response_received",
      articleTitle,
      attempt,
      response: content ?? null,
    });
    if (!content) {
      problemKind = "empty";
      lastProblem = "Copilot returned no content.";
    } else {
      problemKind = "validation";
      const candidate = await validate(content, attempt);
      if (candidate) return candidate;
    }
    prompt = [
      "Revise your previous response into complete presentation-ready JSON.",
      `Fix every problem: ${lastProblem}.`,
      "Return the full corrected JSON object only. Preserve factual accuracy and all required keys.",
      "Preserve source-backed exceptions, negations, eligibility conditions, deadlines, and prerequisites when rewriting. Never remove a qualifier merely to fit a length or list limit.",
      "Keep valid, concrete details in unaffected fields. When shortening a field, remove repetition and filler before source-backed mechanisms, practical effects or required actions; do not replace an explanation with a generic slogan. Keep the original detail targets where the source supports them, without adding facts.",
    ].join("\n\n");
  }
  if (
    sendReviewerPrompt &&
    !requestTimedOut &&
    lastContent &&
    problemKind === "validation" &&
    shouldRetry?.() !== false
  ) {
    const attempt = attempts + 1;
    const reviewerPrompt = [
      "Review and repair a rejected presentation-content response.",
      "Use the original source-grounded instructions and article below as the sole factual basis.",
      `Validator problems to fix: ${lastProblem}.`,
      `Rejected response: ${lastContent}`,
      `Original task: ${initialPrompt}`,
      "Return one complete corrected JSON object only. Preserve every source-backed exception, negation, eligibility condition, deadline, and prerequisite. Do not add facts.",
    ].join("\n\n");
    await trace?.({
      event: "copilot_attempt_started",
      articleTitle,
      attempt,
      prompt: reviewerPrompt,
      agent: "reviewer",
    });
    let reviewedContent: string | undefined;
    try {
      reviewedContent = await sendReviewerPrompt(reviewerPrompt);
      problemKind = reviewedContent ? "validation" : "empty";
    } catch (error) {
      problemKind = "request";
      requestTimedOut = isCopilotTimeout(error);
      lastProblem = `Copilot reviewer request failed: ${error instanceof Error ? error.message : String(error)}`;
      await trace?.({
        event: "copilot_request_failed",
        articleTitle,
        attempt,
        error: lastProblem,
        agent: "reviewer",
      });
    }
    if (problemKind !== "request") {
      await trace?.({
        event: "copilot_response_received", articleTitle, attempt,
        response: reviewedContent ?? null, agent: "reviewer",
      });
      if (reviewedContent) {
        const candidate = await validate(reviewedContent, attempt, "reviewer");
        if (candidate) return candidate;
      } else {
        lastProblem = "Copilot reviewer returned no content.";
      }
    }
    attempts = attempt;
  }
  const requestFailed = problemKind === "request";
  const noContent = problemKind === "empty";
  const explanation = requestFailed
    ? "The Copilot service or selected model failed to return a response."
    : noContent
      ? "Copilot returned an empty response."
      : "Copilot returned content, but it did not satisfy the slide formatting rules.";
  const suggestedAction = requestTimedOut
    ? "The timed-out request will not be retried automatically. Resume with --resume and lower --concurrency (try 1); use --request-timeout <seconds> to allow a slower model more time. Verify Copilot authentication and model availability if timeouts persist."
    : requestFailed
    ? "Verify Copilot authentication and model availability, then retry with --concurrency 1 or choose another --model."
    : "Retry the command or choose another --model. The downloaded source articles remain cached, so they will not be downloaded again.";
  const message = [
    `Could not prepare slide-ready content for "${articleTitle}" after ${attempts} attempt${attempts === 1 ? "" : "s"}.`,
    explanation,
    `Last problem: ${lastProblem}`,
    `Suggested action: ${suggestedAction}`,
  ].join("\n");
  if (!requestFailed && !noContent) throw new SlideReviewFailedError(message);
  throw new Error(message);
}

function deterministicContent(
  post: ChangelogPost,
  speakerNotesLanguages: SupportedLanguage[],
): GeneratedContent {
  const section = classifySection(post);
  const sentences = post.plainText.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences[0] || post.title;
  const generic = sentences[1] || summary;
  const published = new Date(post.publishedAt).toLocaleDateString("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  });
  const detailsBySection: Record<Section, Partial<Record<SlideDetailKey, string>>> = {
    Models: {
      modelName: post.title,
      availability: generic,
      keyCapabilities: summary,
      useGuidance: "Use for supported Copilot workloads; avoid where the announced limitations apply.",
    },
    "Enterprise Admins": {
      announcement: post.title,
      availability: generic,
      impact: summary,
      audience: "GitHub Enterprise owners and administrators affected by this change.",
    },
    Announcements: {
      announcement: post.title,
      availability: generic,
      impact: summary,
      audience: "GitHub Copilot users and administrators affected by this change.",
    },
    IDE: {
      feature: post.title,
      availability: generic,
      keyCapabilities: summary,
      howToUse: "Update the supported IDE, then enable or open the announced Copilot feature.",
    },
    Retirements: {
      subject: post.title,
      retirementDate: `Source announcement published ${published}; confirm the stated retirement milestone.`,
      reasons: summary,
      replacement: generic || "Not stated.",
    },
  };
  const speakerNotes = Object.fromEntries(
    speakerNotesLanguages.map((language) => [
      language,
      language === "it"
        ? `Presentare "${post.title}". Spiegare i dettagli principali della modifica e invitare il pubblico a consultare la fonte per disponibilità, scadenze e azioni richieste.`
        : `Introduce "${post.title}". Explain the main details of the change and direct the audience to the source for availability, deadlines, and required actions.`,
    ]),
  );
  return {
    section,
    summary,
    notes: sentences.slice(2, 6).map((sentence) => sentence.slice(0, 220)),
    details: detailsBySection[section],
    speakerNotes,
  };
}

async function fetchImageDataUri(url: string): Promise<string | undefined> {
  const response = await fetch(url, {
    headers: { "User-Agent": "copilot-changelog-cli/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return undefined;
  const contentType = response.headers.get("content-type")?.split(";")[0];
  const supportedTypes = new Set(["image/png", "image/jpeg", "image/gif"]);
  if (!contentType || !supportedTypes.has(contentType)) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) return undefined;
  const validSignature =
    (contentType === "image/png" &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (contentType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (contentType === "image/gif" &&
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a"));
  if (!validSignature) return undefined;
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

class ArticlePageUnavailableError extends Error {}

async function findArticleImage(post: ChangelogPost): Promise<string | undefined> {
  for (const url of post.imageUrls.slice(0, 3)) {
    const image = await fetchImageDataUri(url);
    if (image) return image;
  }

  let articleHtml: string;
  try {
    articleHtml = await readThroughNewsCache(
      post.url,
      NEWS_ARTICLE_CACHE_MAX_AGE_MS,
      async () => {
        const response = await fetch(post.url, {
          headers: { "User-Agent": "copilot-changelog-cli/1.0" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new ArticlePageUnavailableError();
        return response.text();
      },
    );
  } catch (error) {
    if (error instanceof ArticlePageUnavailableError) return undefined;
    throw error;
  }
  const $ = load(articleHtml);
  const socialImage = $('meta[property="og:image"]').attr("content");
  return socialImage ? fetchImageDataUri(new URL(socialImage, post.url).href) : undefined;
}

export async function enrichWithCopilot(
  posts: ChangelogPost[],
  options: {
    model: string;
    useAi: boolean;
    slidesLanguage: SupportedLanguage;
    speakerNotesLanguages: SupportedLanguage[];
    concurrency?: number;
    requestTimeoutMs?: number;
    progressOffset?: number;
    progressTotal?: number;
    progressForPost?: (post: ChangelogPost) => number;
    onPostEnriched?: (post: EnrichedPost) => Promise<void>;
    trace?: (event: EnrichmentTraceEvent) => Promise<void>;
    traceLogPath?: string;
    clientFactory?: () => EnrichmentCopilotClient;
  },
): Promise<EnrichedPost[]> {
  let client: EnrichmentCopilotClient | undefined;
  let modelId = options.model;
  const workerCount = Math.min(options.concurrency ?? 1, Math.max(posts.length, 1));
  const requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
    throw new Error("Copilot request timeout must be a positive whole number of milliseconds no greater than 2147483647.");
  }
  let failure: { error: unknown } | undefined;

  try {
    if (options.useAi) {
      process.stderr.write("Starting Copilot runtime...\n");
      const startedAt = Date.now();
      if (options.clientFactory) {
        client = options.clientFactory();
      } else {
        const { CopilotClient } = await import("@github/copilot-sdk");
        client = new CopilotClient();
      }
      await withTimeout(client.start(), requestTimeoutMs,
        new CopilotRequestTimeoutError(requestTimeoutMs, "runtime startup"));
      modelId = await withTimeout(resolveModelId(client, options.model), requestTimeoutMs,
        new CopilotRequestTimeoutError(requestTimeoutMs, "model discovery"));
      process.stderr.write(`Copilot runtime ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; response timeout ${requestTimeoutMs / 1000}s.\n`);
    }
    const enriched = new Array<EnrichedPost>(posts.length);
    let nextIndex = 0;
    let firstFailure: unknown;
    const workerFailures: unknown[] = [];
    let stopStarting = false;
    let activeEnrichments = 0;
    let completedEnrichments = 0;
    process.stderr.write(
      `${workerCount === 1 ? "Sequential" : "Parallel"} enrichment: ${workerCount} ${options.useAi ? "Copilot session" : "worker"}${
        workerCount === 1 ? "" : "s"
      } for ${posts.length} article${posts.length === 1 ? "" : "s"}.\n`,
    );
    const enrichPost = async (index: number): Promise<void> => {
      const post = posts[index];
      const requiredSection = classifySection(post);
      const progress =
        options.progressForPost?.(post) ??
        (options.progressOffset ?? 0) + index + 1;
      let completionNumber = 0;
      activeEnrichments += 1;
      process.stderr.write(
        `Starting ${progress}/${options.progressTotal ?? posts.length} · active ${activeEnrichments}/${workerCount}: ${post.title}\n`,
      );
      await options.trace?.({
        event: "article_processing_started",
        articleTitle: post.title,
        progress,
      });
      const imagePromise = findArticleImage(post).catch(async (error: unknown) => {
        process.stderr.write(
          `Warning: image download failed for "${post.title}": ${error instanceof Error ? error.message : String(error)}\n`,
        );
        await options.trace?.({
          event: "image_download_failed",
          articleTitle: post.title,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }).then(
        (image) => ({ image }),
        (error: unknown) => ({ error }),
      );
      let postFailure: { error: unknown } | undefined;
      try {
        let generated: GeneratedContent;
        if (client) {
          const activeClient = client;
          let session: EnrichmentCopilotSession | undefined;
          let reviewerSession: EnrichmentCopilotSession | undefined;
          let sessionFailure: { error: unknown } | undefined;
          try {
            session = await withTimeout(client.createSession({
            model: modelId,
            availableTools: [],
            systemMessage: {
              content:
                "You are a presentation strategist and executive slide editor. Transform source material into accurate, informative slide explanations, not terse labels or marketing slogans. Return only strict JSON, never Markdown.",
            },
          }), requestTimeoutMs, new CopilotRequestTimeoutError(requestTimeoutMs, "session creation"));
          const activeSession = session;
          const detailsShape = Object.fromEntries(
            sectionDetailKeys[requiredSection].map((key) => [key, "value"]),
          );
          const speakerNotesShape = Object.fromEntries(
            options.speakerNotesLanguages.map((language) => [language, "presenter script"]),
          );
          const initialPrompt = [
          "Create presentation-ready content for one GitHub Copilot changelog update.",
          `Write summary, notes, and detail values in ${options.slidesLanguage === "it" ? "Italian" : "English"}.`,
          `Return strict JSON with section, summary, notes, details, and speakerNotes. Example shape: ${JSON.stringify({
            section: requiredSection,
            summary: "One short plain-language sentence",
            notes: ["2-4 short practical bullets"],
            details: detailsShape,
            speakerNotes: speakerNotesShape,
          })}`,
          "Write for a live presentation, not an article summary. Every field must be usable on the slide without editing.",
          "Prioritize the actual news and its main points. Do not optimize for the shortest possible wording.",
          `Required section: ${requiredSection}. Do not choose a different section.`,
          "Use takeaway-first explanations: state the concrete change, how it works, why it matters, and the audience action.",
          "Before composing the JSON, identify the source-backed change, mechanism, practical effect, supported workflow, and essential constraints; distribute them across the matching cards. Return only the requested JSON, not a separate fact inventory.",
          "In explanatory cards, pair the named capability or change with how it works or what it changes for the user. Add a specific workflow, prerequisite, limitation or migration step when the source provides one. Prefer 2-3 informative clauses, not a list of benefit labels.",
          "Replace vague claims such as 'improves productivity', 'better collaboration', or 'faster review' with the source's concrete mechanism and practical effect. Do not invent speed, quality or cost improvements. Use the available word and character budget for facts, not adjectives.",
          "Before returning, check whether a reader can explain what is different and what to do without opening the article. If a card is generic while relevant source facts remain unused, replace the generic wording with those facts within its limits. Do not pad short sources or invent missing instructions.",
          "Summary: one complete sentence, preferably 18-32 words. It must explain the central news rather than repeat the title.",
          "Lead the summary with the product, model, capability, or affected audience; never start with 'This update' or 'The announcement'.",
          "Notes: 2-4 standalone bullets, preferably 8-16 words each.",
          "Detail values: follow the section-specific targets below. Name/subject/feature values stay compact (at most 18 words and 130 characters); availability, retirementDate and audience stay concise (at most 26 words and 170 characters).",
          "For Models keyCapabilities and useGuidance, IDE keyCapabilities and howToUse, and Retirements reasons and replacement, aim for 28-34 words per card, at most 36 words and 250 characters. Include 2-3 distinct source-backed points with practical context, not longer paraphrases of the summary.",
          "Never invent details to fill space; use shorter text when the source has fewer facts. Keep essential qualifiers, prerequisites, exceptions and migration conditions on the slide.",
          "Use plain language, active voice, parallel phrasing, and concrete product names, dates, plans, or actions only when supported.",
          "Do not write paragraphs, ellipses, headings inside values, generic filler, exhaustive lists, navigation walkthroughs, or 'see the source'.",
          "Prefer exact product names, rollout states, dates, plan names, policy changes, user impact, and required actions found in the article.",
          "Each card must communicate a different source-backed point. Do not repeat the summary or another card.",
          "For roundup articles, use feature or announcement to name the 2-3 headline changes instead of repeating the article title.",
          "For capabilities, impact, reasons, and replacement, prefer 2-3 compact clauses separated by semicolons.",
          "Use semicolons between distinct points; commas may separate names, dates, or qualifiers within a point. Keep all required replacement options and migration conditions within the word and character limits.",
          "Move additional background, nonessential version lists, and supporting explanation into speakerNotes; keep prerequisites and caveats needed to act correctly on the slide.",
          "Use exactly these detail keys by section:",
          `Models: ${sectionDetailKeys.Models.join(", ")}. This section is exclusively for a newly available model. Use the exact model name; availability status, plans, and supported surfaces. In keyCapabilities explain 2-3 differentiating strengths and their practical benefits. In useGuidance use the form "Use for ...; avoid for ...", adding concrete workloads and source-stated limitations or trade-offs. Do not infer benchmarks or unsupported disadvantages. Model settings, policies, pricing, comparisons, or editor features are not Models.`,
          `Enterprise Admins: ${sectionDetailKeys["Enterprise Admins"].join(", ")}. This section is exclusively for settings and administration performed by GitHub Enterprise owners or administrators in the GitHub.com or GitHub Enterprise web portal, settings UI, or management console. In announcement explain the portal-based administrative change and its scope; in impact explain governance consequences and required action. Put rollout and eligibility in availability, and name the exact enterprise role in audience. Exclude member features, generic Enterprise announcements, and administration performed only through APIs, CLIs, or other non-portal tools.`,
          `Announcements: ${sectionDetailKeys.Announcements.join(", ")}. The announcement and impact cards occupy two-thirds of the width. For each, aim for 30-40 words, at most 44 words and 300 characters, in 2-3 source-backed clauses. In announcement explain what changes, its scope and concrete mechanisms or milestones; in impact explain practical consequences, supported costs or benefits, and required action or essential constraints. Do not merely repeat the title or summary. Availability and audience occupy one-third: aim for 8-18 words, at most 26 words and 170 characters, retaining eligibility conditions. Put status, rollout and supported surfaces in availability; affected plans and roles in audience. Never invent details to fill space; use shorter text when the source has fewer facts. Keep essential qualifiers on the slide and move additional explanation to speakerNotes.`,
          `IDE: ${sectionDetailKeys.IDE.join(", ")}. Name the feature; supported editors and rollout status. In keyCapabilities explain 2-3 concrete improvements and their effect on daily development. In howToUse describe a specific first action, essential setup or prerequisite, and the next useful step or expected result, without a navigation walkthrough.`,
          `Retirements: ${sectionDetailKeys.Retirements.join(", ")}. Name the retired item; exact dates and phases. In reasons explain the stated rationale and operational impact. In replacement name the supported alternatives, who each applies to, and the required migration action or verification. Preserve exceptions and deadlines; do not imply migration is automatic unless stated. Use "Not stated" only when absent.`,
          "Availability is product status, eligibility, supported surfaces, or plans. Never substitute the article publication date.",
          options.slidesLanguage === "it"
            ? "Inizia keyCapabilities con verbi d'azione orientati ai benefici, per esempio 'Migliora la revisione, semplifica la navigazione, organizza le sessioni'."
            : "Start keyCapabilities with benefit-oriented action verbs, for example 'Improve review, simplify navigation, organize sessions'.",
          "Make howToUse a concrete first action; do not merely restate that the feature can be used.",
          "Illustrative source, not facts about the actual article: The Agents view is in preview in VS Code. It groups sessions by task, preserves each chat's context when resumed, and shows proposed file edits as diffs. Open Agents, select a session, then review its diff before accepting edits. Follow the specificity of the example below, but never copy its facts unless supported by the actual article.",
          `Illustrative output: ${JSON.stringify(options.slidesLanguage === "it" ? {
            summary: "La vista Agents in anteprima in VS Code raggruppa le sessioni per lavoro e conserva il contesto, mostrando le modifiche come diff prima di accettarle.",
            details: {
              feature: "Sessioni agente raggruppate per lavoro",
              availability: "Anteprima in VS Code",
              keyCapabilities: "Organizza le sessioni per lavoro mantenendo insieme le conversazioni correlate; riprendi ogni chat con il suo contesto salvato; confronta le modifiche proposte nei diff prima di accettarle nei file del progetto.",
              howToUse: "Apri la vista Agents in anteprima in VS Code e seleziona una sessione del lavoro; esamina il diff prima di accettare le modifiche oppure riprendi la chat con il contesto salvato.",
            },
          } : {
            summary: "VS Code's preview Agents view groups sessions by task and preserves chat context, letting developers resume a discussion and inspect proposed edits before accepting them.",
            details: {
              feature: "Agent sessions grouped by task",
              availability: "Preview in VS Code",
              keyCapabilities: "Organize sessions by task to keep related work together; resume each chat with its previously saved context intact; compare proposed edits as diffs before accepting changes to project files.",
              howToUse: "Open the preview Agents view in VS Code and select a session for the task; inspect its proposed diff before accepting edits, or resume the chat with its saved context.",
            },
          })}`,
          `Speaker notes must contain exactly these language keys: ${options.speakerNotesLanguages.join(", ")}. Write each script in its matching language.`,
          "Speaker notes must be natural presenter scripts of 80-140 words, accurate to the source, and must not introduce unsupported claims.",
          "Classification is already determined from the source. Models is reserved only for articles announcing that a specific new model is available or rolling out.",
          `Title: ${post.title}`,
          `Published: ${post.publishedAt}`,
          `Article: ${post.plainText.slice(0, 12_000)}`,
        ].join("\n\n");
            generated = await generateSlideReadyContent(
            async (prompt) => {
              try {
                // The SDK timeout starts only after send() and does not cancel generation.
                const response = await withTimeout(
                  activeSession.sendAndWait({ prompt }, requestTimeoutMs),
                  requestTimeoutMs,
                  new CopilotRequestTimeoutError(requestTimeoutMs),
                );
                return response?.data.content;
              } catch (error) {
                if (isCopilotTimeout(error)) stopStarting = true;
                throw error;
              }
            },
            initialPrompt,
            options.speakerNotesLanguages,
            post.title,
            requiredSection,
            options.trace,
            () => !stopStarting && firstFailure === undefined,
            async (prompt) => {
              reviewerSession = await withTimeout(activeClient.createSession({
                model: modelId,
                availableTools: [],
                systemMessage: {
                  content:
                    "You are a meticulous presentation content reviewer. Repair rejected slide JSON using only the supplied source and instructions. Preserve factual qualifiers and return strict JSON only.",
                },
              }), requestTimeoutMs, new CopilotRequestTimeoutError(requestTimeoutMs, "reviewer session creation"));
              try {
                const response = await withTimeout(
                  reviewerSession.sendAndWait({ prompt }, requestTimeoutMs),
                  requestTimeoutMs,
                  new CopilotRequestTimeoutError(requestTimeoutMs),
                );
                return response?.data.content;
              } catch (error) {
                if (isCopilotTimeout(error)) stopStarting = true;
                throw error;
              }
            },
          );
          } catch (error) {
            sessionFailure = { error };
            if (!(error instanceof SlideReviewFailedError)) stopStarting = true;
            throw error;
          } finally {
            let cleanupFailure: { error: unknown } | undefined;
            for (const activeSession of [reviewerSession, session]) {
              if (!activeSession) continue;
              if (sessionFailure && !(sessionFailure.error instanceof SlideReviewFailedError)) {
                try {
                  await withTimeout(activeSession.abort(), 10_000, new Error("Copilot session abort timed out after 10000ms."));
                } catch (cleanupError) {
                  cleanupFailure = { error: combineCleanupError((cleanupFailure ?? sessionFailure).error, cleanupError) };
                }
              }
              try {
                await withTimeout(activeSession.disconnect(), 10_000, new Error("Copilot session disconnect timed out after 10000ms."));
              } catch (cleanupError) {
                const previousFailure = cleanupFailure ?? sessionFailure;
                cleanupFailure = {
                  error: previousFailure ? combineCleanupError(previousFailure.error, cleanupError) : cleanupError,
                };
              }
            }
            if (cleanupFailure) throw cleanupFailure.error;
          }
        } else {
          generated = simplifyDeterministicContent(
            deterministicContent(post, options.speakerNotesLanguages),
          );
        }

        const imageResult = await imagePromise;
        if ("error" in imageResult) throw imageResult.error;
        const imageDataUri = imageResult.image;
        const enrichedPost = { ...post, ...generated, imageDataUri };
        enriched[index] = enrichedPost;
        await options.onPostEnriched?.(enrichedPost);
        completedEnrichments += 1;
        completionNumber = completedEnrichments;
        await options.trace?.({
          event: "article_processing_completed",
          articleTitle: post.title,
          progress,
        });
      } catch (error) {
        postFailure = { error };
        if (!(error instanceof SlideReviewFailedError)) stopStarting = true;
        throw error;
      } finally {
        activeEnrichments -= 1;
        const imageResult = await imagePromise;
        if ("error" in imageResult && imageResult.error !== postFailure?.error) {
          stopStarting = true;
          throw postFailure ? new AggregateError([postFailure.error, imageResult.error],
            `${String(postFailure.error)}\nImage trace logging also failed: ${String(imageResult.error)}`,
            { cause: postFailure.error }) : imageResult.error;
        }
      }
      process.stderr.write(
        `Completed ${completionNumber}/${posts.length} · active ${activeEnrichments}/${workerCount}: ${post.title}\n`,
      );
    };
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (firstFailure !== undefined || stopStarting) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= posts.length) return;
        try {
          await enrichPost(index);
        } catch (error) {
          if (error instanceof SlideReviewFailedError) {
            const skippedPost = posts[index];
            const itemNumber =
              options.progressForPost?.(skippedPost) ??
              (options.progressOffset ?? 0) + index + 1;
            const total = options.progressTotal ?? posts.length;
            const message = [
              `Warning: slide ${itemNumber}/${total} did not pass content review and was omitted: "${skippedPost?.title ?? "Unknown article"}".`,
              "The CLI will continue with the next article. Resume this run to retry the omitted slide and add it to the deck.",
              error.message,
            ].join("\n");
            try {
              process.stderr.write(`${message}\n`);
              await options.trace?.({
                event: "article_review_skipped",
                articleTitle: skippedPost?.title ?? "Unknown article",
                progress: itemNumber,
                error: error.message,
              });
              continue;
            } catch (traceError) {
              error = new AggregateError([error, traceError],
                `${message}\nTrace logging also failed: ${String(traceError)}`, { cause: error });
            }
          }
          stopStarting = true;
            const failedPost = posts[index];
            const itemNumber =
              options.progressForPost?.(failedPost) ??
              (options.progressOffset ?? 0) + index + 1;
            const total = options.progressTotal ?? posts.length;
            const processingFailure = new Error(
              [
                `Article processing failed at item ${itemNumber}/${total}: "${failedPost?.title ?? "Unknown article"}".`,
                error instanceof Error ? error.message : String(error),
                "No final presentation was written. Completed articles are preserved in the checkpoint and source cache; rerun with --resume after correcting the reported problem.",
                ...(options.traceLogPath ? [`Trace log: ${options.traceLogPath}`] : []),
              ].join("\n"),
              { cause: error },
            );
            firstFailure ??= processingFailure;
            workerFailures.push(processingFailure);
            try {
              await options.trace?.({
                event: "article_processing_failed",
                articleTitle: failedPost?.title ?? "Unknown article",
                progress: itemNumber,
                error: error instanceof Error ? error.message : String(error),
              });
            } catch (traceError) {
              workerFailures.push(new Error(`Trace logging also failed: ${String(traceError)}`, { cause: traceError }));
            }
          return;
        }
      }
    });
    const settledWorkers = await Promise.allSettled(workers);
    for (const worker of settledWorkers) {
      if (worker.status === "rejected") workerFailures.push(worker.reason);
    }
    if (workerFailures.length === 1) throw workerFailures[0];
    if (workerFailures.length > 1) {
      throw new AggregateError(workerFailures, workerFailures.map((error) =>
        error instanceof Error ? error.message : String(error)).join("\n"));
    }
    return enriched.filter((post): post is EnrichedPost => Boolean(post));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    if (client) {
      try {
        const errors = await withTimeout(client.stop(), 30_000, new Error("Copilot cleanup timed out after 30000ms."));
        if (errors?.length) {
          throw new AggregateError(errors, `Copilot cleanup failed: ${errors.map((error) => error.message).join("; ")}`);
        }
      } catch (cleanupError) {
        if (client.forceStop) {
          try {
            await withTimeout(client.forceStop(), 10_000, new Error("Copilot forced cleanup timed out after 10000ms."));
          } catch (forceError) {
            cleanupError = combineCleanupError(cleanupError, forceError);
          }
        }
        if (!failure) throw cleanupError;
        throw combineCleanupError(failure.error, cleanupError);
      }
    }
  }
}
