import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  checkpointMatches, loadCheckpoint, removeCheckpoint, saveCheckpoint, withRunLock,
  type CheckpointConfig, type CheckpointState, type ExistingRunAction,
} from "./checkpoint.js";
import { outputFileStem } from "./output-naming.js";
import { createTraceLogger, type TraceLogger } from "./trace.js";
import { createProgressDisplay } from "./progress.js";
import { writeCompletionSummary, writeConsoleMessage, type CompletionSummary } from "./console-output.js";
import { addAiUsage, emptyAiUsage, formatAiUsage, parseCreditLimit, type AiUsage } from "./usage.js";
import { builtinLanguage, localizationIssues } from "./locales.js";
import { audiences, isAudience, regenerationFields, type RegenerationTarget } from "./generation.js";
import {
  fingerprint, loadContentDocument, readAcceptedContent, saveAcceptedContent,
  saveContentDocument, sourceFingerprint, type ContentDocument, type GenerationSettings,
} from "./content-store.js";
import {
  beginIncremental, completeIncremental, incrementalRange, loadIncrementalState, type IncrementalState,
} from "./incremental.js";
import type { ArticleSelection, ChangelogCollectionOptions } from "./collector.js";
import type { ChangelogPost, DateRange, EnrichedPost, GeneratedContent } from "./types.js";
import {
  contentVersion, parseExecutionControls, parseLanguage, parseSpeakerNotesLanguages,
  rangeFromOptions, type CliOptions,
} from "./run-options.js";

async function askExistingRunAction(completed: number, total: number): Promise<ExistingRunAction> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "A previous unfinished run was found. Re-run with --resume or --restart.",
    );
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await reader.question(
        `Previous run found (${completed}/${total} entries completed). Resume or restart? [R/s]: `,
      );
      const normalized = answer.trim().toLowerCase();
      if (!normalized || normalized === "r" || normalized === "resume") return "resume";
      if (normalized === "s" || normalized === "restart") return "restart";
      writeConsoleMessage("Enter R to resume or S to restart.\n", "warning", process.stdout);
    }
  } finally {
    reader.close();
  }
}

interface IncrementalRun {
  path: string;
  state: IncrementalState;
}

type ProgressDisplay = ReturnType<typeof createProgressDisplay>;

interface BriefingExport {
  posts: EnrichedPost[];
  omittedUrls: string[];
  range: DateRange;
  settings: GenerationSettings;
  usage: AiUsage;
  output: string;
  jsonPath?: string;
  reviewOnly: boolean;
  website: boolean;
}

/** Complete every requested export before the caller can remove checkpoints or advance history. */
async function writeRunOutputs(result: BriefingExport): Promise<string | undefined> {
  const { posts, range, settings, output } = result;
  if (result.jsonPath) {
    await saveContentDocument(result.jsonPath, range, settings, posts, result.omittedUrls, result.usage);
    writeConsoleMessage(`Editable content: ${result.jsonPath}\n`, "success", process.stdout);
  }
  if (result.reviewOnly) return undefined;
  const { writePresentation } = await import("./presentation.js");
  const presentationPath = await writePresentation(posts, output, range.from, range.to, settings);
  writeConsoleMessage(`Presentation: ${presentationPath}\n`, "success", process.stdout);
  if (result.website) {
    const { writeWebsite } = await import("./html.js");
    const websitePath = await writeWebsite(posts, output, range.from, range.to, settings.slidesLanguage);
    writeConsoleMessage(`Website: ${websitePath}\n`, "success", process.stdout);
  }
  return presentationPath;
}

/** Imported documents bypass both discovery and downloads, including image discovery. */
async function prepareRunSources(
  range: DateRange,
  feed: string | undefined,
  sourceOptions: ChangelogCollectionOptions,
  imported: ContentDocument | undefined,
  trace: TraceLogger,
  progressDisplay: ProgressDisplay,
): Promise<{ posts: ChangelogPost[]; selection?: ArticleSelection }> {
  if (imported) return { posts: imported.articles };
  const { discoverChangelog, prepareChangelog } = await import("./collector.js");
  const selection = await discoverChangelog(range, feed, {
    ...sourceOptions,
    onFeedLoaded: async ({ source, articles, local }) => {
      await trace.log(local ? "local_feed_loaded" : "rss_feed_loaded", {
        ...(local ? { path: source } : { url: source }), articles,
      });
    },
  });
  await trace.log("source_selection_completed", { entries: selection.entries });
  const posts = await prepareChangelog(selection, {
    ...sourceOptions,
    onArticlesDiscovered: async (total) => {
      writeConsoleMessage(
        `Found ${total} articles across the selected sources. Preparing local source copies before Copilot enrichment.\n`,
      );
      await trace.log("source_articles_discovered", { total });
      progressDisplay.start("Sources", total);
    },
    onArticleProgress: async ({ completed, total, title, succeeded }) => {
      const message = `${succeeded ? "Prepared" : "Failed"} source ${completed}/${total}: ${title}`;
      if (progressDisplay.active) progressDisplay.update(completed, message, succeeded ? "success" : "error");
      else writeConsoleMessage(`${message}\n`, succeeded ? "success" : "error");
      await trace.log("source_article_prepared", { completed, total, title, succeeded });
    },
  });
  return { posts, selection };
}

/** Restart deliberately skips parsing a damaged checkpoint; resume must never silently discard it. */
async function restoreRunCheckpoint(
  path: string,
  config: CheckpointConfig,
  options: Pick<CliOptions, "restart" | "resume">,
  trace: TraceLogger,
): Promise<CheckpointState | undefined> {
  const restart = async () => {
    await removeCheckpoint(path);
    writeConsoleMessage("Restarting from the first entry.\n", "warning");
    await trace.log("checkpoint_restarted", { path });
  };
  if (options.restart) {
    await restart();
    return undefined;
  }
  let checkpoint: CheckpointState | undefined;
  try {
    checkpoint = await loadCheckpoint(path);
  } catch (error) {
    throw new Error(
      `The previous checkpoint cannot be read. Use --restart to discard it. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  await trace.log("checkpoint_loaded", {
    path, found: Boolean(checkpoint), completed: checkpoint?.completed.length ?? 0,
  });
  if (!checkpoint) return undefined;
  if (!checkpointMatches(checkpoint, config)) {
    writeConsoleMessage("Ignoring an incompatible checkpoint from a different configuration.\n", "warning");
    await removeCheckpoint(path);
    return undefined;
  }
  const action = options.resume
    ? "resume"
    : await askExistingRunAction(checkpoint.completed.length, config.postUrls.length);
  if (action === "restart") {
    await restart();
    return undefined;
  }
  writeConsoleMessage(`Resuming after ${checkpoint.completed.length} completed entries.\n`);
  await trace.log("checkpoint_resumed", { path, completed: checkpoint.completed.length });
  return checkpoint;
}

/** Resolve saved settings and incremental history before entering the per-briefing lock. */
export async function runBriefing(options: CliOptions, configured: ReadonlySet<string>): Promise<void> {
  options = {
    ...options,
    slidesLanguage: parseLanguage(options.slidesLanguage, "--slides-language"),
    speakerNotesLanguages: parseSpeakerNotesLanguages(options.speakerNotesLanguages).join(","),
  };
  let imported: ContentDocument | undefined;
  if (options.importJson) {
    if (options.sinceLastRun || options.dryRun) throw new Error("--import-json cannot be combined with --since-last-run or --dry-run.");
    for (const key of ["from", "to", "feed", "rss", "includeAiMl", "include", "exclude", "fullArticles"]) {
      if (configured.has(key)) throw new Error(`--import-json uses its saved sources and date range; omit the ${key} option/profile setting.`);
    }
    imported = await loadContentDocument(resolve(options.importJson));
    const saved = {
      model: imported.settings.model, ai: imported.settings.useAi, slidesLanguage: imported.settings.slidesLanguage,
      speakerNotesLanguages: imported.settings.speakerNotesLanguages.join(","),
      audience: imported.settings.audience, evidence: imported.settings.evidence,
    };
    for (const [key, value] of Object.entries(saved)) {
      if (configured.has(key) && options[key as keyof CliOptions] !== value) {
        throw new Error(`Imported content uses a different ${key} setting. Omit that override or start a new briefing.`);
      }
    }
    options = { ...options, ...saved, from: imported.range.from.slice(0, 10), to: imported.range.to.slice(0, 10) };
  }
  if ((options.regenerate.length || options.regenerateField.length || options.regenerateLanguage.length) && !imported) {
    throw new Error("Targeted regeneration requires --import-json with previously accepted content.");
  }
  if ((options.regenerateField.length || options.regenerateLanguage.length) && !options.regenerate.length) {
    throw new Error("--regenerate-field and --regenerate-language require one or more --regenerate article URLs.");
  }
  if (options.regenerate.length && !options.ai) throw new Error("Targeted regeneration requires an AI-generated content document.");
  if (options.evidence && !options.ai && !imported) throw new Error("--evidence requires AI generation.");
  if (!isAudience(options.audience)) throw new Error(`--audience supports: ${audiences.join(", ")}.`);
  if (options.dryRun && (options.exportJson || options.reviewOnly)) {
    throw new Error("--dry-run cannot export files; omit --export-json and --review-only.");
  }
  const requestedRange = imported
    ? { from: new Date(imported.range.from), to: new Date(imported.range.to) }
    : rangeFromOptions(options);
  if (!options.sinceLastRun) return executeRun(options, requestedRange, imported);
  // Execution limits do not change a history; source selection and generation settings do.
  const identity = fingerprint([
    options.profile ?? "", options.feed ?? "changelog", [...new Set(options.rss)].sort(), options.includeAiMl,
    options.include.map((term) => term.toLowerCase()).sort(), options.exclude.map((term) => term.toLowerCase()).sort(),
    options.fullArticles, options.model, options.ai, options.slidesLanguage, options.speakerNotesLanguages,
    options.audience, options.evidence,
  ]);
  const path = join(resolve(options.stateDir ?? join(options.output, ".briefing-state")), `${identity}.json`);
  const execute = async () => {
    const state = await loadIncrementalState(path, identity);
    const range = incrementalRange(requestedRange, state);
    if (!range) {
      writeConsoleMessage("No new incremental time window to process.\n", "info", process.stdout);
      return;
    }
    await executeRun(options, range, undefined, { path, state });
  };
  if (options.dryRun) await execute();
  else await withRunLock(`${path}.lock`, execute);
}

async function executeRun(
  options: CliOptions, range: DateRange, imported?: ContentDocument, incremental?: IncrementalRun,
): Promise<void> {
  const { requestTimeoutMs, limit, concurrency } = parseExecutionControls(options);
  const slidesLanguage = parseLanguage(options.slidesLanguage, "--slides-language");
  const speakerNotesLanguages = parseSpeakerNotesLanguages(options.speakerNotesLanguages);
  if (!options.ai && [slidesLanguage, ...speakerNotesLanguages].some((locale) => !builtinLanguage(locale)) &&
    (!imported || imported.articles.some((post) =>
      localizationIssues(post.localization, slidesLanguage, speakerNotesLanguages).length > 0))) {
    writeConsoleMessage("Warning: --no-ai does not translate content. Localized dates and locale names are retained, but unsupported built-in labels and template notes use English. Use AI for a fully localized deck.\n", "warning");
  }
  const maximumNanoAiu = parseCreditLimit(options.maxCredits);
  const settings: GenerationSettings = {
    contentVersion, model: options.model, useAi: options.ai, slidesLanguage, speakerNotesLanguages,
    audience: options.audience, evidence: options.evidence,
  };
  const regeneration = new Map<string, RegenerationTarget>();
  for (const url of new Set(options.regenerate)) {
    const baseline = imported?.articles.find((post) => post.url === url);
    if (!baseline) throw new Error(`Cannot regenerate ${url}: the URL is not present in the imported document.`);
    const languages = options.regenerateLanguage.map((value) => parseLanguage(value, "--regenerate-language"));
    regeneration.set(url, { baseline, fields: regenerationFields(baseline, options.regenerateField, languages) });
  }
  const output = resolve(options.output);
  const cacheDirectory = resolve(options.cacheDir ?? join(output, ".content-cache"));
  const fileStem = outputFileStem(range.from, range.to);
  if (options.exportJson) {
    const exportPath = resolve(options.exportJson);
    const reserved = [
      join(output, `${fileStem}.pptx`), join(output, `${fileStem}.html`), join(output, `${fileStem}.trace.jsonl`),
      join(output, `.${fileStem}.checkpoint.json`), join(output, `.${fileStem}.lock`),
      ...(incremental ? [incremental.path, `${incremental.path}.lock`] : []),
    ];
    if (reserved.some((path) => process.platform === "win32"
      ? resolve(path).toLowerCase() === exportPath.toLowerCase() : resolve(path) === exportPath)) {
      throw new Error("--export-json must not overwrite a presentation, website, trace, checkpoint, or run-state file.");
    }
  }
  const sourceOptions = {
    limit, additionalFeeds: options.rss, includeAiMl: options.includeAiMl,
    include: options.include, exclude: options.exclude, fullArticles: options.fullArticles,
    skipUrls: incremental ? new Set(incremental.state.deliveredUrls) : undefined,
  };
  if (options.dryRun) {
    const { discoverChangelog } = await import("./collector.js");
    const selection = await discoverChangelog(range, options.feed, sourceOptions);
    process.stdout.write(`${JSON.stringify({
      dryRun: true, from: range.from.toISOString(), to: range.to.toISOString(),
      selected: selection.selected.length, entries: selection.entries,
    }, null, 2)}\n`);
    return;
  }
  let completion: CompletionSummary | undefined;
  await withRunLock(join(output, `.${fileStem}.lock`), async () => {
    const tracePath = join(output, `${fileStem}.trace.jsonl`);
    const trace = createTraceLogger(tracePath, {
      onLine: options.verbose
        ? (line) => new Promise<void>((resolve, reject) => {
          process.stderr.write(line, (error) => error ? reject(error) : resolve());
        })
        : undefined,
    });
    await trace.log("run_started", {
      from: options.from,
      to: options.to,
      model: options.model,
      useAi: options.ai,
      feed: options.feed ?? null,
      rss: options.rss,
      includeAiMl: options.includeAiMl,
      limit: limit ?? null,
      concurrency: options.concurrency,
      requestTimeoutMs,
      slidesLanguage: options.slidesLanguage,
      speakerNotesLanguages: options.speakerNotesLanguages,
      audience: options.audience, evidence: options.evidence, maxCredits: options.maxCredits ?? null,
      profile: options.profile ?? null, include: options.include, exclude: options.exclude,
      fullArticles: options.fullArticles, incremental: Boolean(incremental),
      effectiveFrom: range.from.toISOString(), effectiveTo: range.to.toISOString(),
    });
    writeConsoleMessage(`Trace log: ${tracePath}\n`, "muted");
    const progressDisplay = createProgressDisplay({ enabled: !options.verbose });
    let currentUsage = emptyAiUsage();
    let previousUsage = emptyAiUsage();
    let resumed = false;
    let budgetPaused = false;

    try {
      if (incremental) await beginIncremental(incremental.path, incremental.state, range);
      const { canonicalArticleUrl } = await import("./collector.js");
      const { posts, selection } = await prepareRunSources(
        range, options.feed, sourceOptions, imported, trace, progressDisplay,
      );
      progressDisplay.stop();
      if (!posts.length) {
        if (incremental) {
          await completeIncremental(incremental.path, incremental.state, range, [], []);
          await trace.log("run_completed", { articles: 0, incremental: true });
          writeConsoleMessage("No new matching articles. Incremental history is up to date.\n", "success", process.stdout);
          return;
        }
        throw new Error(
          `No articles were found in the selected sources from ${options.from} through ${options.to}. Expand the date range, verify --feed / --rss, or enable --include-ai-ml.`,
        );
      }

      writeConsoleMessage(
        `All ${posts.length} selected source articles are available locally. Starting content processing.\n`,
        "success",
      );
      await trace.log("source_preparation_completed", {
        articles: posts.length,
        source: options.feed ?? "GitHub Copilot changelog",
        rss: options.rss,
        includeAiMl: options.includeAiMl,
      });
      const checkpointPath = join(
        output,
        `.${fileStem}.checkpoint.json`,
      );
      const checkpointConfig: CheckpointConfig = {
        contentVersion,
        postUrls: posts.map((post) => post.url),
        model: options.model,
        useAi: options.ai,
        slidesLanguage,
        speakerNotesLanguages,
        audience: options.audience,
        evidence: options.evidence,
        ...(regeneration.size ? {
          regeneration: fingerprint([
            imported, [...regeneration].map(([url, value]) => [url, value.fields]),
          ])
        } : {}),
      };
      const useCheckpoint = !imported || regeneration.size > 0;
      const checkpoint = useCheckpoint
        ? await restoreRunCheckpoint(checkpointPath, checkpointConfig, options, trace)
        : undefined;

      const state: CheckpointState = checkpoint ?? {
        version: 1,
        config: checkpointConfig,
        completed: imported ? imported.articles.filter((post) => !regeneration.has(post.url)) : [],
        ...(imported ? { usage: imported.usage } : {}),
      };
      const sourcesByUrl = new Map(posts.map((post) => [post.url, post]));
      const changed = state.completed.filter((post) => {
        const current = sourcesByUrl.get(post.url);
        return !current || sourceFingerprint(current) !== sourceFingerprint(post);
      });
      if (changed.length) {
        state.completed = state.completed.filter((post) => !changed.includes(post));
        writeConsoleMessage(`Source content changed for ${changed.length} accepted articles; regenerating them.\n`, "warning");
        await trace.log("checkpoint_sources_invalidated", { urls: changed.map((post) => post.url) });
      }
      resumed = Boolean(checkpoint || imported);
      previousUsage = state.usage ?? { ...emptyAiUsage(), historyIncomplete: resumed && options.ai };
      state.usage = previousUsage;
      if (useCheckpoint) await saveCheckpoint(checkpointPath, state);
      const completedByUrl = new Map(state.completed.map((post) => [post.url, post]));
      const pendingPosts = posts.filter((post) => !completedByUrl.has(post.url));
      const acceptedContent = new Map<string, GeneratedContent>();
      if (options.cache && !options.restart) for (const post of pendingPosts) {
        if (regeneration.has(post.url)) continue;
        const cached = await readAcceptedContent(cacheDirectory, post, settings);
        if (cached) {
          acceptedContent.set(post.url, cached);
          await trace.log("accepted_content_reused", { url: post.url, title: post.title });
        }
      }
      pendingPosts.sort((a, b) => Number(acceptedContent.has(b.url)) - Number(acceptedContent.has(a.url)));
      if (acceptedContent.size) writeConsoleMessage(`Reusing accepted content for ${acceptedContent.size} articles without new AI calls.\n`, "success");
      if (pendingPosts.length) {
        writeConsoleMessage(`Enriching ${pendingPosts.length}/${posts.length} articles.\n`);
        const { enrichWithCopilot } = await import("./enricher.js");
        const articlePositions = new Map(
          posts.map((post, index) => [post.url, index + 1]),
        );
        // Concurrent article and billing callbacks must share this queue and the same checkpoint state.
        let checkpointWrite = Promise.resolve();
        const persistState = () => {
          checkpointWrite = checkpointWrite.then(() => saveCheckpoint(checkpointPath, state));
          return checkpointWrite;
        };
        progressDisplay.start("Enriching", posts.length, Math.min(concurrency, pendingPosts.length), state.completed.length);
        try {
          await enrichWithCopilot(pendingPosts, {
            model: options.model,
            useAi: options.ai,
            slidesLanguage,
            speakerNotesLanguages,
            concurrency,
            requestTimeoutMs,
            maximumNanoAiu, previousUsage, acceptedContent, regeneration,
            audience: options.audience, evidence: options.evidence,
            onBudgetPaused: async (error) => {
              budgetPaused = true;
              await trace.log("ai_budget_paused", { error: error.message });
            },
            progressOffset: state.completed.length,
            progressTotal: posts.length,
            progressForPost: (post) => articlePositions.get(post.url) ?? 0,
            trace: ({ event, ...data }) => trace.log(event, data),
            traceLogPath: tracePath,
            onProgress: progressDisplay.active ? (event) => progressDisplay.event(event) : undefined,
            onMessage: (message, kind) => progressDisplay.log(message, kind),
            onUsage: async (usage) => {
              currentUsage = usage;
              state.usage = addAiUsage(previousUsage, currentUsage);
              await persistState();
              await trace.log("copilot_usage_updated", { currentUsage, totalUsage: state.usage });
            },
            onPostEnriched: async (post) => {
              state.completed.push(post);
              await persistState();
              if (options.cache) await saveAcceptedContent(cacheDirectory, post, settings);
              await trace.log("checkpoint_article_saved", {
                path: checkpointPath,
                title: post.title,
                completed: state.completed.length,
                total: posts.length,
              });
            },
          });
        } finally {
          progressDisplay.stop();
        }
      }
      const allCompletedByUrl = new Map(state.completed.map((post) => [post.url, post]));
      const enriched = posts
        .map((post) => allCompletedByUrl.get(post.url) ?? regeneration.get(post.url)?.baseline)
        .filter((post): post is EnrichedPost => Boolean(post));
      const omittedPosts = posts.filter((post) => !allCompletedByUrl.has(post.url));
      const omittedUrls = [...new Set([...(imported?.omittedUrls ?? []), ...omittedPosts.map((post) => post.url)])]
        .filter((url) => !allCompletedByUrl.has(url));
      const jsonPath = options.exportJson ? resolve(options.exportJson) :
        (options.reviewOnly || regeneration.size) ? join(output, `${fileStem}.${regeneration.size ? "revised" : "review"}.json`) : undefined;
      const presentationPath = await writeRunOutputs({
        posts: enriched, omittedUrls, range, settings, usage: state.usage ?? emptyAiUsage(),
        output, jsonPath, reviewOnly: options.reviewOnly, website: options.website,
      });
      if (omittedUrls.length) {
        writeConsoleMessage(
          `Warning: ${omittedUrls.length} slide${omittedUrls.length === 1 ? "" : "s"} ${omittedUrls.length === 1 ? "was" : "were"
          } omitted ${budgetPaused ? "because the AI budget paused processing" : "after content review"}. ${regeneration.size ? "Previously accepted content was kept for unsuccessful revisions. " : ""
          }${useCheckpoint ? "The checkpoint was kept; resume this run to retry the pending articles and rewrite the deck." : "The imported document is a partial briefing."}\n`,
          "warning",
        );
        await trace.log("checkpoint_retained", {
          path: checkpointPath,
          completed: enriched.length,
          omitted: omittedUrls.length,
          omittedTitles: omittedPosts.map((post) => post.title),
        });
      } else if (options.reviewOnly) {
        writeConsoleMessage("Review-only: edit the JSON, then use --import-json to render it without new AI calls. The checkpoint was retained.\n");
      }
      if (imported && options.cache) for (const post of enriched) await saveAcceptedContent(cacheDirectory, post, settings);
      await trace.log("run_completed", {
        articles: enriched.length,
        omittedArticles: omittedUrls.length,
        presentationPath,
        websiteGenerated: options.website && !options.reviewOnly,
        checkpointRetained: useCheckpoint && (omittedUrls.length > 0 || options.reviewOnly || budgetPaused),
        currentUsage,
        totalUsage: addAiUsage(previousUsage, currentUsage),
      });
      // Commit delivery history only after exports succeed; pending work must survive every other outcome.
      if (!omittedUrls.length && !options.reviewOnly && !budgetPaused) {
        if (incremental) await completeIncremental(incremental.path, incremental.state, range,
          posts.map((post) => canonicalArticleUrl(post.url)),
          selection?.entries.filter((entry) => entry.status === "limit").map((entry) => entry.publishedAt) ?? []);
        if (useCheckpoint) await removeCheckpoint(checkpointPath);
      }
      if (budgetPaused) process.exitCode = 2;
      writeConsoleMessage(`Trace log: ${tracePath}\n`, "muted", process.stdout);
      completion = {
        presentationPath, reviewPath: jsonPath, included: enriched.length, pending: omittedUrls.length,
        resumable: useCheckpoint, budgetPaused,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await trace.log("run_failed", {
          error: message, currentUsage, totalUsage: addAiUsage(previousUsage, currentUsage),
        });
      } catch (traceError) {
        throw new Error(
          `${message}\nTrace logging also failed at ${tracePath}: ${traceError instanceof Error ? traceError.message : String(traceError)}`,
          { cause: error },
        );
      }
      if (message.includes(`Trace log: ${tracePath}`)) throw error;
      throw new Error(`${message}\nTrace log: ${tracePath}`, { cause: error });
    } finally {
      progressDisplay.stop();
      if (options.ai) {
        writeConsoleMessage(`${formatAiUsage(addAiUsage(previousUsage, currentUsage))}${resumed ? " Includes previous attempts and this resumed execution." : ""}\n`);
        if (resumed) writeConsoleMessage(`This execution: ${formatAiUsage(currentUsage)}\n`, "muted");
      }
    }
  });
  if (completion) writeCompletionSummary(completion);
}
