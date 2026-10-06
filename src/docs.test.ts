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
  const base = new URL("https://example.github.io/GitHub-Updates-CLI/");
  const assets = $("img[src], script[src], link[href]").toArray().map((element) =>
    $(element).attr("src") ?? $(element).attr("href")!);
  for (const asset of assets) {
    const url = new URL(asset, base);
    expect(url.origin).toBe(base.origin);
    expect(url.pathname).toMatch(/^\/GitHub-Updates-CLI\//);
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
  for (const id of ["sources", "review", "outputs", "resume", "timeouts", "updates",
    "troubleshooting", "development", "packaging", "github-pages", "security"]) {
    expect($(`#${id}`).text().trim().length).toBeGreaterThan(100);
  }
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

test("the concise README links to documentation topics that exist", async () => {
  expect(readme.trim().split("\n").length).toBeLessThanOrEqual(120);
  const topicLinks = [...readme.matchAll(/https:\/\/congiuluc\.github\.io\/GitHub-Updates-CLI\/#([a-z-]+)/g)];
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
