import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildArchiveUrl,
  buildAiBlogApiUrl,
  canonicalArticleUrl,
  collectChangelog,
  discoverChangelog,
  monthSlugsForRange,
  parseAiBlogApiPage,
  parseArchivePage,
  parseChangelogFeed,
  prepareChangelog,
} from "./collector.js";

const fixtureDirectory = () => mkdtemp(join(process.cwd(), ".collector-test-"));
const august = { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-31T23:59:59Z") };
const rssItem = (title: string, url: string, day: number, body = "Readable feed content.") =>
  `<item><title>${title}</title><link>${url.replace(/&/g, "&amp;")}</link>
  <pubDate>2026-08-${String(day).padStart(2, "0")}</pubDate><description>${body}</description></item>`;
const rssFeed = (...items: string[]) => `<rss><channel>${items.join("")}</channel></rss>`;

const fixture = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>New model arrives</title>
    <link>https://github.blog/changelog/2026-08-15-new-model</link>
    <pubDate>Sat, 15 Aug 2026 10:00:00 +0000</pubDate>
    <dc:creator>GitHub</dc:creator>
    <content:encoded><![CDATA[
      <html><body><p>A new model is available.</p>
      <img src="https://example.com/model.png">
      <a href="https://docs.github.com/model">Documentation</a></body></html>
    ]]></content:encoded>
  </item>
  <item>
    <title>Old entry</title>
    <link>https://github.blog/changelog/2025-01-01-old</link>
    <pubDate>Wed, 01 Jan 2025 10:00:00 +0000</pubDate>
    <description>Too old</description>
  </item>
</channel></rss>`;

describe("parseChangelogFeed", () => {
  it("extracts full content and filters the selected period", () => {
    const posts = parseChangelogFeed(fixture, {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T23:59:59Z"),
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      title: "New model arrives",
      author: "GitHub",
      plainText: "A new model is available. Documentation",
      imageUrls: ["https://example.com/model.png"],
    });
    expect(posts[0].links).toContainEqual({
      label: "Documentation",
      url: "https://docs.github.com/model",
    });
  });

    describe("Atom and relative feed URLs", () => {
      it("reads Atom HTML, alternate links, published dates and feed authors", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
          <author><name>Feed author</name></author>
          <entry>
            <title type="html">Copilot &amp;amp; &lt;b&gt;agents&lt;/b&gt;</title>
            <published>2026-08-12T10:00:00+02:00</published><updated>2026-08-20T12:00:00Z</updated>
            <link rel="self" href="https://example.com/api/entry"/>
            <link rel="alternate" type="application/json" href="https://example.com/entry.json"/>
            <link rel="alternate" type="text/html" href="../articles/agent"/>
            <summary>Short summary.</summary>
            <content type="html">&lt;p&gt;Full feed content.&lt;/p&gt;
              &lt;a href="../docs"&gt;Documentation&lt;/a&gt;
              &lt;img src="../images/agent.png"&gt;</content>
          </entry>
        </feed>`;
        const [post] = parseChangelogFeed(xml, august, undefined, "https://example.com/feeds/atom.xml");
        expect(post).toMatchObject({
          title: "Copilot & agents", url: "https://example.com/articles/agent",
          publishedAt: "2026-08-12T08:00:00.000Z", author: "Feed author",
          plainText: "Full feed content. Documentation",
          imageUrls: ["https://example.com/images/agent.png"],
          links: [{ label: "Documentation", url: "https://example.com/docs" }],
        });
        expect(post.html).toContain("<p>Full feed content.</p>");
      });

      it("supports prefixed Atom, updated fallback, text summaries and inherited xml:base", () => {
        const xml = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="https://example.com/root/">
          <atom:entry xml:base="news/">
            <atom:title>Text &amp; summary</atom:title><atom:published>invalid date</atom:published>
            <atom:updated>2026-08-15T12:30:00Z</atom:updated>
            <atom:author><atom:name>Entry author</atom:name></atom:author>
            <atom:link xml:base="../posts/" href="update"/>
            <atom:summary>Use &lt;widget&gt; &amp; examples.</atom:summary>
          </atom:entry>
          <atom:entry><atom:title>Old</atom:title><atom:updated>2025-01-01</atom:updated>
            <atom:link href="old"/></atom:entry>
          <atom:entry><atom:title>Invalid date</atom:title><atom:updated>nonsense</atom:updated>
            <atom:link href="invalid"/></atom:entry>
        </atom:feed>`;
        expect(parseChangelogFeed(xml, august)).toEqual([expect.objectContaining({
          title: "Text & summary", url: "https://example.com/root/posts/update",
          publishedAt: "2026-08-15T12:30:00.000Z", author: "Entry author",
          plainText: "Use <widget> & examples.", html: "Use &lt;widget&gt; &amp; examples.",
        })]);
      });

      it("resolves nested Atom content bases and uses readable summaries for external content", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="../">
          <entry xml:base="posts/"><title>Inline HTML</title><updated>2026-08-15</updated>
            <link href="article"/><content type="html" xml:base="../assets/"><![CDATA[
              <p>Inline content.</p><a href="guide">Guide</a><img src="image.png">
            ]]></content></entry>
          <entry><title>External content</title><updated>2026-08-14</updated>
            <link href="external"/><content type="text" src="body.txt"/>
            <summary type="html">&lt;p&gt;Summary content.&lt;/p&gt;</summary></entry>
          <entry><title>XHTML content</title><updated>2026-08-13</updated><link href="xhtml"/>
            <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>XHTML content.</p></div></content>
          </entry>
        </feed>`;
        const posts = parseChangelogFeed(xml, august, undefined, "https://example.com/feeds/feed.xml");
        expect(posts.map((post) => post.plainText)).toEqual(["Inline content.Guide", "Summary content.", "XHTML content."]);
        expect(posts[0]).toMatchObject({
          url: "https://example.com/posts/article",
          links: [{ label: "Guide", url: "https://example.com/assets/guide" }],
          imageUrls: ["https://example.com/assets/image.png"],
        });
      });

      it("resolves RSS entry URLs against the feed and explicit content bases", () => {
        const xml = `<rss xml:base="../"><channel xml:base="news/">
          <item><title>Relative RSS</title><link>article</link><pubDate>2026-08-15</pubDate>
            <description xml:base="../assets/"><![CDATA[<p>RSS content.</p>
              <a href="guide">Guide</a><img src="image.png">]]></description></item>
          <item><title>Invalid date</title><link>invalid</link><pubDate>invalid</pubDate></item>
        </channel></rss>`;
        const [post] = parseChangelogFeed(xml, august, undefined, "https://example.com/feeds/feed.xml");
        expect(post).toMatchObject({
          url: "https://example.com/news/article",
          links: [{ label: "Guide", url: "https://example.com/assets/guide" }],
          imageUrls: ["https://example.com/assets/image.png"],
        });
        const relative = rssFeed(rssItem("Feed relative", "../article", 15));
        expect(parseChangelogFeed(relative, august, 1, "https://example.com/feeds/rss.xml")[0].url)
          .toBe("https://example.com/article");
      });

      it("does not treat Atom self/enclosure links or unsafe protocols as articles", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
          <entry><title>No article</title><updated>2026-08-15</updated>
            <link rel="self" href="https://example.com/api"/><link rel="enclosure" href="https://example.com/file"/></entry>
          <entry><title>Unsafe article</title><updated>2026-08-15</updated>
            <link href="javascript:alert(1)"/><summary>Content.</summary></entry>
          <entry><title>Safe alternate</title><updated>2026-08-15</updated>
            <link href="mailto:someone@example.com"/><link href="https://example.com/safe"/>
            <content>Safe content.</content></entry>
        </feed>`;
        expect(parseChangelogFeed(xml, august).map((post) => post.url)).toEqual(["https://example.com/safe"]);
      });
    });

    describe("metadata discovery and selection", () => {
      it("exports canonical normalization without merging distinct query IDs", () => {
        expect(canonicalArticleUrl("https://example.com/article///?z=2&utm_source=rss&FBCLID=abc&a=1&gclid=x#intro"))
          .toBe("https://example.com/article?a=1&z=2");
        expect(canonicalArticleUrl("https://example.com/?p=1")).not.toBe(canonicalArticleUrl("https://example.com/?p=2"));
      });

      it("previews local feeds without validating bodies, downloading articles or writing files", async () => {
        const directory = await fixtureDirectory();
        const source = join(directory, "preview.xml");
        await writeFile(source, rssFeed(rssItem("Empty selected article", "https://example.com/empty", 15, "")));
        const fetchImpl = vi.fn();
        const onFeedLoaded = vi.fn();
        const onArticlesDiscovered = vi.fn();
        const onArticleProgress = vi.fn();
        try {
          const selection = await discoverChangelog(august, source, {
            cacheDirectory: join(directory, "cache"), fetchImpl, fullArticles: true,
            onFeedLoaded, onArticlesDiscovered, onArticleProgress,
          });
          expect(selection.selected).toHaveLength(1);
          expect(selection.entries).toEqual([{
            title: "Empty selected article", url: "https://example.com/empty",
            publishedAt: "2026-08-15T00:00:00.000Z", source, status: "selected",
            reason: "Selected for content preparation.",
          }]);
          expect(fetchImpl).not.toHaveBeenCalled();
          expect(onFeedLoaded).toHaveBeenCalledExactlyOnceWith({ source, articles: 1, local: true });
          expect(onArticlesDiscovered).not.toHaveBeenCalled();
          expect(onArticleProgress).not.toHaveBeenCalled();
          expect(await readdir(directory)).toEqual(["preview.xml"]);
          await expect(prepareChangelog(selection, { fetchImpl })).rejects.toThrow(/Empty selected article.*no readable content/);
          expect(fetchImpl).not.toHaveBeenCalled();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("discovers archive, blog and Atom metadata and caches only their indexes", async () => {
        const directory = await fixtureDirectory();
        const source = "https://example.com/atom";
        const onFeedLoaded = vi.fn();
        const onArticlesDiscovered = vi.fn();
        const onArticleProgress = vi.fn();
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("opened-months")) return new Response(`<changelog-month data-loaded="true"><article>
            <time datetime="2026-08-15"></time><a class="ChangelogItem-title" href="/changelog/archive">Archive</a>
            </article></changelog-month>`);
          if (url.includes("wp-json")) return new Response(JSON.stringify([{
            title: { rendered: "Blog" }, link: "https://example.com/blog", date_gmt: "2026-08-16T00:00:00",
          }]));
          if (url === source) return new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>Atom</title><updated>2026-08-17</updated><link href="/article"/></entry></feed>`);
          throw new Error(`Unexpected article download: ${url}`);
        });
        try {
          const options = {
            cacheDirectory: directory, fetchImpl, additionalFeeds: [source], includeAiMl: true,
            fullArticles: true, onFeedLoaded, onArticlesDiscovered, onArticleProgress,
          };
          const selection = await discoverChangelog(august, undefined, options);
          expect(selection.selected.map(({ title, source }) => ({ title, source }))).toEqual([
            { title: "Atom", source }, { title: "Blog", source: "GitHub AI & ML blog" },
            { title: "Archive", source: "GitHub Copilot changelog" },
          ]);
          expect(await discoverChangelog(august, undefined, options)).toEqual(selection);
          expect(fetchImpl).toHaveBeenCalledTimes(3);
          expect(await readdir(directory)).toHaveLength(3);
          expect(onFeedLoaded).toHaveBeenCalledTimes(2);
          expect(onArticlesDiscovered).not.toHaveBeenCalled();
          expect(onArticleProgress).not.toHaveBeenCalled();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("uses case-insensitive literal title filters with OR includes and exclusion precedence before limit", async () => {
        const directory = await fixtureDirectory();
        const source = join(directory, "filters.xml");
        await writeFile(source, rssFeed(
          rssItem("Copilot PREVIEW", "https://example.com/preview", 25),
          rssItem("Database release", "https://example.com/database", 24, "Copilot .NET C++ body only."),
          rssItem("New cOpIlOt feature", "https://example.com/copilot", 23),
          rssItem("C++ update", "https://example.com/cpp", 22),
          rssItem("C language update", "https://example.com/c", 21),
          rssItem(".NET update", "https://example.com/dotnet", 20),
          rssItem("xNET update", "https://example.com/xnet", 19),
          rssItem("More Copilot", "https://example.com/more", 18),
          rssItem("Outside range", "https://example.com/outside", 1).replace("2026-08-01", "2026-09-01"),
        ));
        try {
          const selection = await discoverChangelog(august, source, {
            include: ["COPILOT", "c++", ".net"], exclude: ["preview"], limit: 3,
          });
          expect(selection.selected.map((post) => post.title)).toEqual(["New cOpIlOt feature", "C++ update", ".NET update"]);
          expect(selection.entries.map((entry) => entry.status)).toEqual([
            "exclude-filter", "include-filter", "selected", "selected", "include-filter", "selected", "include-filter", "limit",
          ]);
          expect(selection.entries[0].reason).toContain('"preview"');
          expect(selection.entries[1].reason).toMatch(/include.*"COPILOT".*"c\+\+".*"\.net"/);
          expect(selection.entries.at(-1)?.reason).toContain("limit of 3");
          expect(selection.entries.every((entry) => entry.source === source && entry.reason.length > 0)).toBe(true);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("reports same-feed and cross-feed duplicates and already-delivered URLs before the global limit", async () => {
        const directory = await fixtureDirectory();
        const source = join(directory, "primary.xml");
        const additional = join(directory, "additional.xml");
        await writeFile(source, rssFeed(
          rssItem("Already delivered", "https://example.com/delivered/?utm_source=rss#top", 25),
          rssItem("Newest", "https://example.com/article?p=1", 24),
          rssItem("Repeated", "https://example.com/article/?utm_source=rss&p=1#top", 23),
          rssItem("Second", "https://example.com/article?p=2", 21),
          rssItem("Limited", "https://example.com/limited", 20),
        ));
        await writeFile(additional, rssFeed(rssItem("Cross-feed duplicate", "https://example.com/article?p=1", 22)));
        const fetchImpl = vi.fn();
        try {
          const selection = await discoverChangelog(august, source, {
            additionalFeeds: [additional], limit: 2, fetchImpl,
            skipUrls: new Set(["https://example.com/delivered?fbclid=old#section"]),
          });
          expect(selection.selected.map((post) => post.title)).toEqual(["Newest", "Second"]);
          expect(selection.entries.map((entry) => entry.status)).toEqual([
            "already-delivered", "selected", "duplicate", "duplicate", "selected", "limit",
          ]);
          expect(selection.entries[0].reason).toMatch(/already delivered/);
          expect(selection.entries[2].reason).toContain(`"Newest" from ${source}`);
          expect(selection.entries[3].source).toBe(additional);
          expect(fetchImpl).not.toHaveBeenCalled();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("drains in-flight index writes before reporting discovery errors", async () => {
        const directory = await fixtureDirectory();
        const invalid = join(directory, "invalid.xml");
        await writeFile(invalid, "<html>Invalid feed</html>");
        let release: () => void = () => {};
        let started = false;
        let settled = false;
        const remote = "https://example.com/slow-feed";
        const fetchImpl = vi.fn(async () => {
          started = true;
          await new Promise<void>((resolve) => { release = resolve; });
          return new Response(rssFeed(rssItem("Slow feed", "https://example.com/slow", 15)));
        });
        const discovery = discoverChangelog(august, invalid, {
          cacheDirectory: directory, additionalFeeds: [remote], fetchImpl,
        }).then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
        try {
          await vi.waitFor(() => expect(started).toBe(true));
          expect(settled).toBe(false);
          release();
          expect(String(await discovery)).toContain(invalid);
          const selection = await discoverChangelog(august, remote, { cacheDirectory: directory, fetchImpl });
          expect(selection.selected[0].title).toBe("Slow feed");
          expect(fetchImpl).toHaveBeenCalledTimes(1);
        } finally {
          release();
          await discovery;
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("retains duplicate diagnostics from within the archive and blog indexes", async () => {
        const directory = await fixtureDirectory();
        try {
          const selection = await discoverChangelog(august, undefined, {
            cacheDirectory: directory, includeAiMl: true, limit: 2,
            fetchImpl: async (input) => new Response(String(input).includes("opened-months")
              ? `<changelog-month data-loaded="true">${["Archive", "Repeated archive"].map((title) => `<article>
                  <time datetime="2026-08-15"></time><a class="ChangelogItem-title" href="/changelog/same">${title}</a>
                  </article>`).join("")}</changelog-month>`
              : JSON.stringify(["Blog", "Repeated blog"].map((title) => ({
                title: { rendered: title }, link: "https://example.com/blog", date_gmt: "2026-08-16T00:00:00",
              })))),
          });
          expect(selection.selected.map((post) => post.title)).toEqual(["Blog", "Archive"]);
          expect(selection.entries.map((entry) => entry.status)).toEqual(["selected", "duplicate", "selected", "duplicate"]);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("supports a zero global limit without downloading or validating any feed articles", async () => {
        const directory = await fixtureDirectory();
        const source = join(directory, "zero.xml");
        await writeFile(source, rssFeed(rssItem("No content needed", "https://example.com/zero", 15, "")));
        const fetchImpl = vi.fn();
        try {
          const selection = await discoverChangelog(august, source, { limit: 0, fetchImpl });
          expect(selection.selected).toEqual([]);
          expect(selection.entries[0].status).toBe("limit");
          expect(await prepareChangelog(selection, { fullArticles: true, fetchImpl })).toEqual([]);
          expect(fetchImpl).not.toHaveBeenCalled();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    });

    describe("selected content preparation", () => {
      it.each(["RSS", "Atom"])("optionally fetches full %s articles and reuses their cached bodies", async (format) => {
        const directory = await fixtureDirectory();
        const source = "https://example.com/feed";
        const url = "https://example.com/articles/latest";
        const xml = format === "RSS"
          ? rssFeed(rssItem("Latest", url, 20, "Feed summary."), rssItem("Limited", "https://example.com/older", 19))
          : `<feed xmlns="http://www.w3.org/2005/Atom">
              <entry><title>Latest</title><updated>2026-08-20</updated><link href="${url}"/>
                <summary>Feed summary.</summary></entry>
              <entry><title>Limited</title><updated>2026-08-19</updated><link href="https://example.com/older"/>
                <summary>Older.</summary></entry></feed>`;
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
          if (String(input) === source) return new Response(xml);
          if (String(input) !== url) throw new Error(`Unexpected download: ${String(input)}`);
          return new Response(`<html><head><meta name="author" content="Page author"><meta property="og:image" content="/social.png"></head>
            <body><nav>Navigation</nav><main><article><p>Full article.</p>
            <a href="../docs">Guide</a><img src="/image.png"><script>Ignore script.</script></article></main></body></html>`);
        });
        const onArticlesDiscovered = vi.fn();
        const onArticleProgress = vi.fn();
        try {
          const options = { cacheDirectory: directory, fetchImpl, limit: 1, fullArticles: true, onArticlesDiscovered, onArticleProgress };
          const selection = await discoverChangelog(august, source, options);
          expect(fetchImpl).toHaveBeenCalledTimes(1);
          expect(onArticlesDiscovered).not.toHaveBeenCalled();
          const [post] = await prepareChangelog(selection, options);
          expect(post).toMatchObject({
            title: "Latest", url, plainText: "Full article. Guide", author: "Page author",
            links: [{ label: "Guide", url: "https://example.com/docs" }],
            imageUrls: ["https://example.com/image.png", "https://example.com/social.png"],
          });
          expect(onArticlesDiscovered).toHaveBeenCalledExactlyOnceWith(1);
          expect(onArticleProgress).toHaveBeenCalledExactlyOnceWith({ completed: 1, total: 1, title: "Latest", succeeded: true });
          expect(await collectChangelog(august, source, options)).toEqual([post]);
          expect(fetchImpl).toHaveBeenCalledTimes(2);
          const inline = await prepareChangelog(selection, { fetchImpl });
          expect(inline[0].plainText).toBe("Feed summary.");
          expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it.each(["unreadable", "HTTP error"])("never silently falls back to feed content after %s full-article extraction", async (failure) => {
        const directory = await fixtureDirectory();
        const source = join(directory, "feed.xml");
        await writeFile(source, rssFeed(
          rssItem("Failed full article", "https://example.com/fail", 20),
          rssItem("Successful full article", "https://example.com/success", 19),
        ));
        const onArticleProgress = vi.fn();
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("success")) return new Response("<article>Full readable content.</article>");
          return failure === "HTTP error" ? new Response("Unavailable", { status: 503 })
            : new Response("<article><script>Script only</script><img src='/image.png'></article>");
        });
        try {
          const selection = await discoverChangelog(august, source);
          const options = { cacheDirectory: directory, fetchImpl, fullArticles: true, onArticleProgress };
          await expect(prepareChangelog(selection, options)).rejects.toThrow(failure === "HTTP error" ? /HTTP 503/ : /no readable content/);
          expect(onArticleProgress).toHaveBeenCalledTimes(2);
          expect(onArticleProgress).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed full article", succeeded: false }));
          expect(onArticleProgress).toHaveBeenCalledWith(expect.objectContaining({ title: "Successful full article", succeeded: true }));
          const successOnly = { ...selection, selected: selection.selected.filter((post) => post.title.startsWith("Successful")) };
          expect((await prepareChangelog(successOnly, options))[0].plainText).toBe("Full readable content.");
          expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("fetches full content even for feed entries without a readable summary", async () => {
        const directory = await fixtureDirectory();
        const source = join(directory, "empty.xml");
        await writeFile(source, rssFeed(rssItem("No summary", "https://example.com/full", 15, "")));
        try {
          const posts = await collectChangelog(august, source, {
            cacheDirectory: directory, fullArticles: true,
            fetchImpl: async () => new Response("<main>Fetched full content.</main>"),
          });
          expect(posts[0].plainText).toBe("Fetched full content.");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it("preserves explicit selection order and reports discovery only during preparation", async () => {
        const posts = parseChangelogFeed(rssFeed(
          rssItem("Older", "https://example.com/older", 14), rssItem("Newer", "https://example.com/newer", 15),
        ), august).reverse();
        const selection = {
          selected: posts.map((content) => ({ ...content, source: "Manual selection", content })),
          entries: [],
        };
        const fetchImpl = vi.fn();
        const onArticlesDiscovered = vi.fn();
        const onArticleProgress = vi.fn();
        expect(await prepareChangelog(selection, { fetchImpl, onArticlesDiscovered, onArticleProgress })).toEqual(posts);
        expect(onArticlesDiscovered).toHaveBeenCalledExactlyOnceWith(2);
        expect(onArticleProgress).toHaveBeenCalledTimes(2);
        expect(fetchImpl).not.toHaveBeenCalled();
        onArticlesDiscovered.mockClear();
        onArticleProgress.mockClear();
        expect(await prepareChangelog({ selected: [], entries: [] }, { fetchImpl, onArticlesDiscovered, onArticleProgress })).toEqual([]);
        expect(onArticlesDiscovered).toHaveBeenCalledExactlyOnceWith(0);
        expect(onArticleProgress).not.toHaveBeenCalled();
      });

      it("drains other article downloads and cache writes when a progress callback fails", async () => {
        const directory = await fixtureDirectory();
        const posts = parseChangelogFeed(rssFeed(
          rssItem("Fast", "https://example.com/fast", 20), rssItem("Slow", "https://example.com/slow", 19),
        ), august);
        const selection = { selected: posts.map((content) => ({ ...content, source: "Feed", content })), entries: [] };
        let release: () => void = () => {};
        let started = false;
        let settled = false;
        const onArticleProgress = vi.fn(async ({ title }: { title: string }) => {
          if (title === "Fast") throw new Error("Progress write failed");
        });
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith("slow")) {
            started = true;
            await new Promise<void>((resolve) => { release = resolve; });
          }
          return new Response("<article>Full content cached.</article>");
        });
        const preparation = prepareChangelog(selection, {
          cacheDirectory: directory, fetchImpl, fullArticles: true, onArticleProgress,
        }).then(() => { settled = true; return undefined; }, (error: unknown) => { settled = true; return error; });
        try {
          await vi.waitFor(() => {
            expect(started).toBe(true);
            expect(onArticleProgress).toHaveBeenCalledWith(expect.objectContaining({ title: "Fast" }));
          });
          expect(settled).toBe(false);
          release();
          expect(String(await preparation)).toContain("Progress write failed");
          expect(await prepareChangelog(selection, { cacheDirectory: directory, fetchImpl, fullArticles: true })).toHaveLength(2);
          expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
          release();
          await preparation;
          await rm(directory, { recursive: true, force: true });
        }
      });
    });

  it("uses opened-months for every month in the selected range", () => {
    const range = {
      from: new Date("2026-06-15T00:00:00Z"),
      to: new Date("2026-08-02T23:59:59Z"),
    };
    expect(monthSlugsForRange(range)).toEqual(["06-2026", "07-2026", "08-2026"]);
    expect(buildArchiveUrl(range)).toContain("opened-months=06-2026%2C07-2026%2C08-2026");
  });

  it("extracts only in-range Copilot archive entries", () => {
    const html = `<changelog-month data-loaded="true">
      <article><time datetime="2026-07-15"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-07-15-copilot">July update</a>
      </article>
      <article><time datetime="2026-06-15"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-06-15-copilot">June update</a>
      </article>
    </changelog-month>`;
    const posts = parseArchivePage(html, {
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-31T23:59:59Z"),
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].title).toBe("July update");
  });

  it("builds and parses paginated AI & ML blog queries for the selected period", () => {
    const range = {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T23:59:59Z"),
    };
    const url = new URL(buildAiBlogApiUrl(range, 2));
    expect(url.searchParams.get("categories")).toBe("3293");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("100");
    const posts = parseAiBlogApiPage(JSON.stringify([
      {
        link: "https://github.blog/ai-and-ml/github-copilot/new-agent/",
        date_gmt: "2026-08-20T10:30:00",
        title: { rendered: "Copilot &amp; agents" },
      },
      {
        link: "https://github.blog/ai-and-ml/llms/old/",
        date_gmt: "2026-07-31T23:59:59",
        title: { rendered: "Outside range" },
      },
    ]), range);
    expect(posts).toEqual([{
      title: "Copilot & agents",
      url: "https://github.blog/ai-and-ml/github-copilot/new-agent/",
      publishedAt: "2026-08-20T10:30:00.000Z",
    }]);
  });

  it("reuses cached archive and article copies across collections", async () => {
    const cacheDirectory = await fixtureDirectory();
    const archiveHtml = `<changelog-month data-loaded="true">
      <article><time datetime="2026-08-15"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-08-15-copilot">August update</a>
      </article>
    </changelog-month>`;
    const articleHtml = `<main><article><p>Cached article content.</p></article></main>`;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.includes("opened-months") ? archiveHtml : url.includes("/wp-json/") ? "[]" : articleHtml);
    };
    const trackedFetch = vi.fn(fetchImpl);
    const range = {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T23:59:59Z"),
    };

    try {
      const first = await collectChangelog(range, undefined, { cacheDirectory, fetchImpl: trackedFetch });
      const second = await collectChangelog(range, undefined, { cacheDirectory, fetchImpl: trackedFetch });

      expect(first[0]?.plainText).toBe("Cached article content.");
      expect(second).toEqual(first);
      expect(trackedFetch).toHaveBeenCalledTimes(2);
      expect(trackedFetch.mock.calls.some(([url]) => String(url).includes("/wp-json/"))).toBe(false);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.each([100, 200])("collects exactly %i blog posts without failing on the final page", async (count) => {
    const cacheDirectory = await fixtureDirectory();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.has("opened-months")) return new Response("<html></html>");
      if (!url.pathname.includes("wp-json")) return new Response("<article>Readable source.</article>");
      const page = Number(url.searchParams.get("page"));
      if (page > count / 100) {
        return new Response(JSON.stringify({ code: "rest_post_invalid_page_number" }), { status: 400 });
      }
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        title: { rendered: `Article ${(page - 1) * 100 + index}` },
        link: `https://example.com/article-${(page - 1) * 100 + index}`,
        date_gmt: "2026-08-15T12:00:00",
      }))));
    });
    try {
      const posts = await collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, undefined, { cacheDirectory, fetchImpl, includeAiMl: true });
      expect(posts).toHaveLength(count);
      const cached = await collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, undefined, { cacheDirectory, fetchImpl, includeAiMl: true });
      expect(cached).toEqual(posts);
      expect(fetchImpl).toHaveBeenCalledTimes(count + count / 100 + 2);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.each(["rest_invalid_param", "rest_post_invalid_page_number"])(
    "does not suppress HTTP 400 errors on the first blog page: %s", async (code) => {
      const cacheDirectory = await fixtureDirectory();
      try {
        await expect(collectChangelog({
          from: new Date("2026-08-01"), to: new Date("2026-08-31"),
        }, undefined, {
          cacheDirectory,
          includeAiMl: true,
          fetchImpl: async (input) => String(input).includes("wp-json")
            ? new Response(JSON.stringify({ code }), { status: 400 }) : new Response("<html></html>"),
        })).rejects.toThrow("HTTP 400");
      } finally {
        await rm(cacheDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])("refills download slots without waiting for a slow source (failure: %s)", async (failSlowSource) => {
    const cacheDirectory = await fixtureDirectory();
    const titles = Array.from({ length: 7 }, (_, index) => `Update ${index}`);
    const archiveHtml = `<changelog-month data-loaded="true">${titles.map((title, index) =>
      `<article><time datetime="2026-08-15"></time><a class="ChangelogItem-title" href="/changelog/worker-${index}">${title}</a></article>`,
    ).join("")}</changelog-month>`;
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const progress: number[] = [];
    let active = 0;
    let maximumActive = 0;
    let settled = false;
    const collection = collectChangelog({
      from: new Date("2026-08-01"), to: new Date("2026-08-31"),
    }, undefined, {
      cacheDirectory,
      onArticleProgress: async ({ completed }) => { progress.push(completed); },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("opened-months")) return new Response(archiveHtml);
        if (url.includes("/wp-json/")) return new Response("[]");
        const id = url.slice(url.lastIndexOf("-") + 1);
        started.push(id);
        maximumActive = Math.max(maximumActive, ++active);
        await new Promise<void>((resolve) => { releases.set(id, resolve); });
        active -= 1;
        if (failSlowSource && id === "0") return new Response("Unavailable", { status: 503 });
        return new Response(`<main><article><p>Readable source ${id}.</p></article></main>`);
      },
    }).then(
      (posts) => { settled = true; return { posts, error: undefined }; },
      (error: unknown) => { settled = true; return { posts: undefined, error }; },
    );
    try {
      await vi.waitFor(() => expect(started).toHaveLength(5));
      releases.get("1")!();
      await vi.waitFor(() => expect(started).toHaveLength(6));
      expect(progress).toEqual([1]);
      expect(settled).toBe(false);
      releases.get("5")!();
      await vi.waitFor(() => expect(started).toHaveLength(7));
      for (const release of releases.values()) release();
      const result = await collection;
      expect(maximumActive).toBe(5);
      expect(new Set(started).size).toBe(7);
      expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
      if (failSlowSource) {
        expect(result.error).toBeInstanceOf(Error);
        expect(String(result.error)).toMatch(/Source preparation failed: 1 of 7[\s\S]*Update 0/);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.posts?.map((post) => post.title)).toEqual(titles);
      }
    } finally {
      // Drain even a regressed batch scheduler before removing its cache directory.
      while (!settled) {
        for (const release of releases.values()) release();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("reports progress callback failures once without hiding their cause", async () => {
    const cacheDirectory = await fixtureDirectory();
    const progress = vi.fn().mockRejectedValue(new Error("Trace disk full"));
    try {
      await expect(collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, undefined, {
        cacheDirectory,
        onArticleProgress: progress,
        fetchImpl: async (input) => {
          const url = String(input);
          return new Response(url.includes("opened-months")
            ? `<changelog-month data-loaded="true"><article><time datetime="2026-08-15"></time><a class="ChangelogItem-title" href="/changelog/progress">Update</a></article></changelog-month>`
            : url.includes("/wp-json/") ? "[]" : "<main><article><p>Readable source.</p></article></main>");
        },
      })).rejects.toThrow(/progress reporting failed: Trace disk full/);
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true, completed: 1 }));
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("applies the article limit before downloading source pages", async () => {
    const cacheDirectory = await fixtureDirectory();
    const archiveHtml = `<changelog-month data-loaded="true">
      <article><time datetime="2026-08-16"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-08-16-first">First update</a>
      </article>
      <article><time datetime="2026-08-15"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-08-15-second">Second update</a>
      </article>
    </changelog-month>`;
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(
        url.includes("opened-months")
          ? archiveHtml
          : url.includes("/wp-json/")
            ? "[]"
          : `<main><article><p>First article.</p></article></main>`,
      );
    });

    const range = {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T23:59:59Z"),
    };

    try {
      const posts = await collectChangelog(range, undefined, {
        cacheDirectory,
        fetchImpl,
        limit: 1,
      });

      expect(posts).toHaveLength(1);
      expect(posts[0]?.title).toBe("First update");
      expect(requestedUrls).not.toContain(
        "https://github.blog/changelog/2026-08-15-second",
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("merges AI blog posts with changelog entries before deduplication and the global limit", async () => {
    const cacheDirectory = await fixtureDirectory();
    const archiveHtml = `<changelog-month data-loaded="true">
      <article><time datetime="2026-08-20"></time>
        <a class="ChangelogItem-title" href="https://github.blog/ai-and-ml/github-copilot/shared">Shared update</a>
      </article>
      <article><time datetime="2026-08-18"></time>
        <a class="ChangelogItem-title" href="/changelog/older">Older changelog</a>
      </article>
    </changelog-month>`;
    const blogJson = JSON.stringify([
      {
        link: "https://github.blog/ai-and-ml/llms/newest/",
        date_gmt: "2026-08-21T08:00:00",
        title: { rendered: "Newest AI article" },
      },
      {
        link: "https://github.blog/ai-and-ml/github-copilot/shared/",
        date_gmt: "2026-08-20T12:00:00",
        title: { rendered: "Duplicate shared update" },
      },
    ]);
    const requestedArticles: string[] = [];
    const discovered = vi.fn();
    try {
      const posts = await collectChangelog({
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-31T23:59:59Z"),
      }, undefined, {
        cacheDirectory,
        includeAiMl: true,
        limit: 2,
        onArticlesDiscovered: discovered,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("opened-months")) return new Response(archiveHtml);
          if (url.includes("/wp-json/")) return new Response(blogJson);
          requestedArticles.push(url);
          return new Response(`<article><p>Readable source for ${url}</p></article>`);
        },
      });
      expect(posts.map((post) => post.title)).toEqual(["Newest AI article", "Shared update"]);
      expect(requestedArticles).toHaveLength(2);
      expect(discovered).toHaveBeenCalledWith(2);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("reports every failed source after attempting all selected downloads", async () => {
    const cacheDirectory = await fixtureDirectory();
    const archiveHtml = `<changelog-month data-loaded="true">
      <article><time datetime="2026-08-16"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-08-16-first">First update</a>
      </article>
      <article><time datetime="2026-08-15"></time>
        <a class="ChangelogItem-title" href="/changelog/2026-08-15-second">Second update</a>
      </article>
    </changelog-month>`;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("opened-months")) return new Response(archiveHtml);
      if (url.includes("/wp-json/")) return new Response("[]");
      return new Response("", {
        status: url.endsWith("first") ? 502 : 503,
        statusText: "Service Unavailable",
      });

    });
    const range = {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T23:59:59Z"),
    };

    try {
      const collection = collectChangelog(range, undefined, { cacheDirectory, fetchImpl });
      await expect(collection).rejects.toThrow(/Source preparation failed: 2 of 2 articles[\s\S]*remain cached/);
      await expect(collection).rejects.toThrow("First update");
      await expect(collection).rejects.toThrow("Second update");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    "<html><body><h1>Temporarily unavailable</h1></body></html>",
    "<main> \n </main>",
    "<article><script>not article content</script><img src='/image.png'></article>",
  ])("rejects HTTP 200 pages without readable article content: %s", async (articleHtml) => {
    const cacheDirectory = await fixtureDirectory();
    const progress = vi.fn();
    const range = {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T23:59:59Z"),
    };
    try {
      await expect(collectChangelog(range, undefined, {
        cacheDirectory,
        onArticleProgress: progress,
        fetchImpl: async (input) => {
          const url = String(input);
          return new Response(url.includes("opened-months")
            ? `<changelog-month data-loaded="true"><article><time datetime="2026-08-15"></time><a class="ChangelogItem-title" href="/changelog/empty-article">Empty article</a></article></changelog-month>`
            : url.includes("/wp-json/") ? "[]" : articleHtml);
        },
      })).rejects.toThrow(/Source preparation failed[\s\S]*Empty article[\s\S]*no readable content/i);
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ succeeded: false }));
      expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }));
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("rejects empty selected RSS content but ignores empty out-of-range items", () => {
    const xml = `<rss><channel><item><title>Empty article</title>
      <link>https://example.com/empty</link><pubDate>2026-08-15</pubDate>
      <description><![CDATA[<p> </p>]]></description></item></channel></rss>`;
    expect(() => parseChangelogFeed(xml, {
      from: new Date("2026-08-01"), to: new Date("2026-08-31"),
    })).toThrow(/Empty article.*no readable content/);
    expect(parseChangelogFeed(xml, {
      from: new Date("2026-07-01"), to: new Date("2026-07-31"),
    })).toEqual([]);
  });

  it("deduplicates RSS article URLs so checkpoints have one entry per source", () => {
    const item = `<item><title>Duplicate source</title><link>https://example.com/update</link>
      <pubDate>2026-08-15</pubDate><description>Readable article content.</description></item>`;
    const posts = parseChangelogFeed(`<rss><channel>${item}${item}</channel></rss>`, {
      from: new Date("2026-08-01"), to: new Date("2026-08-31"),
    });
    expect(posts).toHaveLength(1);
  });

  it("validates only the newest selected RSS entries when a limit is set", async () => {
    const xml = `<rss><channel>
      <item><title>Empty older article</title><link>https://example.com/older</link>
      <pubDate>2026-08-14</pubDate><description> </description></item>
      <item><title>Latest article</title><link>https://example.com/latest</link>
      <pubDate>2026-08-15</pubDate><description>Readable article content.</description></item>
      </channel></rss>`;
    const range = { from: new Date("2026-08-01"), to: new Date("2026-08-31") };
    expect(parseChangelogFeed(xml, range, 1).map((post) => post.title)).toEqual(["Latest article"]);
    const cacheDirectory = await fixtureDirectory();
    try {
      const posts = await collectChangelog(range, "https://example.com/feed", {
        cacheDirectory, limit: 1, fetchImpl: async () => new Response(xml),
      });
      expect(posts.map((post) => post.title)).toEqual(["Latest article"]);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("adds multiple RSS feeds to the default changelog, including non-Copilot articles", async () => {
    const directory = await fixtureDirectory();
    const localFeed = join(directory, "local.xml");
    const rss = (title: string, url: string, date: string, body = "Readable source content.") =>
      `<rss><channel><item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate>
        <description>${body}</description></item></channel></rss>`;
    await writeFile(localFeed, rss("Local engineering news", "https://example.com/local", "2026-08-19"));
    const remote = "https://example.com/rss";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/wp-json/")) throw new Error("AI & ML must be opt-in");
      if (url.includes("opened-months")) return new Response(`<changelog-month data-loaded="true">
        <article><time datetime="2026-08-18"></time><a class="ChangelogItem-title"
        href="https://example.com/changelog">Changelog update</a></article></changelog-month>`);
      if (url === remote) return new Response(rss("Database release", "https://example.com/database", "2026-08-20"));
      if (url === "https://example.com/changelog") return new Response("<article>Changelog content.</article>");
      throw new Error(`Unexpected download: ${url}`);
    });
    const discovered = vi.fn();
    const progress = vi.fn();
    try {
      const range = { from: new Date("2026-08-01"), to: new Date("2026-08-31") };
      const posts = await collectChangelog(range, undefined, {
        cacheDirectory: directory, fetchImpl, additionalFeeds: [remote, localFeed, remote],
        onArticlesDiscovered: discovered, onArticleProgress: progress,
      });
      expect(posts.map((post) => post.title)).toEqual([
        "Database release", "Local engineering news", "Changelog update",
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(discovered).toHaveBeenCalledWith(3);
      expect(progress).toHaveBeenCalledTimes(3);
      expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completed: 3, total: 3, succeeded: true }));
      const cached = await collectChangelog(range, undefined, {
        cacheDirectory: directory, fetchImpl, additionalFeeds: [remote, localFeed],
      });
      expect(cached).toEqual(posts);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges replacement, added feeds and optional blog before the global limit and content validation", async () => {
    const directory = await fixtureDirectory();
    const primary = join(directory, "primary.xml");
    const added = join(directory, "added.xml");
    const item = (title: string, url: string, date: string, body: string) =>
      `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><description>${body}</description></item>`;
    await writeFile(primary, `<rss><channel>${item("Empty old entry", "https://example.com/old", "2026-08-10", "")}</channel></rss>`);
    await writeFile(added, `<rss><channel>
      ${item("Added news", "https://example.com/news", "2026-08-20", "News content.")}
      ${item("Tracking duplicate", "https://example.com/news/?utm_source=rss#intro", "2026-08-19", "Duplicate.")}
      ${item("Outside range", "https://example.com/outside", "2026-09-01", "Excluded.")}
      </channel></rss>`);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("opened-months")) throw new Error("--feed must replace the changelog");
      if (url.includes("/wp-json/")) return new Response(JSON.stringify([{
        title: { rendered: "Opt-in blog" }, link: "https://example.com/blog", date_gmt: "2026-08-21T12:00:00",
      }]));
      if (url === "https://example.com/blog") return new Response("<article>Blog content.</article>");
      throw new Error(`Unexpected download: ${url}`);
    });
    try {
      const posts = await collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, primary, { cacheDirectory: directory, fetchImpl, additionalFeeds: [added], includeAiMl: true, limit: 2 });
      expect(posts.map((post) => post.title)).toEqual(["Opt-in blog", "Added news"]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not deduplicate distinct RSS articles that use query-string IDs", () => {
    const item = (id: number) => `<item><title>Article ${id}</title><link>https://example.com/?p=${id}</link>
      <pubDate>2026-08-15</pubDate><description>Readable article.</description></item>`;
    const posts = parseChangelogFeed(`<rss><channel>${item(1)}${item(2)}${item(1)}</channel></rss>`, {
      from: new Date("2026-08-01"), to: new Date("2026-08-31"),
    });
    expect(posts.map((post) => post.url)).toEqual(["https://example.com/?p=1", "https://example.com/?p=2"]);
  });

  it("deduplicates across RSS sources without dropping query-identified articles", async () => {
    const directory = await fixtureDirectory();
    const primary = join(directory, "primary.xml");
    const additional = join(directory, "additional.xml");
    const item = (id: number, tracking = "") => `<item><title>Article ${id}</title>
      <link>https://example.com/?p=${id}${tracking}</link><pubDate>2026-08-15</pubDate>
      <description>Article content.</description></item>`;
    await writeFile(primary, `<rss><channel>${item(1)}</channel></rss>`);
    await writeFile(additional, `<rss><channel>${item(1, "&amp;utm_source=rss#intro")}${item(2)}</channel></rss>`);
    const fetchImpl = vi.fn();
    try {
      const posts = await collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, primary, { additionalFeeds: [additional], fetchImpl });
      expect(posts.map((post) => post.url)).toEqual(["https://example.com/?p=1", "https://example.com/?p=2"]);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["<html><body>Not a feed</body></html>", "<rss><channel><item></channel></rss>"])(
    "rejects invalid RSS rather than quietly omitting a configured source: %s", (xml) => {
      expect(() => parseChangelogFeed(xml, {
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      })).toThrow(/RSS|XML/);
    },
  );

  it.each(["missing", "invalid", "download"])("reports the failing added feed: %s", async (failure) => {
    const directory = await fixtureDirectory();
    const primary = join(directory, "primary.xml");
    const invalid = join(directory, "invalid.xml");
    await writeFile(primary, fixture);
    await writeFile(invalid, "<html>Not RSS</html>");
    const source = failure === "download" ? "https://example.com/unavailable.xml"
      : failure === "missing" ? join(directory, "missing.xml") : invalid;
    try {
      await expect(collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, primary, {
        cacheDirectory: directory, additionalFeeds: [source],
        fetchImpl: async () => new Response("Unavailable", { status: 503 }),
      })).rejects.toThrow(source);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
