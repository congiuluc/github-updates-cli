#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command, CommanderError, Option } from "commander";
import { renderStartupBanner } from "./banner.js";
import { loadProfile } from "./profiles.js";
import { audiences } from "./generation.js";
import { defaultFrom, type CliOptions } from "./run-options.js";
import { updateCli } from "./updater.js";

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
  .description("Create a Copilot-enriched offline website and presentation from GitHub's Copilot changelog and selected RSS/Atom feeds.")
  .version(packageMetadata.version)
  .option("-f, --from <date>", "start date in YYYY-MM-DD", defaultFrom())
  .option("-t, --to <date>", "end date in YYYY-MM-DD", today)
  .option("-o, --output <directory>", "output directory", "output")
  .option("-m, --model <model>", "Copilot model name", "auto")
  .addOption(new Option("-l, --limit <count>", "maximum number of newest entries").argParser(String))
  .option("-F, --feed <url-or-file>", "replace the base changelog source with an RSS/Atom URL or local XML file")
  .option("-r, --rss <url-or-file...>", "add RSS/Atom URLs or local XML files to the selected sources (repeatable)", [])
  .option("-a, --include-ai-ml", "also collect GitHub Blog AI & ML articles", false)
  .option("-s, --slides-language <locale>", "slide locale (BCP 47), for example fr, pt-BR, zh-Hant or ar", "en")
  .option(
    "-n, --speaker-notes-languages <languages>",
    "comma-separated speaker-note locales, for example en,fr-CA,ja",
    "en",
  )
  .option("-w, --website", "also create the offline website", false)
  .option("-R, --resume", "resume a previous unfinished run without prompting")
  .option("-S, --restart", "discard a previous unfinished run without prompting")
  .option("-v, --verbose", "stream execution trace events to stderr (includes AI prompts and responses)")
  .option("-c, --concurrency <count>", "articles enriched in parallel (1-8)", "1")
  .option("-T, --request-timeout <seconds>", "maximum wait per Copilot response or initialization operation; timeouts are not retried automatically", "180")
  .option("-A, --no-ai", "skip Copilot SDK enrichment (intended for testing)")
  .option("-U, --ai", "enable AI enrichment, overriding a profile", true)
  .option("-g, --config <file>", "JSON profile configuration file")
  .option("-p, --profile <name>", "saved profile from --config or .copilot-changelog.json")
  .option("-d, --dry-run", "preview source selection as JSON without AI or briefing-state writes", false)
  .option("-i, --include <keyword...>", "include titles containing any keyword (case-insensitive)", [])
  .option("-x, --exclude <keyword...>", "exclude titles containing any keyword; exclusions win", [])
  .option("-b, --max-credits <credits>", "soft cumulative AI credit limit, including resumed attempts")
  .option("-u, --cache-dir <directory>", "accepted-content cache directory (default: output/.content-cache)")
  .option("-B, --no-cache", "do not read or write the accepted-content cache")
  .option("-K, --cache", "enable accepted-content reuse, overriding a profile", true)
  .option("-e, --export-json <file>", "also save editable, validated briefing content")
  .option("-j, --import-json <file>", "render an edited briefing JSON without fetching sources or calling AI")
  .option("-Q, --review-only", "write editable JSON and postpone PowerPoint/HTML export", false)
  .option("-H, --full-articles", "fetch full pages instead of embedded RSS/Atom text", false)
  .option("-Z, --no-full-articles", "use embedded feed text, overriding a profile")
  .option("-I, --since-last-run", "process new articles using durable incremental history", false)
  .option("-z, --state-dir <directory>", "incremental state directory (default: output/.briefing-state)")
  .addOption(new Option("-q, --audience <preset>", "writing preset").choices([...audiences]).default("standard"))
  .option("-E, --evidence", "require source quotations supporting generated fields", false)
  .option("-O, --no-evidence", "disable evidence collection, overriding a profile")
  .option("-G, --regenerate <url...>", "regenerate selected article URLs from --import-json", [])
  .option("-D, --regenerate-field <field...>", "regenerate only summary, notes, or details.KEY for selected URLs", [])
  .option("-N, --regenerate-language <language...>", "regenerate only an existing speaker-note language for selected URLs", [])
  .option("-M, --no-include-ai-ml", "disable the optional blog source, overriding a profile")
  .option("-W, --no-website", "disable HTML output, overriding a profile")
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
  .option("-k, --check", "check for an update without installing it")
  .action(async (options: { check?: boolean }) => {
    process.stdout.write(`${await updateCli(packageMetadata.version, { checkOnly: options.check })}\n`);
  });

program.action(async (options: CliOptions, command: Command) => {
  const profile = await loadProfile(options.config, options.profile);
  for (const [key, value] of Object.entries(profile)) {
    if (command.getOptionValueSource(key) !== "cli") command.setOptionValueWithSource(key, value, "config");
  }
  const configured = new Set(Object.keys(command.opts()).filter((key) =>
    ["cli", "config"].includes(command.getOptionValueSource(key) ?? "")));
  const { runBriefing } = await import("./workflow.js");
  await runBriefing(command.opts<CliOptions>(), configured);
});
showStartupStatus().then(() => program.parseAsync()).catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
