import type { CopilotClient } from "@github/copilot-sdk";
import { load } from "cheerio";
import { buildEnrichmentPrompt } from "./enrichment-prompt.js";
import {
  evidenceIssues, mergeRegeneratedContent, parseEvidence,
  type Audience, type RegenerationTarget,
} from "./generation.js";
import {
  builtinLanguage, localizationIssues, parseLocalization,
} from "./locales.js";
import { createUsageTracker, CreditLimitError, emptyAiUsage, type AiUsage, type UsageSession } from "./usage.js";
import {
  sections,
  sectionDetailKeys,
  explanatoryDetailKeys,
  type ChangelogPost,
  type EnrichedPost,
  type GeneratedContent,
  type Section,
  type SlideDetailKey,
  type SupportedLanguage,
} from "./types.js";
export { sectionDetailKeys } from "./types.js";
export type { GeneratedContent } from "./types.js";
import {
  NEWS_ARTICLE_CACHE_MAX_AGE_MS,
  readThroughNewsCache,
} from "./news-cache.js";

export interface EnrichmentTraceEvent {
  event:
  | "article_processing_started"
  | "article_processing_completed"
  | "article_processing_failed"
  | "article_review_skipped"
  | "article_processing_paused"
  | "copilot_attempt_started"
  | "copilot_response_received"
  | "copilot_request_failed"
  | "slide_validation_completed"
  | "image_download_failed";
  articleTitle: string;
  worker?: number;
  attempt?: number;
  progress?: number;
  prompt?: string;
  response?: string | null;
  issues?: string[];
  error?: string;
  agent?: "enricher" | "reviewer";
}

export interface EnrichmentCopilotSession extends UsageSession {
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

export class SlideReviewFailedError extends Error { }

export interface EnrichmentOptions {
  model: string;
  useAi: boolean;
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: SupportedLanguage[];
  concurrency?: number;
  requestTimeoutMs?: number;
  progressOffset?: number;
  progressTotal?: number;
  progressForPost?: (post: ChangelogPost) => number;
  /** Persist accepted work before the worker reports completion. */
  onPostEnriched?: (post: EnrichedPost) => Promise<void>;
  trace?: (event: EnrichmentTraceEvent) => Promise<void>;
  traceLogPath?: string;
  onProgress?: (event: EnrichmentTraceEvent) => void;
  onMessage?: (message: string) => void;
  /** Receives whole-invocation snapshots, not per-request usage deltas. */
  onUsage?: (usage: AiUsage) => Promise<void>;
  maximumNanoAiu?: number;
  previousUsage?: AiUsage;
  onBudgetPaused?: (error: CreditLimitError) => Promise<void>;
  audience?: Audience;
  evidence?: boolean;
  acceptedContent?: ReadonlyMap<string, GeneratedContent>;
  regeneration?: ReadonlyMap<string, RegenerationTarget>;
  clientFactory?: () => EnrichmentCopilotClient;
}

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
    `Copilot model "${requestedModel}" is not available. Available models: ${availableModels.length > 0 ? availableModels.join(", ") : "none"
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
  /^(?:(?:access|add|allow|accelerate|apply|automate|boost|bring|build|catch|choose|clarify|connect|control|coordinate|create|customi[sz]e|cut|debug|deliver|detect|discover|edit|enable|enforce|enhance|expand|find|generate|govern|help|improve|introduce|let|maintain|manage|moderni[sz]e|monitor|navigate|optimi[sz]e|organi[sz]e|pin|prepare|protect|provide|publish|reduce|review|run|select|share|simplify|speed|standardi[sz]e|streamline|strengthen|support|surface|track|tune|unlock|update|use|validate)(?:s|es)?|(?:accedi|accelera|aggiorna|aggiunge|abilita|applica|automatizza|chiarisce|collega|condividi|consente|controlla|coordina|crea|fornisce|genera|gestisce|governa|individua|migliora|modernizza|monitora|naviga|organizza|ottimizza|permette|potenzia|prepara|pubblica|regola|riduce|rende|semplifica|standardizza|supporta|valida|velocizza))\b/i;

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

function wordCount(value: string, locale?: SupportedLanguage): number {
  if (locale && !builtinLanguage(locale)) {
    return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(value)].filter((part) => part.isWordLike).length;
  }
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

/** Check slide wording and layout budgets; presenter-script length remains a prompt target. */
export function slideContentIssues(
  content: GeneratedContent,
  articleTitle?: string,
  expectedSection?: Section,
  _speakerNotesLanguages: SupportedLanguage[] = [],
  slidesLanguage: SupportedLanguage = "en",
): string[] {
  const issues: string[] = [];
  const lexicalRules = Boolean(builtinLanguage(slidesLanguage));
  if (expectedSection && content.section !== expectedSection) {
    issues.push(`section must be ${expectedSection}`);
  }
  if (wordCount(content.summary, slidesLanguage) > 32 || content.summary.length > 220) {
    issues.push("summary must be at most 32 words and 220 characters");
  }
  if (
    /[\r\n]/.test(content.summary) ||
    /\.{3}|…/.test(content.summary) ||
    !/\p{Sentence_Terminal}[\p{Close_Punctuation}\p{Final_Punctuation}"']*$/u.test(content.summary.trim()) ||
    (lexicalRules && endsWithDanglingWord(content.summary))
  ) {
    issues.push("summary must be one complete sentence without line breaks or ellipses");
  }
  if (lexicalRules && /^(?:this|the) (?:announcement|change|release|update)\b/i.test(content.summary.trim())) {
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
    if (wordCount(note, slidesLanguage) > 16 || note.length > 110) {
      issues.push(`note ${index + 1} must be at most 16 words and 110 characters`);
    }
    if (/[\r\n]|\.{3}|…/.test(note) || (lexicalRules && endsWithDanglingWord(note))) {
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
    if (wordCount(value, slidesLanguage) > maximumWords || value.length > maximumCharacters) {
      issues.push(`${key} must be at most ${maximumWords} words and ${maximumCharacters} characters`);
    }
    if (
      /[\r\n]|\.{3}|…/.test(value) ||
      (lexicalRules && endsWithDanglingWord(value)) ||
      (lexicalRules && /(?:see|read|check)\s+(?:the\s+)?(?:source|article|documentation)/i.test(value))
    ) {
      issues.push(`${key} must be a complete standalone phrase without filler or ellipses`);
    }
    // Commas can separate model names, dates, or qualifiers within one point.
    if (value.split(/[;；؛]/u).filter((point) => point.trim()).length > 3) {
      issues.push(`${key} must prioritize 2-3 semicolon-separated points instead of an exhaustive list`);
    }
    if (
      lexicalRules && key === "availability" &&
      /\b(?:announced|published|posted)\s+(?:on\s+)?(?:\d{1,4}(?:[-/]\d{1,2})?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(value)
    ) {
      issues.push("availability must describe product status, eligibility, plans, or supported surfaces, not the article date");
    }
    if (
      lexicalRules && key === "keyCapabilities" &&
      !beginsWithBenefitOrientedAction(value)
    ) {
      issues.push("keyCapabilities must begin with a benefit-oriented action");
    }
    if (lexicalRules && key === "announcement" && wordCount(value) < 6) {
      issues.push("announcement must state the specific change, not only name its topic");
    }
    if (lexicalRules && key === "impact" && wordCount(value) < 8) {
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
      lexicalRules && key === "useGuidance" &&
      !hasUseAndAvoidGuidance(value)
    ) {
      issues.push("useGuidance must explicitly state both when to use and when to avoid the model");
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
    ...(parsed.evidence !== undefined ? { evidence: parseEvidence(parsed.evidence) } : {}),
    ...(parsed.localization !== undefined ? { localization: parseLocalization(parsed.localization) } : {}),
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
  contentOptions: {
    source?: ChangelogPost;
    evidence?: boolean;
    baseline?: EnrichedPost;
    fields?: string[];
    slidesLanguage?: SupportedLanguage;
  } = {},
): Promise<GeneratedContent> {
  let prompt = initialPrompt;
  let lastProblem = "Copilot returned no content.";
  let problemKind: "empty" | "request" | "validation" = "empty";
  let lastContent: string | undefined;
  let lastValidationProblem: string | undefined;
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
      if (contentOptions.baseline) {
        candidate = mergeRegeneratedContent(contentOptions.baseline, candidate, contentOptions.fields ?? []);
      }
      issues = slideContentIssues(candidate, articleTitle, expectedSection, speakerNotesLanguages, contentOptions.slidesLanguage);
      if (contentOptions.source) {
        issues.push(...evidenceIssues(candidate, contentOptions.source, speakerNotesLanguages, contentOptions.evidence));
      }
      if (contentOptions.slidesLanguage) {
        issues.push(...localizationIssues(candidate.localization, contentOptions.slidesLanguage, speakerNotesLanguages));
      }
    } catch (error) {
      issues = [error instanceof Error ? error.message : String(error)];
    }
    await trace?.({ event: "slide_validation_completed", articleTitle, attempt, issues, ...(agent ? { agent } : {}) });
    if (!issues.length) return candidate;
    lastProblem = issues.join("; ");
    lastValidationProblem = lastProblem;
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
      if (error instanceof CreditLimitError) throw error;
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
      prompt = [
        `The previous request failed: ${lastProblem}.`,
        "Retry the original task below. Use the error as diagnostic context, not as source facts. Adjust the response if the error is actionable; do not claim to repair service or authentication problems.",
        ...(lastValidationProblem ? [`Outstanding response problems: ${lastValidationProblem}.`] : []),
        `Original task: ${initialPrompt}`,
        "Return the complete corrected JSON object only.",
      ].join("\n\n");
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
      if (error instanceof CreditLimitError) throw error;
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
  const mentionsCopilot = /\bcopilot\b/i.test(`${post.title} ${post.plainText}`);
  const published = new Date(post.publishedAt).toLocaleDateString("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  });
  const detailsBySection: Record<Section, Partial<Record<SlideDetailKey, string>>> = {
    Models: {
      modelName: post.title,
      availability: generic,
      keyCapabilities: summary,
      useGuidance: `Use for supported ${mentionsCopilot ? "Copilot " : ""}workloads; avoid where the announced limitations apply.`,
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
      audience: `${mentionsCopilot ? "GitHub Copilot users" : "Users"} and administrators affected by this change.`,
    },
    IDE: {
      feature: post.title,
      availability: generic,
      keyCapabilities: summary,
      howToUse: `Update the supported IDE, then enable or open the announced ${mentionsCopilot ? "Copilot " : ""}feature.`,
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
      builtinLanguage(language) === "it"
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

class ArticlePageUnavailableError extends Error { }

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

/**
 * Process independent article sessions with bounded concurrency and stable output order.
 * Review failures omit one article; operational failures stop new work and drain active peers.
 * Budget pauses preserve accepted work and report through onBudgetPaused rather than retrying.
 */
export async function enrichWithCopilot(
  posts: ChangelogPost[],
  options: EnrichmentOptions,
): Promise<EnrichedPost[]> {
  let client: EnrichmentCopilotClient | undefined;
  let modelId = options.model;
  const workerCount = Math.min(options.concurrency ?? 1, Math.max(posts.length, 1));
  const requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
    throw new Error("Copilot request timeout must be a positive whole number of milliseconds no greater than 2147483647.");
  }
  let failure: { error: unknown } | undefined;
  const usage = createUsageTracker(options.onUsage, options.maximumNanoAiu === undefined ? undefined : {
    maximumNanoAiu: options.maximumNanoAiu, previous: options.previousUsage ?? emptyAiUsage(),
  });
  let budgetPause: CreditLimitError | undefined;
  const requiresAi = options.useAi && (posts.length === 0 || posts.some((post) => !options.acceptedContent?.has(post.url)));
  const writeMessage = options.onMessage ?? ((message: string) => { process.stderr.write(message); });
  const reportTrace = async (event: EnrichmentTraceEvent) => {
    options.onProgress?.(event);
    await options.trace?.(event);
  };

  try {
    if (requiresAi) {
      try { usage.assertCanStart(); }
      catch (error) {
        if (!(error instanceof CreditLimitError)) throw error;
        budgetPause = error;
      }
    }
    if (requiresAi && !budgetPause) {
      writeMessage("Starting Copilot runtime...\n");
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
      writeMessage(`Copilot runtime ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; response timeout ${requestTimeoutMs / 1000}s.\n`);
    }
    const enriched = new Array<EnrichedPost>(posts.length);
    let nextIndex = 0;
    let firstFailure: unknown;
    const workerFailures: unknown[] = [];
    let stopStarting = false;
    let activeEnrichments = 0;
    let completedEnrichments = 0;
    const sendTrackedPrompt = async (
      session: EnrichmentCopilotSession,
      sessionUsage: ReturnType<typeof usage.watch>,
      prompt: string,
    ): Promise<string | undefined> => {
      // Persist the pending request and enforce its budget before making a paid call.
      await sessionUsage.startRequest();
      try {
        // The SDK timeout starts only after send() and does not cancel generation.
        const response = await withTimeout(
          session.sendAndWait({ prompt }, requestTimeoutMs),
          requestTimeoutMs,
          new CopilotRequestTimeoutError(requestTimeoutMs),
        );
        await usage.flush();
        await sessionUsage.finishRequest();
        return response?.data.content;
      } catch (error) {
        if (isCopilotTimeout(error)) {
          stopStarting = true;
          sessionUsage.markInterrupted();
        }
        await sessionUsage.finishRequest();
        throw error;
      }
    };
    writeMessage(
      `${workerCount === 1 ? "Sequential" : "Parallel"} enrichment: ${workerCount} ${options.useAi ? "Copilot session" : "worker"}${workerCount === 1 ? "" : "s"
      } for ${posts.length} article${posts.length === 1 ? "" : "s"}.\n`,
    );
    const enrichPost = async (index: number, worker: number): Promise<void> => {
      const post = posts[index];
      const regeneration = options.regeneration?.get(post.url);
      const requiredSection = regeneration?.fields.length ? regeneration.baseline.section : classifySection(post);
      const progress =
        options.progressForPost?.(post) ??
        (options.progressOffset ?? 0) + index + 1;
      let completionNumber = 0;
      activeEnrichments += 1;
      if (!options.onProgress) writeMessage(
        `Starting ${progress}/${options.progressTotal ?? posts.length} · active ${activeEnrichments}/${workerCount}: ${post.title}\n`,
      );
      await reportTrace({
        event: "article_processing_started",
        articleTitle: post.title,
        worker,
        progress,
      });
      const imagePromise = (regeneration
        ? Promise.resolve(regeneration.baseline.imageDataUri)
        : findArticleImage(post)).catch(async (error: unknown) => {
          writeMessage(
            `Warning: image download failed for "${post.title}": ${error instanceof Error ? error.message : String(error)}\n`,
          );
          await reportTrace({
            event: "image_download_failed",
            articleTitle: post.title,
            worker,
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
        const accepted = options.acceptedContent?.get(post.url);
        if (accepted) {
          generated = accepted;
        } else if (budgetPause) {
          throw budgetPause;
        } else if (client) {
          const activeClient = client;
          let session: EnrichmentCopilotSession | undefined;
          let reviewerSession: EnrichmentCopilotSession | undefined;
          const usageSessions: ReturnType<typeof usage.watch>[] = [];
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
            const sessionUsage = usage.watch(activeSession);
            usageSessions.push(sessionUsage);
            const initialPrompt = buildEnrichmentPrompt(post, options, requiredSection, regeneration);
            generated = await generateSlideReadyContent(
              (prompt) => sendTrackedPrompt(activeSession, sessionUsage, prompt),
              initialPrompt,
              options.speakerNotesLanguages,
              post.title,
              requiredSection,
              (event) => reportTrace({ ...event, worker, progress }),
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
                const reviewerUsage = usage.watch(reviewerSession);
                usageSessions.push(reviewerUsage);
                return sendTrackedPrompt(reviewerSession, reviewerUsage, prompt);
              },
              {
                source: post, evidence: options.evidence, baseline: regeneration?.baseline,
                fields: regeneration?.fields, slidesLanguage: options.slidesLanguage,
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
            for (const watched of usageSessions) watched.dispose();
            try {
              await usage.flush();
            } catch (usageError) {
              const previousFailure = cleanupFailure ?? sessionFailure;
              cleanupFailure = {
                error: previousFailure
                  ? new AggregateError([previousFailure.error, usageError],
                    `${String(previousFailure.error)}\n${String(usageError)}`, { cause: previousFailure.error })
                  : usageError
              };
            }
            if (cleanupFailure) throw cleanupFailure.error;
          }
        } else {
          if (options.evidence) throw new Error("--evidence requires AI generation or previously accepted evidence.");
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
        await reportTrace({
          event: "article_processing_completed",
          articleTitle: post.title,
          worker,
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
      if (!options.onProgress) writeMessage(
        `Completed ${completionNumber}/${posts.length} · active ${activeEnrichments}/${workerCount}: ${post.title}\n`,
      );
    };
    const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
      const worker = workerIndex + 1;
      while (true) {
        if (firstFailure !== undefined || stopStarting) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= posts.length) return;
        try {
          await enrichPost(index, worker);
        } catch (error) {
          if (error instanceof CreditLimitError) {
            stopStarting = true;
            budgetPause = error;
            writeMessage(`Warning: ${error.message}\n`);
            await options.onBudgetPaused?.(error);
            await reportTrace({
              event: "article_processing_paused", articleTitle: posts[index].title, worker, error: error.message,
            });
            return;
          }
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
              writeMessage(`${message}\n`);
              await reportTrace({
                event: "article_review_skipped",
                articleTitle: skippedPost?.title ?? "Unknown article",
                worker,
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
            await reportTrace({
              event: "article_processing_failed",
              articleTitle: failedPost?.title ?? "Unknown article",
              worker,
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
