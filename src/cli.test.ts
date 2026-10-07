import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, expect, test } from "vitest";
import { withRunLock } from "./checkpoint.js";

const execFileAsync = promisify(execFile);
const offlineImport = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("", { status: 404 });')}`;
const cliEnvironment = {
  ...process.env,
  COPILOT_CHANGELOG_SKIP_UPDATE_CHECK: "1",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${offlineImport}`,
};
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
let outputDirectory: string | undefined;

function mockCopilotImport(recover: boolean, usage: "reported" | "missing" | "failure" = "reported"): string {
  const generated = {
    section: "Announcements",
    summary: "GitHub Copilot improves workflows while giving teams clearer operational guidance.",
    notes: ["Review the announced workflow changes", "Confirm availability for affected Copilot users"],
    details: {
      announcement: "Copilot introduces clearer workflow guidance for development teams",
      availability: "Available to the Copilot users identified in the announcement",
      impact: "Clarifies expected workflows and helps teams prepare the required adoption steps",
      audience: "Developers and administrators using the affected GitHub Copilot capabilities",
    },
    speakerNotes: { en: [
      "This update improves how developers organize agent work inside the editor.",
      "Explain that related sessions can remain grouped, which makes context easier to find and review.",
      "Highlight the rollout status and the supported editor before demonstrating the workflow.",
      "Then show how to open the Agents view, group related sessions, and inspect generated changes before merging.",
      "The practical takeaway is faster review with less navigation overhead.",
      "Remind the audience to confirm availability for their current channel and organizational policy before adopting the feature.",
    ].join(" ") },
  };
  const sdk = `data:text/javascript,${encodeURIComponent(`
    export class CopilotClient {
      callId = 0;
      async start() {}
      async stop() {}
      async createSession() {
        let reject = false;
        let handler;
        const client = this;
        return {
          on(callback) {
            handler = callback;
            return () => { handler = undefined; };
          },
          async sendAndWait({prompt}) {
            if (${usage !== "missing"}) handler?.({
              type: "assistant.usage", id: String(++client.callId),
              data: { model: "mock-model", inputTokens: 100, outputTokens: 20,
                copilotUsage: { totalNanoAiu: 250000000 } },
            });
            if (${usage === "failure"}) throw new Error("Timeout after 180000ms waiting for session.idle");
            if (prompt.includes("Title: First article")) reject = true;
            return { data: { content: reject && !${recover} ? "{}" : ${JSON.stringify(JSON.stringify(generated))} } };
          },
          async abort() {},
          async disconnect() {},
        };
      }
    }
  `)}`;
  const loader = `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "@github/copilot-sdk") return { url: ${JSON.stringify(sdk)}, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `)}`;
  return `data:text/javascript,${encodeURIComponent(`
    import { register } from "node:module";
    register(${JSON.stringify(loader)});
    globalThis.fetch = async () => new Response("", { status: 404 });
  `)}`;
}

test("rejects a second CLI process before --restart can touch an active run", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-cli-locked-"));
  const stem = ".copilot-changelog-2026-08-01-to-2026-08-31";
  const checkpoint = join(outputDirectory, `${stem}.checkpoint.json`);
  await writeFile(checkpoint, "accepted progress");
  await withRunLock(join(outputDirectory, `${stem}.lock`), async () => {
    await expect(execFileAsync(process.execPath, [
      "--import", "tsx", resolve("src/cli.ts"),
      "--from", "2026-08-01", "--to", "2026-08-31",
      "--feed", resolve("test/fixtures/feed.xml"), "--restart", "--no-ai",
      "--output", outputDirectory!,
    ], { cwd: resolve("."), env: cliEnvironment, timeout: 20_000 })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("already running"),
    });
    expect(await readFile(checkpoint, "utf8")).toBe("accepted progress");
  });
}, 25_000);

test("writes a partial AI deck, preserves accepted slides, and adds a rejected slide on resume", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-ai-resume-"));
  const feed = join(outputDirectory, "feed.xml");
  await writeFile(feed, `<rss><channel>${["First article"].map((title, index) => `
    <item><title>${title}</title><link>https://example.com/article-${index}</link><pubDate>2026-08-15</pubDate>
    <description>GitHub Copilot adds workflow guidance.</description></item>`).join("")}</channel></rss>`);
  const additionalFeed = join(outputDirectory, "additional.xml");
  await writeFile(additionalFeed, `<rss><channel><item><title>Second article</title>
    <link>https://example.com/article-1</link><pubDate>2026-08-15</pubDate>
    <description>GitHub Copilot adds workflow guidance.</description></item></channel></rss>`);
  const args = [
    resolve("src/cli.ts"), "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", feed, "--rss", additionalFeed, "--output", outputDirectory, "--website",
  ];
  const stem = "copilot-changelog-2026-08-01-to-2026-08-31";
  const checkpointPath = join(outputDirectory, `.${stem}.checkpoint.json`);
  const firstRun = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", mockCopilotImport(false), ...args,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 60_000 });
  const state = JSON.parse(await readFile(checkpointPath, "utf8"));
  expect(state.config.useAi).toBe(true);
  expect(state.completed.map((post: { title: string }) => post.title)).toEqual(["Second article"]);
  expect(firstRun.stderr).toContain("1 slide was omitted");
  expect(firstRun.stderr).toContain("AI credits: 1.5 (reported)");
  expect(state.usage).toMatchObject({ requests: 6, creditReports: 6, totalNanoAiu: 1_500_000_000 });
  const countSlides = (zip: JSZip) => Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
  expect(countSlides(await JSZip.loadAsync(await readFile(join(outputDirectory, `${stem}.pptx`))))).toBe(4);
  expect(await readFile(join(outputDirectory, `${stem}.html`), "utf8")).not.toContain("First article");
  await expect(access(join(outputDirectory, `.${stem}.lock`))).rejects.toThrow();

  const resumedRun = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", mockCopilotImport(true), ...args, "-R",
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 60_000 });
  expect(resumedRun.stderr).toContain("Enriching 1/2 articles.");
  expect(resumedRun.stderr).toContain("AI credits: 1.75 (reported). Includes previous attempts");
  expect(resumedRun.stderr).toContain("This execution: AI credits: 0.25 (reported)");
  expect(countSlides(await JSZip.loadAsync(await readFile(join(outputDirectory, `${stem}.pptx`))))).toBe(6);
  const website = await readFile(join(outputDirectory, `${stem}.html`), "utf8");
  expect(website).toContain("First article");
  expect(website).toContain("Second article");
  await expect(access(checkpointPath)).rejects.toThrow();
  const trace = (await readFile(join(outputDirectory, `${stem}.trace.jsonl`), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  expect(trace.filter((event) => event.event === "article_processing_started" &&
    event.articleTitle === "Second article")).toHaveLength(1);
  expect(trace.at(-1).totalUsage.totalNanoAiu).toBe(1_750_000_000);
}, 125_000);

test.each([false, true])("adds multiple --rss sources with AI & ML opt-in=%s", async (includeAiMl) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-sources-"));
  const requestLog = join(outputDirectory, "requests.jsonl");
  const localFeed = join(outputDirectory, "local.xml");
  const rss = (title: string, url: string, date: string) => `<rss><channel><item>
    <title>${title}</title><link>${url}</link><pubDate>${date}</pubDate>
    <description>Readable source news with practical details.</description></item></channel></rss>`;
  await writeFile(localFeed, rss("Local release", "https://example.com/local", "2026-08-19"));
  const remoteFeed = "https://example.com/rss";
  const duplicateFeed = "https://example.org/rss";
  const networkImport = `data:text/javascript,${encodeURIComponent(`
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (input) => {
      const url = String(input);
      appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(url) + "\\n");
      if (url.includes("opened-months")) return new Response(${JSON.stringify(
        `<changelog-month data-loaded="true"><article><time datetime="2026-08-18"></time>
          <a class="ChangelogItem-title" href="https://example.com/base">Base change</a></article></changelog-month>`,
      )});
      if (url.includes("/wp-json/")) {
        if (!${includeAiMl}) throw new Error("Unexpected blog request without --include-ai-ml");
        return new Response(${JSON.stringify(JSON.stringify([{
          title: { rendered: "Optional blog" }, link: "https://example.com/blog", date_gmt: "2026-08-21T12:00:00",
        }]))});
      }
      if (url === ${JSON.stringify(remoteFeed)}) return new Response(${JSON.stringify(rss("Database release", "https://example.com/news", "2026-08-20"))});
      if (url === ${JSON.stringify(duplicateFeed)}) return new Response(${JSON.stringify(rss("Duplicate article", "https://example.com/news/?utm_source=rss#intro", "2026-08-20"))});
      if (url === "https://example.com/base" || url === "https://example.com/blog")
        return new Response("<article>Readable article content.</article>");
      if (url === "https://example.com/news" || url === "https://example.com/local")
        return new Response("", { status: 404 });
      throw new Error("Unexpected network request: " + url);
    };
  `)}`;
  const { stdout } = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", networkImport, resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--rss", remoteFeed, localFeed, "--rss", duplicateFeed,
    "--limit", "3", "--no-ai", "--website", "--output", outputDirectory,
    ...(includeAiMl ? ["-a"] : []),
  ], {
    cwd: resolve("."), env: { ...cliEnvironment, TEMP: outputDirectory, TMP: outputDirectory },
    timeout: 60_000,
  });
  expect(stdout).toContain("Presentation:");
  expect(stdout).toContain("Website:");
  const stem = "copilot-changelog-2026-08-01-to-2026-08-31";
  const trace = (await readFile(join(outputDirectory, `${stem}.trace.jsonl`), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  expect(trace[0]).toMatchObject({ rss: [remoteFeed, localFeed, duplicateFeed], includeAiMl });
  const titles = trace.filter((entry) => entry.event === "article_processing_started")
    .map((entry) => entry.articleTitle);
  expect(titles).toEqual(includeAiMl
    ? ["Optional blog", "Database release", "Local release"]
    : ["Database release", "Local release", "Base change"]);
  const requests: string[] = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(requests.some((url) => url.includes("/wp-json/"))).toBe(includeAiMl);
  expect(requests.some((url) => url.includes("opened-months"))).toBe(true);
  expect(requests).toContain(remoteFeed);
  expect(requests).toContain(duplicateFeed);
}, 65_000);

test("reports a missing --rss file instead of generating a partial selection", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-missing-rss-"));
  const missingFeed = join(outputDirectory, "missing.xml");
  await expect(execFileAsync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", resolve("test/fixtures/feed.xml"), "--rss", missingFeed,
    "--no-ai", "--output", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 30_000 })).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining(`Could not read the local feed file at ${missingFeed}`),
  });
  await expect(access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx"))).rejects.toThrow();
}, 35_000);

test.each(["missing", "failure"] as const)("reports %s AI usage and persists it on failure", async (usage) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-usage-"));
  const feed = join(outputDirectory, "feed.xml");
  await writeFile(feed, `<rss><channel><item><title>Second article</title>
    <link>https://example.com/article</link><pubDate>2026-08-15</pubDate>
    <description>GitHub Copilot adds workflow guidance.</description></item></channel></rss>`);
  const args = [
    "--import", "tsx", "--import", mockCopilotImport(true, usage), resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", feed, "--output", outputDirectory,
  ];
  const operation = execFileAsync(process.execPath, args, { cwd: resolve("."), env: cliEnvironment, timeout: 30_000 });
  if (usage === "missing") {
    expect((await operation).stderr).toContain("AI credits: unavailable");
  } else {
    await expect(operation).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("AI credits: at least 0.25 (reported; incomplete usage data)"),
    });
    const path = join(outputDirectory, ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json");
    expect(JSON.parse(await readFile(path, "utf8")).usage).toMatchObject({
      requests: 1, totalNanoAiu: 250_000_000, historyIncomplete: true,
    });
    const resumed = await execFileAsync(process.execPath, [
      "--import", "tsx", "--import", mockCopilotImport(true), ...args.slice(4), "--resume",
    ], { cwd: resolve("."), env: cliEnvironment, timeout: 30_000 });
    expect(resumed.stderr).toContain("AI credits: at least 0.5 (reported; incomplete usage data)");
  }
}, 65_000);

test.each([false, true])("uses compact concurrent progress in TTY unless verbose=%s", async (verbose) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-tty-"));
  const feed = join(outputDirectory, "feed.xml");
  await writeFile(feed, `<rss><channel>${["First article", "Second article"].map((title, index) => `
    <item><title>${title}</title><link>https://example.com/article-${index}</link><pubDate>2026-08-15</pubDate>
    <description>GitHub Copilot adds workflow guidance.</description></item>`).join("")}</channel></rss>`);
  const ttyImport = `data:text/javascript,${encodeURIComponent(`
    Object.defineProperties(process.stderr, {
      isTTY: { value: true }, columns: { value: 120 }, rows: { value: 24 },
    });
  `)}`;
  const { stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", mockCopilotImport(true), "--import", ttyImport,
    resolve("src/cli.ts"), "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", feed, "--output", outputDirectory, "--concurrency", "2",
    ...(verbose ? ["--verbose"] : []),
  ], { cwd: resolve("."), env: { ...cliEnvironment, NO_COLOR: "1" }, timeout: 30_000 });
  if (verbose) {
    expect(stderr).not.toContain("\x1b[");
    expect(stderr).toContain('"event":"copilot_attempt_started"');
  } else {
    expect(stderr).toContain("\x1b[J");
    expect(stderr).toContain("Worker 1: attempt 1 - First article");
    expect(stderr).toContain("Worker 2: attempt 1 - Second article");
    expect(stderr).toContain("2/2 (100%)");
    expect(stderr).not.toContain("Starting 1/2");
    expect(stderr).not.toContain("Completed 1/2");
  }
  expect(stderr).toContain("AI credits: 0.5 (reported)");
}, 35_000);

test.each(["resume", "restart"] as const)("handles legacy credit history on --%s", async (action) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-legacy-usage-"));
  const feed = join(outputDirectory, "feed.xml");
  const url = "https://example.com/article";
  await writeFile(feed, `<rss><channel><item><title>Second article</title><link>${url}</link>
    <pubDate>2026-08-15</pubDate><description>GitHub Copilot adds workflow guidance.</description></item></channel></rss>`);
  const checkpointPath = join(outputDirectory, ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json");
  await writeFile(checkpointPath, JSON.stringify({
    version: 1, completed: [],
    config: { contentVersion: 6, postUrls: [url], model: "auto", useAi: true, slidesLanguage: "en", speakerNotesLanguages: ["en"] },
  }));
  const { stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", mockCopilotImport(true), resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", feed, "--output", outputDirectory, `--${action}`,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 30_000 });
  expect(stderr).toContain(action === "resume"
    ? "AI credits: at least 0.25 (reported; incomplete usage data)"
    : "AI credits: 0.25 (reported)");
}, 35_000);

test.each([["--help"], ["-h"], ["--version"], ["-V"], ["version"], ["update", "--help"], ["update", "-h"]])(
  "handles %j without loading generation dependencies",
  async (...args) => {
    const loader = `data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "@github/copilot-sdk") throw new Error("Unexpected SDK import");
        const result = await nextResolve(specifier, context);
        if (/\\/(collector|enricher|presentation|html)\\.(ts|js)$/.test(result.url)) {
          throw new Error("Unexpected generation import: " + result.url);
        }
        return result;
      }
    `)}`;
    const register = `data:text/javascript,${encodeURIComponent(`
      import { register } from "node:module";
      register(${JSON.stringify(loader)});
    `)}`;
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", register, "--import", "tsx", resolve("src/cli.ts"), ...args,
    ], { cwd: resolve("."), env: cliEnvironment, timeout: 20_000 });
    expect(stdout).toContain(args.includes("--help") || args.includes("-h") ? "Usage:" : version);
    if (args.length === 1 && args[0] === "--help") {
      expect(stdout).toMatch(/--concurrency <count>\s+articles enriched in parallel \(1-8\)\s+\(default: "1"\)/);
    }
  },
  25_000,
);

test("short options preserve source selection, language settings, outputs and validation", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-short-options-"));
  const feed = resolve("test/fixtures/feed.xml");
  const extra = join(outputDirectory, "extra.xml");
  await writeFile(extra, `<rss><channel><item><title>Additional news</title>
    <link>https://example.com/extra</link><pubDate>2026-08-14</pubDate>
    <description>Extra source content.</description></item></channel></rss>`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"),
    "-f", "2026-08-01", "-t", "2026-08-31", "-F", feed,
    "-r", extra, "-r", extra, "-l", "1", "-m", "auto",
    "-s", "it", "-n", "en,it", "-w", "-v", "-c", "2", "-T", "90",
    "-A", "-S", "-o", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 60_000 });
  expect(stdout).toContain("Presentation:");
  expect(stdout).toContain("Website:");
  expect(stderr).toContain("Restarting from the first entry.");
  const stem = "copilot-changelog-2026-08-01-to-2026-08-31";
  const lines = (await readFile(join(outputDirectory, `${stem}.trace.jsonl`), "utf8")).trim().split("\n");
  const events = lines.map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({
    from: "2026-08-01", to: "2026-08-31", feed, rss: [extra, extra],
    limit: 1, model: "auto", useAi: false, includeAiMl: false,
    slidesLanguage: "it", speakerNotesLanguages: "en,it", concurrency: "2", requestTimeoutMs: 90_000,
  });
  expect(stderr.split(/\r?\n/).filter((line) => line.startsWith('{"timestamp":'))).toEqual(lines);
  expect(events.filter((event) => event.event === "article_processing_started")).toHaveLength(1);
  await access(join(outputDirectory, `${stem}.pptx`));
  await access(join(outputDirectory, `${stem}.html`));
  await expect(execFileAsync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"), "-R", "-S",
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 20_000 })).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining("--resume and --restart cannot be used together"),
  });
}, 90_000);

test.each(["-k", "--check"])("update %s only checks and never installs", async (flag) => {
  const updater = `data:text/javascript,${encodeURIComponent(`
    export async function updateCli(version, options) {
      if (options?.checkOnly !== true) throw new Error("Unexpected installation");
      return "Check-only update verified";
    }
  `)}`;
  const loader = `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      const resolved = await nextResolve(specifier, context);
      if (/\\/src\\/updater\\.(ts|js)(?:\\?.*)?$/.test(resolved.url)) {
        return { url: ${JSON.stringify(updater)}, shortCircuit: true };
      }
      return resolved;
    }
  `)}`;
  const register = `data:text/javascript,${encodeURIComponent(`
    import { register } from "node:module";
    register(${JSON.stringify(loader)});
  `)}`;
  const { stdout } = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", register, resolve("src/cli.ts"), "update", flag,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 20_000 });
  expect(stdout.trim()).toBe("Check-only update verified");
}, 25_000);

afterEach(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

test.each(["0", "1.5", "180s", "2147484"])("rejects invalid request timeout %s before generation", async (timeout) => {
  await expect(execFileAsync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"), "--request-timeout", timeout,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 20_000 })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Invalid --request-timeout"),
  });
}, 25_000);

test.each([
  ["--limit", "1garbage"], ["--limit", "1.5"], ["--limit", "1e3"],
  ["--limit", "9007199254740992"], ["--concurrency", "1.9"], ["--concurrency", "2workers"],
])("rejects invalid integer option %s %s before source downloads", async (option, value) => {
  await expect(execFileAsync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"), option, value,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 20_000 })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(`Invalid ${option}`),
  });
}, 25_000);

test.each([
  [["--version"], version],
  [["version"], version],
])("prints the installed version for %j", async (args, expected) => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli.ts"), ...args],
    { cwd: resolve("."), env: cliEnvironment },
  );
  expect(stdout.trim()).toBe(expected);
  expect(stderr).toContain(`Copilot Changelog CLI v${expected}`);
}, 10_000);

test(
  "--no-ai generates only the presentation by default",
  async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-cli-"));
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("src/cli.ts"),
        "--from",
        "2026-08-01",
        "--to",
        "2026-08-31",
        "--feed",
        resolve("test/fixtures/feed.xml"),
        "--no-ai",
        "--output",
        outputDirectory,
      ],
      { cwd: resolve("."), env: cliEnvironment },
    );

    expect(stdout).toContain("Presentation:");
    expect(stdout).toContain("Trace log:");
    expect(stdout).not.toContain("Website:");
    expect(stderr).not.toContain('"event":');
    expect(stderr).toContain("Sequential enrichment: 1 worker");
    await access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx"));
    const trace = await readFile(
      join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.trace.jsonl"),
      "utf8",
    );
    expect(trace).toContain('"event":"run_started"');
    expect(trace).toContain('"requestTimeoutMs":180000');
    expect(trace).toContain('"concurrency":"1"');
    expect(trace).toContain('"event":"run_completed"');
    await expect(
      access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.html")),
    ).rejects.toThrow();
  },
  10_000,
);

test(
  "website and language options are opt-in",
  async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-cli-"));
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("src/cli.ts"),
        "--from",
        "2026-08-01",
        "--to",
        "2026-08-31",
        "--feed",
        resolve("test/fixtures/feed.xml"),
        "--no-ai",
        "--website",
        "--slides-language",
        "it",
        "--speaker-notes-languages",
        "en,it",
        "--output",
        outputDirectory,
      ],
      { cwd: resolve("."), env: cliEnvironment },
    );

    expect(stdout).toContain("Presentation:");
    expect(stdout).toContain("Website:");
    await Promise.all([
      access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.html")),
      access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx")),
    ]);
  },
  10_000,
);

test("--verbose mirrors execution events to stderr without changing stdout or the trace file", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-verbose-"));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", resolve("test/fixtures/feed.xml"), "--no-ai", "--verbose",
    "--request-timeout", "90",
    "--output", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 50_000 });

  const trace = await readFile(
    join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.trace.jsonl"), "utf8",
  );
  const events = stderr.split(/\r?\n/).filter((line) => line.startsWith('{"timestamp":'));
  expect(events).toEqual(trace.trim().split("\n"));
  expect(events[0]).toContain('"event":"run_started"');
  expect(events[0]).toContain('"requestTimeoutMs":90000');
  expect(events.at(-1)).toContain('"event":"run_completed"');
  expect(stdout).toContain("Presentation:");
  expect(stdout).not.toContain('"event":');
}, 60_000);

test("--verbose also exposes failure events during execution", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-verbose-failure-"));
  await expect(execFileAsync(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli.ts"),
    "--feed", join(outputDirectory, "missing.xml"), "--no-ai", "--verbose",
    "--output", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 50_000 })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('"event":"run_failed"'),
  });
}, 60_000);

test("--resume reuses completed entries and removes the checkpoint after success", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-cli-"));
  const checkpointPath = join(
    outputDirectory,
    ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json",
  );
  await writeFile(checkpointPath, JSON.stringify({
    version: 1,
    config: {
      contentVersion: 6,
      postUrls: ["https://github.blog/changelog/2026-08-15-copilot-model-controls"],
      model: "auto",
      useAi: false,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
    },
    completed: [{
      title: "Copilot model controls arrive in the IDE",
      url: "https://github.blog/changelog/2026-08-15-copilot-model-controls",
      publishedAt: "2026-08-15T10:00:00.000Z",
      plainText: "Developers can now select models directly in their editor.",
      html: "<p>Developers can now select models directly in their editor.</p>",
      imageUrls: [],
      links: [],
      section: "Models",
      summary: "Developers can choose models directly in their editor.",
      notes: ["Choose a model per task", "Document preferred team models"],
      details: {
        modelName: "Copilot model controls",
        availability: "Available in supported IDEs",
        keyCapabilities: "Select models and standardize team workflows",
        useGuidance: "Use approved models for common coding tasks",
      },
      speakerNotes: { en: "Explain how model controls support consistent team workflows." },
    }],
  }));

  const { stderr } = await execFileAsync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("src/cli.ts"),
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-31",
      "--feed",
      resolve("test/fixtures/feed.xml"),
      "--no-ai",
      "--resume",
      "--output",
      outputDirectory,
    ],
    { cwd: resolve("."), env: cliEnvironment },
  );

  expect(stderr).toContain("Resuming after 1 completed entries.");
  expect(stderr).not.toContain("Enriching 1/1");
  await expect(access(checkpointPath)).rejects.toThrow();
  await access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx"));
}, 10_000);

test("--resume retries an omitted slide and removes the checkpoint after adding it", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-resume-omitted-"));
  const checkpointPath = join(
    outputDirectory,
    ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json",
  );
  await writeFile(checkpointPath, JSON.stringify({
    version: 1,
    config: {
      contentVersion: 6,
      postUrls: ["https://github.blog/changelog/2026-08-15-copilot-model-controls"],
      model: "auto",
      useAi: false,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
    },
    completed: [],
  }));

  const { stderr } = await execFileAsync(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"),
    resolve("src/cli.ts"),
    "--from", "2026-08-01",
    "--to", "2026-08-31",
    "--feed", resolve("test/fixtures/feed.xml"),
    "--no-ai",
    "--resume",
    "--output", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment });

  expect(stderr).toContain("Resuming after 0 completed entries.");
  expect(stderr).toContain("Enriching 1/1 articles.");
  await expect(access(checkpointPath)).rejects.toThrow();
  await access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx"));
}, 10_000);

test("--restart discards completed entries and begins from the first article", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-cli-"));
  const checkpointPath = join(
    outputDirectory,
    ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json",
  );
  await writeFile(checkpointPath, JSON.stringify({
    version: 1,
    config: {
      contentVersion: 6,
      postUrls: ["https://github.blog/changelog/2026-08-15-copilot-model-controls"],
      model: "auto",
      useAi: false,
      slidesLanguage: "en",
      speakerNotesLanguages: ["en"],
    },
    completed: [],
  }));

  const { stderr } = await execFileAsync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("src/cli.ts"),
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-31",
      "--feed",
      resolve("test/fixtures/feed.xml"),
      "--no-ai",
      "--restart",
      "--output",
      outputDirectory,
    ],
    { cwd: resolve("."), env: cliEnvironment },
  );

  expect(stderr).toContain("Restarting from the first entry.");
  expect(stderr).toContain("Enriching 1/1");
  await expect(access(checkpointPath)).rejects.toThrow();
}, 10_000);

test.each([
  "{not-json",
  "null",
  JSON.stringify({
    version: 1,
    config: {
      contentVersion: 6,
      postUrls: ["https://github.blog/changelog/2026-08-15-copilot-model-controls"],
      model: "auto", useAi: false, slidesLanguage: "en",
    },
    completed: [],
  }),
])("--restart discards malformed checkpoints without parsing them: %s", async (content) => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-restart-"));
  const checkpointPath = join(outputDirectory, ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json");
  await writeFile(checkpointPath, content);
  const { stderr } = await execFileAsync(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", resolve("test/fixtures/feed.xml"), "--no-ai", "--restart",
    "--output", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment });
  expect(stderr).toContain("Restarting from the first entry.");
  await expect(access(checkpointPath)).rejects.toThrow();
  await access(join(outputDirectory, "copilot-changelog-2026-08-01-to-2026-08-31.pptx"));
}, 10_000);

test("--resume preserves an invalid checkpoint and reports the recovery option", async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "copilot-changelog-invalid-resume-"));
  const checkpointPath = join(outputDirectory, ".copilot-changelog-2026-08-01-to-2026-08-31.checkpoint.json");
  const content = JSON.stringify({ version: 1, config: { postUrls: [] }, completed: [] });
  await writeFile(checkpointPath, content);
  await expect(execFileAsync(process.execPath, [
    resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/cli.ts"),
    "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", resolve("test/fixtures/feed.xml"), "--no-ai", "--resume",
    "--output", outputDirectory,
  ], { cwd: resolve("."), env: cliEnvironment })).rejects.toMatchObject({
    stderr: expect.stringContaining("Use --restart to discard it."),
  });
  expect(await readFile(checkpointPath, "utf8")).toBe(content);
}, 10_000);
