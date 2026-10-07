import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { load } from "cheerio";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const docsRoot = resolve(root, "docs");
const html = await readFile(resolve(docsRoot, "index.html"), "utf8");
const $ = load(html);
const readme = await readFile(resolve(root, "README.md"), "utf8");

test("documentation preserves unique and working navigation anchors", () => {
  const ids = $("[id]").toArray().map((element) => $(element).attr("id"));
  expect(new Set(ids).size).toBe(ids.length);
  const hashes = $('a[href^="#"]').toArray().map((element) => $(element).attr("href")!.slice(1));
  for (const id of hashes) expect(ids, `Missing anchor ${id}`).toContain(id);
  for (const id of ["features", "presentation", "install", "usage", "release"]) expect(ids).toContain(id);
  for (const section of $(".doc-section").toArray()) {
    const headingId = $(section).attr("aria-labelledby");
    expect(headingId, "Each documentation section needs an accessible heading").toBeTruthy();
    expect(ids).toContain(headingId);
  }
});

test("documentation assets resolve under a project Pages subpath", async () => {
  const base = new URL("https://example.github.io/github-updates-cli/");
  const assets = $("img[src], script[src], link[href]").toArray().map((element) =>
    $(element).attr("src") ?? $(element).attr("href")!);
  for (const asset of assets) {
    const url = new URL(asset, base);
    expect(url.origin).toBe(base.origin);
    expect(url.pathname).toMatch(/^\/github-updates-cli\//);
    const path = resolve(docsRoot, decodeURIComponent(url.pathname.slice(base.pathname.length)));
    const child = relative(docsRoot, path);
    expect(isAbsolute(child) || child.startsWith("..")).toBe(false);
    await expect(access(path)).resolves.toBeUndefined();
  }
});

test("all CLI options are documented in the complete guide", async () => {
  const cli = await readFile(resolve(root, "src", "cli.ts"), "utf8");
  const options = [...cli.matchAll(/(?:\.option\(|new Option\()\s*["']([^"']+)/g)]
    .flatMap((match) => match[1].match(/--[a-z][a-z-]*/g) ?? []);
  expect(options.length).toBeGreaterThanOrEqual(16);
  const reference = $("#cli-reference").text();
  for (const option of new Set(options)) expect(reference, `Missing ${option}`).toContain(option);
  for (const id of ["sources", "profiles-preview", "review", "review-content", "automation", "outputs", "resume", "timeouts", "updates",
    "troubleshooting", "development", "packaging", "github-pages", "security"]) {
    expect($(`#${id}`).text().trim().length).toBeGreaterThan(100);
  }
});

test("source documentation makes the blog opt-in and distinguishes additive RSS from replacement feeds", () => {
  const sourceGuide = $("#sources").text();
  expect(sourceGuide).toContain("AI & ML articles are disabled by default");
  expect(sourceGuide).toContain("--include-ai-ml");
  expect(sourceGuide).toContain("--rss");
  expect(sourceGuide).toContain("--feed replaces the base changelog");
  expect($("#cli-reference").text()).toContain("--rss <url-or-file...>");
  expect(readme).toContain("copilot-changelog --include-ai-ml");
});

test("extended workflow documentation explains safety and persistence boundaries", () => {
  expect($("#profiles-preview").text()).toContain("Arrays supplied on the CLI replace profile arrays");
  expect($("#profiles-preview").text()).toContain("downloads no article pages");
  expect($("#review-content").text()).toContain("not whether each claim logically follows from the quote");
  expect($("#outputs").text()).toContain("exits with code 2");
  expect($("#automation").text()).toContain("GitHub may evict it");
  expect($("#automation").text()).toContain("No command in this project registers the task automatically");
});
test("every declared option has a unique short alias documented with its long name", async () => {
  const cli = await readFile(resolve(root, "src", "cli.ts"), "utf8");
  const flags = [...cli.matchAll(/(?:\.option\(|new Option\()\s*["']([^"']+)/g)].map((match) => match[1]);
  const shortOptions: string[] = [];
  const rows = $("#cli-reference tr").toArray().map((row) => $(row).text());
  for (const flag of flags) {
    const match = /^(-[a-zA-Z]), (--[a-z][a-z-]*)/.exec(flag);
    expect(match, `Missing short alias: ${flag}`).not.toBeNull();
    if (!match) continue;
    const [, short, long] = match;
    shortOptions.push(short);
    expect(rows.some((row) => row.includes(`${short}, ${long}`)), `Missing documented pair: ${flag}`).toBe(true);
  }
  expect(new Set(shortOptions).size).toBe(shortOptions.length);
  expect(readme).toContain("case-sensitive");
  expect(readme).toContain("--from 2026-08-01 --to 2026-08-31");
});

test("distribution documentation distinguishes generated files, opted-in publication and manual review", () => {
  const guide = $("#distribution").text();
  for (const key of ["PUBLISH_WINGET", "PUBLISH_NPM", "PUBLISH_SCOOP", "PUBLISH_HOMEBREW",
    "WINGET_FORK", "WINGET_PACKAGE_ID", "WINGET_TOKEN", "SCOOP_BUCKET", "SCOOP_TOKEN", "HOMEBREW_TAP", "HOMEBREW_TOKEN"]) {
    expect(guide).toContain(key);
  }
  expect(guide).toContain("reviewable PRs, not automatic merges");
  expect(guide).toContain("No npm token is stored");
  expect(guide).toContain("workflow commit must equal the packaged release commit");
  expect(guide).toContain("identical open registry PR is reused");
  expect(guide).toContain("publicly downloadable without authentication");
});
test("documentation command examples use long options and describe unrestricted locale tags", () => {
  const samples = $("code").toArray().map((element) => $(element).text())
    .filter((text) => text.includes("copilot-changelog ") || text.includes("npm run dev --"));
  for (const sample of samples) expect(sample).not.toMatch(/(?:^|\s)-[A-Za-z](?:\s|$)/m);
  for (const line of readme.split("\n").filter((text) => text.startsWith("copilot-changelog "))) {
    expect(line).not.toMatch(/(?:^|\s)-[A-Za-z](?:\s|$)/);
  }
  expect($("#usage").text()).toContain("BCP 47");
  expect($("#usage").text()).toContain("not an English/Italian allowlist");
  expect($("#cli-reference").text()).toContain("fr-CA");
});
test("documentation has accessible fallbacks without JavaScript", () => {
  expect($("h1")).toHaveLength(1);
  expect($("main")).toHaveLength(1);
  expect($('a.skip-link[href="#main"]')).toHaveLength(1);
  expect($('label[for="docs-search"]')).toHaveLength(1);
  expect($("#contents").attr("open")).toBeDefined();
  expect($("#theme-toggle").attr("hidden")).toBeDefined();
  expect($("#search-box").attr("hidden")).toBeDefined();
  expect($(".doc-section[hidden]")).toHaveLength(0);
  for (const image of $("img").toArray()) {
    expect($(image).attr("alt")).toBeDefined();
    expect($(image).attr("width")).toBeTruthy();
    expect($(image).attr("height")).toBeTruthy();
  }
  for (const table of $("table").toArray()) expect($(table).find("caption").text()).not.toBe("");
});

test("management documentation explains update status and conservative stale-lock recovery", () => {
  expect($("#cli-reference").text()).toContain("-L, --status");
  expect($("#cli-reference").text()).toContain("copilot-changelog unlock <path>");
  expect($("#updates").text()).toContain("scheduled, not completed");
  expect($("#updates").text()).toContain("Get-Command copilot-changelog -All");
  expect($("#resume").text()).toContain("There is no force option");
  expect($("#resume").text()).toContain("Checkpoints and caches are never deleted");
});
test("installation and presentation guidance matches current authentication and validation behavior", () => {
  expect($("#install").text()).toContain("/login");
  expect($("#install").text()).toContain("Copilot Requests");
  expect($("#install").text()).not.toContain("gh auth refresh --scopes copilot");
  expect($("#presentation").text()).toContain("not a currently enforced word-count limit");
  expect($("#install").text()).toContain("Published packages may not yet contain every option");
  expect(readme).toContain("published releases may lag behind");
});

test("console documentation describes clickable output and color/plain-text behavior", () => {
  expect($("#outputs").text()).toContain("Open deck");
  expect($("#outputs").text()).toContain("Ctrl+click");
  expect($("#outputs").text()).toContain("same command with --resume");
  expect($("#outputs").text()).toContain("Review-only mode links to the editable JSON");
  expect($("#usage").text()).toContain("cyan for information");
  expect($("#timeouts").text()).toContain("Verbose JSON trace lines are never colored or rewritten");
  expect($("#timeouts").text()).toContain("WinGet-style block progress bar");
  expect($("#timeouts").text()).toContain("not a guessed percentage of a model response");
  expect($("#timeouts").text()).toContain("timer stops on completion");
  expect(readme).toContain("NO_COLOR");
});
test("printing includes sections hidden by topic navigation", async () => {
  const css = await readFile(resolve(docsRoot, "assets", "docs.css"), "utf8");
  expect(css).toMatch(/@media print\s*\{\s*\.doc-section\[hidden\]\s*\{\s*display:\s*block\s*!important;/);
  expect($("#contents summary").text()).toContain("Documentation topics");
});

test("first-attempt guidance documents shared limits without promising retry-free generation", () => {
  const review = $("#review").text();
  expect(review).toContain("only the assigned section");
  expect(review).toContain("exact hard word/character limits");
  expect(review).toContain("do not guarantee a valid first answer");
  expect(review).toContain("Retry and final-review limits are unchanged");
});
test("the concise README links to documentation topics that exist", async () => {
  expect(readme.trim().split("\n").length).toBeLessThanOrEqual(120);
  const topicLinks = [...readme.matchAll(/https:\/\/congiuluc\.github\.io\/github-updates-cli\/#([a-z-]+)/g)];
  expect(topicLinks.length).toBeGreaterThan(5);
  for (const [, id] of topicLinks) expect($(`#${id}`)).toHaveLength(1);
  const markup = load(readme);
  for (const image of markup("img[src]").toArray()) {
    const path = markup(image).attr("src")!;
    if (!path.startsWith("https://")) await expect(access(resolve(root, path))).resolves.toBeUndefined();
  }
  expect(readme).toContain("docs/index.html");
});

test("GitHub Pages deploys the full static documentation directory", async () => {
  const workflow = await readFile(resolve(root, ".github", "workflows", "pages.yml"), "utf8");
  expect(workflow).toContain('"docs/**"');
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("path: docs");
  expect(workflow).toContain("actions/deploy-pages@");
  const css = await readFile(resolve(docsRoot, "assets", "docs.css"), "utf8");
  expect(css).toContain("prefers-reduced-motion");
  expect(css).toContain(":focus-visible");
});

test("the maintainer guide links existing modules and describes the execution contracts", async () => {
  const guide = await readFile(resolve(root, "CONTRIBUTING.md"), "utf8");
  expect(readme).toContain("(CONTRIBUTING.md)");
  expect($("#development").text()).toContain("maintainer guide");
  for (const [, target] of guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(target)) continue;
    await expect(access(resolve(root, target))).resolves.toBeUndefined();
  }
  for (const contract of ["whole-invocation snapshots", "TMPDIR", "before the global",
    "not the package/release version", "Preserve all other accepted fields"]) {
    expect(guide).toContain(contract);
  }
});
