import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildArchiveUrl,
  buildAiBlogApiUrl,
  collectChangelog,
  monthSlugsForRange,
  parseAiBlogApiPage,
  parseArchivePage,
  parseChangelogFeed,
} from "./collector.js";

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
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-cache-"));
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
      expect(trackedFetch).toHaveBeenCalledTimes(3);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.each([100, 200])("collects exactly %i blog posts without failing on the final page", async (count) => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-pages-"));
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
      }, undefined, { cacheDirectory, fetchImpl });
      expect(posts).toHaveLength(count);
      const cached = await collectChangelog({
        from: new Date("2026-08-01"), to: new Date("2026-08-31"),
      }, undefined, { cacheDirectory, fetchImpl });
      expect(cached).toEqual(posts);
      expect(fetchImpl).toHaveBeenCalledTimes(count + count / 100 + 2);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.each(["rest_invalid_param", "rest_post_invalid_page_number"])(
    "does not suppress HTTP 400 errors on the first blog page: %s", async (code) => {
      const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-api-error-"));
      try {
        await expect(collectChangelog({
          from: new Date("2026-08-01"), to: new Date("2026-08-31"),
        }, undefined, {
          cacheDirectory,
          fetchImpl: async (input) => String(input).includes("wp-json")
            ? new Response(JSON.stringify({ code }), { status: 400 }) : new Response("<html></html>"),
        })).rejects.toThrow("HTTP 400");
      } finally {
        await rm(cacheDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])("refills download slots without waiting for a slow source (failure: %s)", async (failSlowSource) => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-workers-"));
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
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-progress-"));
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
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-limit-"));
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
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("merges AI blog posts with changelog entries before deduplication and the global limit", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-merged-"));
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
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-errors-"));
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
      await expect(
        collectChangelog(range, undefined, { cacheDirectory, fetchImpl }),
      ).rejects.toThrow(
        /Source preparation failed: 2 of 2 articles[\s\S]*First update[\s\S]*Second update[\s\S]*remain cached/,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    "<html><body><h1>Temporarily unavailable</h1></body></html>",
    "<main> \n </main>",
    "<article><script>not article content</script><img src='/image.png'></article>",
  ])("rejects HTTP 200 pages without readable article content: %s", async (articleHtml) => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-collector-empty-"));
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
    const cacheDirectory = await mkdtemp(join(tmpdir(), "copilot-feed-limit-"));
    try {
      const posts = await collectChangelog(range, "https://example.com/feed", {
        cacheDirectory, limit: 1, fetchImpl: async () => new Response(xml),
      });
      expect(posts.map((post) => post.title)).toEqual(["Latest article"]);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
