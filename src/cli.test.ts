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

function mockCopilotImport(recover: boolean): string {
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
      async start() {}
      async stop() {}
      async createSession() {
        let reject = false;
        return {
          async sendAndWait({prompt}) {
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
  await writeFile(feed, `<rss><channel>${["First article", "Second article"].map((title, index) => `
    <item><title>${title}</title><link>https://example.com/article-${index}</link><pubDate>2026-08-15</pubDate>
    <description>GitHub Copilot adds workflow guidance.</description></item>`).join("")}</channel></rss>`);
  const args = [
    resolve("src/cli.ts"), "--from", "2026-08-01", "--to", "2026-08-31",
    "--feed", feed, "--output", outputDirectory, "--website",
  ];
  const stem = "copilot-changelog-2026-08-01-to-2026-08-31";
  const checkpointPath = join(outputDirectory, `.${stem}.checkpoint.json`);
  const firstRun = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", mockCopilotImport(false), ...args,
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 30_000 });
  const state = JSON.parse(await readFile(checkpointPath, "utf8"));
  expect(state.config.useAi).toBe(true);
  expect(state.completed.map((post: { title: string }) => post.title)).toEqual(["Second article"]);
  expect(firstRun.stderr).toContain("1 slide was omitted");
  const countSlides = (zip: JSZip) => Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
  expect(countSlides(await JSZip.loadAsync(await readFile(join(outputDirectory, `${stem}.pptx`))))).toBe(4);
  expect(await readFile(join(outputDirectory, `${stem}.html`), "utf8")).not.toContain("First article");
  await expect(access(join(outputDirectory, `.${stem}.lock`))).rejects.toThrow();

  const resumedRun = await execFileAsync(process.execPath, [
    "--import", "tsx", "--import", mockCopilotImport(true), ...args, "--resume",
  ], { cwd: resolve("."), env: cliEnvironment, timeout: 30_000 });
  expect(resumedRun.stderr).toContain("Enriching 1/2 articles.");
  expect(countSlides(await JSZip.loadAsync(await readFile(join(outputDirectory, `${stem}.pptx`))))).toBe(6);
  const website = await readFile(join(outputDirectory, `${stem}.html`), "utf8");
  expect(website).toContain("First article");
  expect(website).toContain("Second article");
  await expect(access(checkpointPath)).rejects.toThrow();
  const trace = (await readFile(join(outputDirectory, `${stem}.trace.jsonl`), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  expect(trace.filter((event) => event.event === "article_processing_started" &&
    event.articleTitle === "Second article")).toHaveLength(1);
}, 65_000);

test.each([["--help"], ["--version"], ["version"], ["update", "--help"]])(
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
    expect(stdout).toContain(args.includes("--help") ? "Usage:" : version);
    if (args.length === 1 && args[0] === "--help") {
      expect(stdout).toMatch(/--concurrency <count>\s+articles enriched in parallel \(1-8\)\s+\(default: "1"\)/);
    }
  },
  25_000,
);

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
