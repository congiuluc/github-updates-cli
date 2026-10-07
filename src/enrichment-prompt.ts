import { audienceInstructions, type Audience, type RegenerationTarget } from "./generation.js";
import { builtinLanguage, localeName, localizationPrompt } from "./locales.js";
import { sectionDetailKeys, type ChangelogPost, type Section, type SupportedLanguage } from "./types.js";

export interface EnrichmentPromptOptions {
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: SupportedLanguage[];
  audience?: Audience;
  evidence?: boolean;
}

/** Build the source-grounded task; this function performs no I/O or SDK calls. */
export function buildEnrichmentPrompt(
  post: ChangelogPost,
  options: EnrichmentPromptOptions,
  requiredSection: Section,
  regeneration?: RegenerationTarget,
): string {
  const detailsShape = Object.fromEntries(
    sectionDetailKeys[requiredSection].map((key) => [key, "value"]),
  );
  const speakerNotesShape = Object.fromEntries(
    options.speakerNotesLanguages.map((language) => [language, "presenter script"]),
  );
  return [
    "Create presentation-ready content for one article from the selected sources.",
    "Do not assume the article concerns GitHub or Copilot unless the supplied source says so.",
    audienceInstructions[options.audience ?? "standard"],
    ...(regeneration ? [
      `Accepted content to revise: ${JSON.stringify(regeneration.baseline)}`,
      regeneration.fields.length
        ? `Change only these fields: ${regeneration.fields.join(", ")}. Return the full JSON object; all other accepted fields must remain unchanged.`
        : "Regenerate the complete content for this article using the source below.",
    ] : []),
    ...(options.evidence ? [
      "Also return an evidence array. For summary, each notes.N, each details.KEY, and each speakerNotes.LANGUAGE include at least one {field, quote, url} entry.",
      `Each quote must be a verbatim excerpt of the supplied Article text. Use exactly this source URL: ${post.url}. Evidence assists human factual review; it must not contain invented quotations or alternative URLs.`,
    ] : []),
    `Write summary, notes, and detail values in ${localeName(options.slidesLanguage)}.`,
    `Use the exact slide locale ${options.slidesLanguage}. Preserve its regional vocabulary and writing system.`,
    ...localizationPrompt(options.slidesLanguage, options.speakerNotesLanguages),
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
    builtinLanguage(options.slidesLanguage) === "it"
      ? "Inizia keyCapabilities con verbi d'azione orientati ai benefici, per esempio 'Migliora la revisione, semplifica la navigazione, organizza le sessioni'."
      : "Start keyCapabilities with benefit-oriented action verbs, for example 'Improve review, simplify navigation, organize sessions'.",
    "Make howToUse a concrete first action; do not merely restate that the feature can be used.",
    "Illustrative source, not facts about the actual article: The Agents view is in preview in VS Code. It groups sessions by task, preserves each chat's context when resumed, and shows proposed file edits as diffs. Open Agents, select a session, then review its diff before accepting edits. Follow the specificity of the example below, but never copy its facts unless supported by the actual article.",
    `Illustrative output: ${JSON.stringify(builtinLanguage(options.slidesLanguage) === "it" ? {
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
}
