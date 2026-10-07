import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import JSZip from "jszip";

const exec = promisify(execFile);
const sourceText = "VS Code is adding grouped agent sessions. Developers must enable the preview before use.";
const generated = {
  section: "IDE", summary: "Agent sessions keep related work organized and make review faster.",
  notes: ["Group related chats by task", "Review generated changes before merging"],
  details: {
    feature: "Grouped agent sessions", availability: "Rolling out in VS Code",
    keyCapabilities: "Organize chats, accelerate review, clarify navigation", howToUse: "Open Agents and group related sessions",
  },
  speakerNotes: { en: "Explain grouped sessions and the preview prerequisite.", it: "Spiegare le sessioni raggruppate e il prerequisito dell'anteprima." },
};
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "copilot-workflow-"));
  directories.push(root);
  const feed = join(root, "feed.xml");
  const log = join(root, "calls.jsonl");
  await writeFile(feed, `<rss><channel>${Array.from({ length: count }, (_, index) => `
    <item><title>Article ${index + 1}</title><link>https://example.com/article-${index + 1}</link>
    <pubDate>2026-08-${15 - index}</pubDate><description>${sourceText}</description></item>`).join("")}</channel></rss>`);
  return { root, feed, log, output: join(root, "output"), cache: join(root, "cache") };
}

function mockRuntime(log: string, mode: "normal" | "missing" | "regenerate" | "forbid" = "normal") {
  const sdk = `data:text/javascript,${encodeURIComponent(`
    import { appendFileSync } from "node:fs";
    if (${mode === "forbid"}) throw new Error("AI must not be called");
    export class CopilotClient {
      id = 0;
      async start() {}
      async stop() {}
      async createSession() {
        let handler;
        const client = this;
        return {
          on(callback) { handler = callback; return () => { handler = undefined; }; },
          async sendAndWait({prompt}) {
            appendFileSync(${JSON.stringify(log)}, JSON.stringify({prompt}) + "\\n");
            handler?.({ type: "assistant.usage", id: String(++client.id),
              data: { model: "mock", inputTokens: 10, outputTokens: 10,
                ${mode === "missing" ? "" : "copilotUsage: { totalNanoAiu: 250000000 }"} } });
            const result = ${JSON.stringify(generated)};
            const languages = /Speaker notes must contain exactly these language keys: ([^.]+)\\./.exec(prompt)?.[1].split(",").map(value => value.trim()) ?? ["en"];
            result.speakerNotes = Object.fromEntries(languages.map(locale => [locale,
              result.speakerNotes[locale] ?? (locale === "ja" ? "関連するセッションと利用条件を説明します。" :
                locale === "ar" ? "اشرح الجلسات المجمعة ومتطلبات الاستخدام." : "Présenter les sessions regroupées et les conditions de la préversion.")]));
            const localizationPrefix = "Also return localization using this exact key structure: ";
            const localizationLine = prompt.split("\\n\\n").find(line => line.startsWith(localizationPrefix));
            if (localizationLine) {
              result.localization = JSON.parse(localizationLine.slice(localizationPrefix.length, -1));
              if (result.localization.slides) {
                result.localization.articleTitle = "Sessions regroupées dans l'éditeur";
                result.localization.evidenceHeading = "Citations des sources pour la vérification humaine";
                result.summary = "Les développeurs regroupent leurs sessions et examinent les modifications avant validation.";
                result.details.keyCapabilities = "Améliore la navigation entre les tâches et conserve le contexte de chaque session";
                result.localization.slides.text = {
                  changelog: "GITHUB COPILOT - NOUVEAUTÉS", title: "Les nouveautés de Copilot",
                  update: "NOUVEAUTÉ", updates: "NOUVEAUTÉS", section: "SECTION",
                  sectionNames: { Models: "Modèles", "Enterprise Admins": "Administration", Announcements: "Annonces", IDE: "Éditeurs", Retirements: "Retraits" },
                  detailLabels: Object.fromEntries(Object.keys(result.localization.slides.text.detailLabels).map(key => [key, "CARTE " + key])),
                };
              }
              for (const [locale, notes] of Object.entries(result.localization.speakerNotes ?? {})) {
                notes.introduction = locale === "ja" ? "{from}から{to}までの{count}件の更新を紹介します。" :
                  locale === "ar" ? "يعرض الملخص {count} من التحديثات بين {from} و{to}." :
                  "Ce briefing présente {count} nouveautés du {from} au {to}.";
                notes.sections = Object.fromEntries(Object.keys(notes.sections).map(section => [section,
                  locale === "ja" ? "このカテゴリには{count}件の更新があります。" :
                    locale === "ar" ? "يتضمن هذا القسم {count} من التحديثات." : "Cette rubrique contient {count} nouveautés."]));
              }
            }
            if (${mode === "regenerate"}) {
              result.summary = "Developers can review grouped agent sessions while keeping each task's context together.";
              result.notes = ["Unrequested changes must be discarded", "Keep the accepted workflow notes"];
              result.speakerNotes.it = "Nuove note italiane per la presentazione.";
            }
            if (prompt.includes("Also return an evidence array")) {
              const url = /Use exactly this source URL: (https?:\\/\\/\\S+)\\./.exec(prompt)?.[1];
              result.evidence = ["summary", "notes.0", "notes.1",
                ...Object.keys(result.details).map(key => "details." + key),
                ...languages.map(language => "speakerNotes." + language)]
                .map(field => ({field, url, quote: ${JSON.stringify(sourceText)}}));
            }
            return { data: { content: JSON.stringify(result) } };
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

function run(log: string, args: string[], mode: Parameters<typeof mockRuntime>[1] = "normal") {
  return exec(process.execPath, ["--import", "tsx", "--import", mockRuntime(log, mode), resolve("src/cli.ts"), ...args], {
    cwd: resolve("."), env: { ...process.env, COPILOT_CHANGELOG_SKIP_UPDATE_CHECK: "1" }, timeout: 90_000,
  });
}
const dates = ["-f", "2026-08-01", "-t", "2026-08-31"];
const stem = "copilot-changelog-2026-08-01-to-2026-08-31";
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const calls = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

test("canonical locale tags round-trip with localized slide copy and multilingual introductory notes", async () => {
  const f = await fixture();
  const documentPath = join(f.root, "localized.json");
  await run(f.log, [
    ...dates, "--feed", f.feed, "--output", f.output, "--slides-language", "FR-ca",
    "--speaker-notes-languages", "fr-CA,ja,ar,FR-ca", "--export-json", documentPath, "--website",
  ]);
  const document = await json(documentPath);
  expect(document.settings.slidesLanguage).toBe("fr-CA");
  expect(document.settings.speakerNotesLanguages).toEqual(["fr-CA", "ja", "ar"]);
  expect(Object.keys(document.articles[0].speakerNotes)).toEqual(["fr-CA", "ja", "ar"]);
  expect(document.articles[0].localization.slides.locale).toBe("fr-CA");
  expect(document.articles[0].localization.articleTitle).toBe("Sessions regroupées dans l'éditeur");
  expect((await calls(f.log))[0].prompt).toContain("Write summary, notes, and detail values in Canadian French.");
  const deck = await JSZip.loadAsync(await readFile(join(f.output, `${stem}.pptx`)));
  expect(await deck.file("ppt/slides/slide1.xml")!.async("string")).toContain("Les nouveautés de Copilot");
  const notes = await deck.file("ppt/notesSlides/notesSlide1.xml")!.async("string");
  expect(notes).toContain("Ce briefing présente");
  expect(notes).toContain("更新を紹介します");
  expect(notes).toContain("يعرض الملخص");
  expect(notes).not.toContain("{count}");
  expect(notes).not.toContain("Welcome to the GitHub");
  const html = await readFile(join(f.output, `${stem}.html`), "utf8");
  expect(html).toContain('lang="fr-CA"');
  await run(f.log, ["--import-json", documentPath, "--output", join(f.root, "translated-export"),
    "--slides-language", "fr-ca", "--speaker-notes-languages", "FR-CA,ja,ar"], "forbid");
  expect(await calls(f.log)).toHaveLength(1);
}, 190_000);

test("profiles, explicit overrides and dry-run select Atom articles without AI or output state", async () => {
  const f = await fixture();
  const atom = join(f.root, "extra.atom");
  await writeFile(atom, `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/">
    <entry><title>Database release</title><link href="database"/><updated>2026-08-20T12:00:00Z</updated><summary>Database news.</summary></entry>
    <entry><title>Retired database release</title><link href="retired"/><updated>2026-08-21T12:00:00Z</updated><summary>Old database.</summary></entry>
    </feed>`);
  const config = join(f.root, "profiles.json");
  await writeFile(config, JSON.stringify({
    version: 1, defaults: { feed: "feed.xml", output: "output", includeAiMl: true },
    profiles: { team: { rss: ["extra.atom"], include: ["agent"], exclude: ["retired"], ai: true } },
  }));
  const result = await run(f.log, [...dates, "-g", config, "-p", "team", "-i", "database", "-M", "-d"], "forbid");
  const preview = JSON.parse(result.stdout);
  expect(preview.selected).toBe(1);
  expect(preview.entries).toContainEqual(expect.objectContaining({ title: "Database release", status: "selected" }));
  expect(preview.entries).toContainEqual(expect.objectContaining({ title: "Retired database release", status: "exclude-filter" }));
  await expect(access(f.output)).rejects.toThrow();
  await expect(access(f.log)).rejects.toThrow();
}, 100_000);

test("accepted content is reusable across dates and formats without new AI credits", async () => {
  const f = await fixture();
  const first = join(f.root, "first.json");
  await run(f.log, [...dates, "-F", f.feed, "-o", f.output, "-u", f.cache, "-q", "executive", "-E", "-e", first]);
  const original = await json(first);
  expect(original.articles[0].evidence).toHaveLength(8);
  expect((await calls(f.log))[0].prompt).toContain("Write for executives:");
  const second = join(f.root, "second.json");
  const reused = await run(f.log, [
    "-f", "2026-08-01", "-t", "2026-09-01", "-F", f.feed, "-o", f.output, "-u", f.cache,
    "-q", "executive", "-E", "-w", "-b", "0", "-e", second,
  ], "forbid");
  expect(reused.stderr).toContain("Reusing accepted content for 1");
  expect((await json(second)).usage.requests).toBe(0);
  expect(await calls(f.log)).toHaveLength(1);
  const website = await readFile(join(f.output, "copilot-changelog-2026-08-01-to-2026-09-01.html"), "utf8");
  expect(website).toContain("Source evidence");
  expect(website).toContain(sourceText);
}, 190_000);

test("review-only exports editable content, and offline import preserves edits without AI", async () => {
  const f = await fixture();
  const review = join(f.output, `${stem}.review.json`);
  await run(f.log, [...dates, "-F", f.feed, "-o", f.output, "-Q", "-n", "en,it"]);
  await expect(access(join(f.output, `${stem}.pptx`))).rejects.toThrow();
  const document = await json(review);
  document.articles[0].summary = "Developers can organize related agent sessions and inspect proposed changes before accepting them.";
  await writeFile(review, JSON.stringify(document));
  const exported = join(f.root, "edited.json");
  await run(f.log, ["-j", review, "-o", join(f.root, "edited"), "-w", "-e", exported], "forbid");
  expect((await json(exported)).articles[0].summary).toBe(document.articles[0].summary);
  expect(await calls(f.log)).toHaveLength(1);
  await access(join(f.root, "edited", `${stem}.pptx`));
  await access(join(f.root, "edited", `${stem}.html`));
}, 190_000);

test("credit limits pause and checkpoint the run, including cumulative cost after resume", async () => {
  const f = await fixture(2);
  const args = [...dates, "-F", f.feed, "-o", f.output, "-e", join(f.root, "content.json")];
  await expect(run(f.log, [...args, "-b", "0.25"])).rejects.toMatchObject({
    code: 2, stderr: expect.stringContaining("AI credit limit reached"),
  });
  const checkpoint = join(f.output, `.${stem}.checkpoint.json`);
  expect((await json(checkpoint)).completed).toHaveLength(1);
  expect((await json(checkpoint)).usage.totalNanoAiu).toBe(250_000_000);
  await expect(run(f.log, [...args, "-b", "0.25", "-R"], "forbid")).rejects.toMatchObject({ code: 2 });
  expect(await calls(f.log)).toHaveLength(1);
  await run(f.log, [...args, "-b", "0.5", "-R"]);
  expect(await calls(f.log)).toHaveLength(2);
  expect((await json(join(f.root, "content.json"))).usage.totalNanoAiu).toBe(500_000_000);
  await expect(access(checkpoint)).rejects.toThrow();
}, 280_000);

test("missing billing data pauses further budgeted calls without discarding accepted content", async () => {
  const f = await fixture(2);
  await expect(run(f.log, [...dates, "-F", f.feed, "-o", f.output, "-b", "1"], "missing"))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("credit usage is incomplete") });
  expect(await calls(f.log)).toHaveLength(1);
  expect((await json(join(f.output, `.${stem}.checkpoint.json`))).completed).toHaveLength(1);
}, 100_000);

test("targeted regeneration changes only selected article fields and speaker-note languages", async () => {
  const f = await fixture(2);
  const originalPath = join(f.root, "original.json");
  await run(f.log, [...dates, "-F", f.feed, "-o", f.output, "-n", "en,it", "-E", "-e", originalPath]);
  const original = await json(originalPath);
  original.articles[0].imageDataUri = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  await writeFile(originalPath, JSON.stringify(original));
  const revisedPath = join(f.root, "revised.json");
  await run(f.log, [
    "-j", originalPath, "-G", original.articles[0].url, "-D", "summary", "-N", "it",
    "-o", join(f.root, "revised"), "-e", revisedPath,
  ], "regenerate");
  const revised = await json(revisedPath);
  expect(revised.articles[0].summary).not.toBe(original.articles[0].summary);
  expect(revised.articles[0].speakerNotes.it).toBe("Nuove note italiane per la presentazione.");
  expect(revised.articles[0].speakerNotes.en).toBe(original.articles[0].speakerNotes.en);
  expect(revised.articles[0].notes).toEqual(original.articles[0].notes);
  expect(revised.articles[0].details).toEqual(original.articles[0].details);
  expect(revised.articles[0].imageDataUri).toBe(original.articles[0].imageDataUri);
  expect(revised.articles[1]).toEqual(original.articles[1]);
  expect(await calls(f.log)).toHaveLength(3);
}, 190_000);

test("incremental runs retain limited backlog and skip already delivered URLs", async () => {
  const f = await fixture(2);
  const args = [...dates, "-F", f.feed, "-o", f.output, "-A", "-I", "-R", "-l", "1"];
  await run(f.log, args, "forbid");
  const stateDir = join(f.output, ".briefing-state");
  const statePath = join(stateDir, (await readdir(stateDir)).find((name) => name.endsWith(".json"))!);
  expect((await json(statePath)).deliveredUrls).toEqual(["https://example.com/article-1"]);
  await run(f.log, args, "forbid");
  expect((await json(statePath)).deliveredUrls).toHaveLength(2);
  const empty = await run(f.log, args, "forbid");
  expect(empty.stdout).toContain("No new matching articles");
  expect((await json(statePath)).pending).toBeUndefined();
  await expect(access(f.log)).rejects.toThrow();
}, 280_000);
