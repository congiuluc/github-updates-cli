#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import { renderStartupBanner } from "./banner.js";
import {
  checkpointMatches,
  loadCheckpoint,
  removeCheckpoint,
  saveCheckpoint,
  withRunLock,
  type CheckpointConfig,
  type CheckpointState,
  type ExistingRunAction,
} from "./checkpoint.js";
import { outputFileStem } from "./output-naming.js";
import { createTraceLogger } from "./trace.js";
import type { DateRange, EnrichedPost, SupportedLanguage } from "./types.js";
import { updateCli } from "./updater.js";

interface CliOptions {
  from: string;
  to: string;
  output: string;
  model: string;
  limit?: string;
  feed?: string;
  ai: boolean;
  website: boolean;
  resume: boolean;
  restart: boolean;
  verbose: boolean;
  concurrency: string;
  requestTimeout: string;
  slidesLanguage: SupportedLanguage;
  speakerNotesLanguages: string;
}

const supportedLanguages = new Set<SupportedLanguage>(["en", "it"]);
const contentVersion = 6;

function parseLanguage(value: string, optionName: string): SupportedLanguage {
  const language = value.trim().toLowerCase() as SupportedLanguage;
  if (!supportedLanguages.has(language)) {
    throw new Error(`${optionName} supports: en, it.`);
  }
  return language;
}

function parseSpeakerNotesLanguages(value: string): SupportedLanguage[] {
  const languages = [...new Set(value.split(",").map((item) => parseLanguage(item, "--speaker-notes-languages")))];
  if (!languages.length) throw new Error("--speaker-notes-languages requires at least one language.");
  return languages;
}

function parseDate(value: string, endOfDay: boolean): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date "${value}".`);
  }
  return date;
}

function rangeFromOptions(options: CliOptions): DateRange {
  const range = { from: parseDate(options.from, false), to: parseDate(options.to, true) };
  if (range.from > range.to) throw new Error("--from must be earlier than or equal to --to.");
  return range;
}

function defaultFrom(): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}

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
      process.stdout.write("Enter R to resume or S to restart.\n");
    }
  } finally {
    reader.close();
  }
}

async function run(options: CliOptions): Promise<void> {
  const range = rangeFromOptions(options);
  if (options.resume && options.restart) {
    throw new Error("--resume and --restart cannot be used together.");
  }
  const requestTimeoutMs = Number(options.requestTimeout) * 1000;
  if (!/^\d+$/.test(options.requestTimeout) || !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1000 || requestTimeoutMs > 2_147_483_647) {
    throw new Error(`Invalid --request-timeout value "${options.requestTimeout}". Use a positive whole number of seconds up to 2147483.`);
  }
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (options.limit !== undefined &&
      (!/^\d+$/.test(options.limit) || !Number.isSafeInteger(limit) || Number(options.limit) < 1)) {
    throw new Error(
      `Invalid --limit value "${options.limit}". Use a positive whole number, for example --limit 10.`,
    );
  }
  const concurrency = Number(options.concurrency);
  if (!/^\d+$/.test(options.concurrency) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error(`Invalid --concurrency value "${options.concurrency}". Use an integer from 1 to 8.`);
  }
  const slidesLanguage = parseLanguage(options.slidesLanguage, "--slides-language");
  const speakerNotesLanguages = parseSpeakerNotesLanguages(options.speakerNotesLanguages);
  const output = resolve(options.output);
  const fileStem = outputFileStem(range.from, range.to);
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
    limit: limit ?? null,
    concurrency: options.concurrency,
    requestTimeoutMs,
    slidesLanguage: options.slidesLanguage,
    speakerNotesLanguages: options.speakerNotesLanguages,
  });
  process.stderr.write(`Trace log: ${tracePath}\n`);

  try {
  const { collectChangelog, parseChangelogFeed } = await import("./collector.js");
  let sourcePreparationAnnounced = false;
  let posts;
  if (options.feed && !/^https?:\/\//i.test(options.feed)) {
    const feedPath = resolve(options.feed);
    let feedXml: string;
    try {
      feedXml = await readFile(feedPath, "utf8");
    } catch (error) {
      throw new Error(
        `Could not read the local feed file at ${feedPath}: ${error instanceof Error ? error.message : String(error)}. Verify the path and file permissions, then retry.`,
        { cause: error },
      );
    }
    try {
      posts = parseChangelogFeed(feedXml, range, limit);
      await trace.log("local_feed_loaded", {
        path: feedPath,
        articles: posts.length,
      });
    } catch (error) {
      throw new Error(
        `Could not parse the local feed file at ${feedPath}: ${error instanceof Error ? error.message : String(error)}. Provide a valid GitHub changelog RSS/XML file.`,
        { cause: error },
      );
    }
  } else {
    posts = await collectChangelog(range, options.feed, {
      limit,
      onArticlesDiscovered: async (total) => {
        sourcePreparationAnnounced = true;
        process.stderr.write(
          `Found ${total} changelog entries. Preparing local source copies before Copilot enrichment.\n`,
        );
        await trace.log("source_articles_discovered", { total });
      },
      onArticleProgress: async ({ completed, total, title, succeeded }) => {
        process.stderr.write(
          `${succeeded ? "Prepared" : "Failed"} source ${completed}/${total}: ${title}\n`,
        );
        await trace.log("source_article_prepared", {
          completed,
          total,
          title,
          succeeded,
        });
      },
    });
  }
  if (limit) posts = posts.slice(0, limit);
  if (!posts.length) {
    throw new Error(
      `No GitHub Copilot changelog entries were found from ${options.from} through ${options.to}. Expand the date range or verify the --feed source.`,
    );
  }

  if (sourcePreparationAnnounced) {
    process.stderr.write(
      `All ${posts.length} selected source articles are available locally. Starting content processing.\n`,
    );
  } else {
    process.stderr.write(
      `Found ${posts.length} changelog entries in the feed. Their content is ready for processing.\n`,
    );
  }
  await trace.log("source_preparation_completed", {
    articles: posts.length,
    source: options.feed ?? "GitHub Copilot changelog",
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
  };
  let checkpoint: CheckpointState | undefined;
  if (options.restart) {
    await removeCheckpoint(checkpointPath);
    process.stderr.write("Restarting from the first entry.\n");
    await trace.log("checkpoint_restarted", { path: checkpointPath });
  } else {
    try {
      checkpoint = await loadCheckpoint(checkpointPath);
    } catch (error) {
      throw new Error(
        `The previous checkpoint cannot be read. Use --restart to discard it. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await trace.log("checkpoint_loaded", {
      path: checkpointPath,
      found: Boolean(checkpoint),
      completed: checkpoint?.completed.length ?? 0,
    });
  }
  if (checkpoint && !checkpointMatches(checkpoint, checkpointConfig)) {
    process.stderr.write("Ignoring an incompatible checkpoint from a different configuration.\n");
    await removeCheckpoint(checkpointPath);
    checkpoint = undefined;
  }

  if (checkpoint) {
    const action = options.resume
      ? "resume"
      : await askExistingRunAction(checkpoint.completed.length, posts.length);
    if (action === "restart") {
      await removeCheckpoint(checkpointPath);
      checkpoint = undefined;
      process.stderr.write("Restarting from the first entry.\n");
      await trace.log("checkpoint_restarted", { path: checkpointPath });
    } else {
      process.stderr.write(`Resuming after ${checkpoint.completed.length} completed entries.\n`);
      await trace.log("checkpoint_resumed", {
        path: checkpointPath,
        completed: checkpoint.completed.length,
      });
    }
  }

  const state: CheckpointState = checkpoint ?? {
    version: 1,
    config: checkpointConfig,
    completed: [],
  };
  await saveCheckpoint(checkpointPath, state);
  const completedByUrl = new Map(state.completed.map((post) => [post.url, post]));
  const pendingPosts = posts.filter((post) => !completedByUrl.has(post.url));
  if (pendingPosts.length) {
    process.stderr.write(`Enriching ${pendingPosts.length}/${posts.length} articles.\n`);
    const { enrichWithCopilot } = await import("./enricher.js");
    const articlePositions = new Map(
      posts.map((post, index) => [post.url, index + 1]),
    );
    let checkpointWrite = Promise.resolve();
    await enrichWithCopilot(pendingPosts, {
      model: options.model,
      useAi: options.ai,
      slidesLanguage,
      speakerNotesLanguages,
      concurrency,
      requestTimeoutMs,
      progressOffset: state.completed.length,
      progressTotal: posts.length,
      progressForPost: (post) => articlePositions.get(post.url) ?? 0,
      trace: ({ event, ...data }) => trace.log(event, data),
      traceLogPath: tracePath,
      onPostEnriched: async (post) => {
        state.completed.push(post);
        checkpointWrite = checkpointWrite.then(() => saveCheckpoint(checkpointPath, state));
        await checkpointWrite;
        await trace.log("checkpoint_article_saved", {
          path: checkpointPath,
          title: post.title,
          completed: state.completed.length,
          total: posts.length,
        });
      },
    });
  }
  const allCompletedByUrl = new Map(state.completed.map((post) => [post.url, post]));
  const enriched = posts
    .map((post) => allCompletedByUrl.get(post.url))
    .filter((post): post is EnrichedPost => Boolean(post));
  const omittedPosts = posts.filter((post) => !allCompletedByUrl.has(post.url));
  const { writePresentation } = await import("./presentation.js");
  const presentationPath = await writePresentation(
    enriched,
    output,
    range.from,
    range.to,
    { slidesLanguage, speakerNotesLanguages },
  );
  process.stdout.write(`Presentation: ${presentationPath}\n`);
  if (options.website) {
    const { writeWebsite } = await import("./html.js");
    const websitePath = await writeWebsite(enriched, output, range.from, range.to);
    process.stdout.write(`Website: ${websitePath}\n`);
  }
  if (omittedPosts.length) {
    process.stderr.write(
      `Warning: ${omittedPosts.length} slide${omittedPosts.length === 1 ? "" : "s"} ${
        omittedPosts.length === 1 ? "was" : "were"
      } omitted after content review. The checkpoint was kept; resume this run to retry ${
        omittedPosts.length === 1 ? "it" : "them"
      } and rewrite the deck.\n`,
    );
    await trace.log("checkpoint_retained", {
      path: checkpointPath,
      completed: enriched.length,
      omitted: omittedPosts.length,
      omittedTitles: omittedPosts.map((post) => post.title),
    });
  } else {
    await removeCheckpoint(checkpointPath);
  }
  await trace.log("run_completed", {
    articles: enriched.length,
    omittedArticles: omittedPosts.length,
    presentationPath,
    websiteGenerated: options.website,
    checkpointRetained: omittedPosts.length > 0,
  });
  process.stdout.write(`Trace log: ${tracePath}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await trace.log("run_failed", { error: message });
    } catch (traceError) {
      throw new Error(
        `${message}\nTrace logging also failed at ${tracePath}: ${traceError instanceof Error ? traceError.message : String(traceError)}`,
        { cause: error },
      );
    }
    if (message.includes(`Trace log: ${tracePath}`)) throw error;
    throw new Error(`${message}\nTrace log: ${tracePath}`, { cause: error });
  }
  });
}

const today = new Date().toISOString().slice(0, 10);
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

async function showStartupStatus(): Promise<void> {
  if (process.stderr.isTTY) {
    const useColor = !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
    process.stderr.write(
      `${renderStartupBanner(packageMetadata.version, useColor, process.stderr.columns)}\n`,
    );
  } else {
    process.stderr.write(`Copilot Changelog CLI v${packageMetadata.version}\n`);
  }
  if (process.env.COPILOT_CHANGELOG_SKIP_UPDATE_CHECK === "1" || process.argv[2] === "update") return;
  try {
    const status = await updateCli(packageMetadata.version, {
      checkOnly: true,
      requestTimeoutMs: 3_000,
    });
    process.stderr.write(`Update status: ${status}\n`);
  } catch (error) {
    process.stderr.write(
      `Update status unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const program = new Command()
  .name("copilot-changelog")
  .description("Create a Copilot-enriched offline website and presentation from GitHub's Copilot changelog.")
  .version(packageMetadata.version)
  .option("--from <date>", "start date in YYYY-MM-DD", defaultFrom())
  .option("--to <date>", "end date in YYYY-MM-DD", today)
  .option("-o, --output <directory>", "output directory", "output")
  .option("-m, --model <model>", "Copilot model name", "auto")
  .addOption(new Option("--limit <count>", "maximum number of newest entries").argParser(String))
  .option("--feed <url-or-file>", "custom RSS URL or local fixture")
  .option("--slides-language <language>", "slide content language: en or it", "en")
  .option(
    "--speaker-notes-languages <languages>",
    "comma-separated speaker notes languages: en,it",
    "en",
  )
  .option("--website", "also create the offline website")
  .option("--resume", "resume a previous unfinished run without prompting")
  .option("--restart", "discard a previous unfinished run without prompting")
  .option("--verbose", "stream execution trace events to stderr (includes AI prompts and responses)")
  .option("--concurrency <count>", "articles enriched in parallel (1-8)", "1")
  .option("--request-timeout <seconds>", "maximum wait per Copilot response or initialization operation; timeouts are not retried automatically", "180")
  .option("--no-ai", "skip Copilot SDK enrichment (intended for testing)")
  .showHelpAfterError()
  .exitOverride();

program
  .command("version")
  .description("Print the installed CLI version")
  .action(() => {
    process.stdout.write(`${packageMetadata.version}\n`);
  });

program
  .command("update")
  .description("Update the CLI to the latest GitHub release")
  .option("--check", "check for an update without installing it")
  .action(async (options: { check?: boolean }) => {
    process.stdout.write(`${await updateCli(packageMetadata.version, { checkOnly: options.check })}\n`);
  });

program.action((options: CliOptions) => run(options));
showStartupStatus().then(() => program.parseAsync()).catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
