import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load, type CheerioAPI } from "cheerio";
import { XMLValidator } from "fast-xml-parser";
import {
  NEWS_ARTICLE_CACHE_MAX_AGE_MS,
  NEWS_INDEX_CACHE_MAX_AGE_MS,
  defaultNewsCacheDirectory,
  readThroughNewsCache,
} from "./news-cache.js";
import type { ChangelogPost, DateRange, SourceLink } from "./types.js";

export const CHANGELOG_FEED_URL = "https://github.blog/changelog/feed/?label=copilot";
export const CHANGELOG_URL = "https://github.blog/changelog/?label=copilot";
export const AI_BLOG_API_URL = "https://github.blog/wp-json/wp/v2/posts";
const AI_AND_ML_CATEGORY_ID = 3293;
const AI_BLOG_PAGE_SIZE = 100;

function normalizeUrl(url: string, baseUrl?: string): string | undefined {
  try {
    const parsed = new URL(url, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function assertReadableSource(post: Pick<ChangelogPost, "title" | "url" | "plainText">): void {
  if (!post.plainText.trim()) {
    throw new Error(
      `The article "${post.title}" (${post.url}) has no readable content. Verify the source page or feed content before retrying.`,
    );
  }
}

function articleData(
  title: string,
  url: string,
  publishedAt: string,
  html: string,
  author?: string,
  baseUrl = url,
): ChangelogPost {
  const $ = load(html);
  $("script, style, noscript").remove();

  const links = new Map<string, SourceLink>();
  $("a[href]").each((_, element) => {
    const href = normalizeUrl($(element).attr("href") ?? "", xmlBase($(element), baseUrl));
    if (!href || href === url) return;
    const label = $(element).text().replace(/\s+/g, " ").trim() || new URL(href).hostname;
    links.set(href, { label, url: href });
  });

  const imageUrls = new Set<string>();
  $("img[src], video[poster]").each((_, element) => {
    const source = $(element).attr("src") ?? $(element).attr("poster") ?? "";
    const url = normalizeUrl(source, xmlBase($(element), baseUrl));
    if (url) imageUrls.add(url);
  });

  return {
    title,
    url,
    publishedAt,
    author,
    plainText: $("body").text().replace(/\s+/g, " ").trim(),
    html,
    imageUrls: [...imageUrls],
    links: [...links.values()],
  };
}

function extractArticleData(
  title: string,
  url: string,
  publishedAt: string,
  articleHtml: string,
): ChangelogPost {
  const $ = load(articleHtml);
  $("script, style, noscript, nav, footer").remove();
  const article = $("article").first();
  const contentRoot = article.length ? article : $("main").first();
  const plainText = contentRoot.text().replace(/\s+/g, " ").trim();
  assertReadableSource({ title, url, plainText });
  const links = new Map<string, SourceLink>();
  contentRoot.find("a[href]").each((_, element) => {
    const href = normalizeUrl($(element).attr("href") ?? "", url);
    if (!href || href === url) return;
    const label = $(element).text().replace(/\s+/g, " ").trim() || new URL(href).hostname;
    links.set(href, { label, url: href });
  });
  const imageUrls = new Set<string>();
  contentRoot.find("img[src], video[poster]").each((_, element) => {
    const source = $(element).attr("src") ?? $(element).attr("poster") ?? "";
    const imageUrl = normalizeUrl(source, url);
    if (imageUrl) imageUrls.add(imageUrl);
  });
  const socialImage = $('meta[property="og:image"]').attr("content");
  const normalizedSocialImage = socialImage ? normalizeUrl(socialImage, url) : undefined;
  if (normalizedSocialImage) imageUrls.add(normalizedSocialImage);
  const author =
    $('meta[name="author"]').attr("content") ??
    article.find('[rel="author"], .byline, [class*="author"]').first().text().replace(/\s+/g, " ").trim() ??
    undefined;

  return {
    title,
    url,
    publishedAt,
    author: author || undefined,
    plainText,
    html: contentRoot.html() ?? "",
    imageUrls: [...imageUrls],
    links: [...links.values()],
  };
}

export function monthSlugsForRange(range: DateRange): string[] {
  const months: string[] = [];
  const cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), 1));
  while (cursor <= last) {
    months.push(
      `${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${cursor.getUTCFullYear()}`,
    );
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function buildArchiveUrl(range: DateRange): string {
  const url = new URL(CHANGELOG_URL);
  url.searchParams.set("opened-months", monthSlugsForRange(range).join(","));
  return url.href;
}

interface ArchivePost {
  title: string;
  url: string;
  publishedAt: string;
}

export interface SelectedArticle extends ArchivePost {
  source: string;
  content?: ChangelogPost;
}

export interface ArticleSelectionEntry extends ArchivePost {
  source: string;
  status: "selected" | "duplicate" | "include-filter" | "exclude-filter" | "limit" | "already-delivered";
  reason: string;
}

export interface ArticleSelection {
  /** Only these entries may trigger article downloads; order already includes filtering and --limit. */
  selected: SelectedArticle[];
  /** In-range discovery decisions, including duplicates and exclusions, used by dry-run and tracing. */
  entries: ArticleSelectionEntry[];
}

interface AiBlogApiPost {
  link?: string;
  date_gmt?: string;
  title?: { rendered?: string };
}

export interface ChangelogCollectionProgress {
  completed: number;
  total: number;
  title: string;
  succeeded: boolean;
}

export interface ChangelogCollectionOptions {
  cacheDirectory?: string;
  fetchImpl?: typeof fetch;
  limit?: number;
  additionalFeeds?: string[];
  includeAiMl?: boolean;
  /** Literal, case-insensitive title terms; any include matches, and excludes win. */
  include?: string[];
  exclude?: string[];
  /** Canonicalized and removed before the global limit is applied. */
  skipUrls?: ReadonlySet<string>;
  /** Download article pages even when a feed provides inline content. */
  fullArticles?: boolean;
  onFeedLoaded?: (feed: { source: string; articles: number; local: boolean }) => void | Promise<void>;
  onArticlesDiscovered?: (total: number) => void | Promise<void>;
  onArticleProgress?: (progress: ChangelogCollectionProgress) => void | Promise<void>;
}

class NewsDownloadError extends Error {}

export function parseArchivePage(html: string, range: DateRange): ArchivePost[] {
  return uniqueArchivePosts(parseArchiveEntries(html, range));
}

function uniqueArchivePosts(posts: ArchivePost[]): ArchivePost[] {
  const found = new Map(posts.map((post) => [post.url, post]));
  return [...found.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function parseArchiveEntries(html: string, range: DateRange): ArchivePost[] {
  const $ = load(html);
  const posts: ArchivePost[] = [];
  $("changelog-month[data-loaded='true'] .ChangelogItem-title[href]").each((_, element) => {
    const url = normalizeUrl($(element).attr("href") ?? "", CHANGELOG_URL);
    const title = $(element).text().replace(/\s+/g, " ").trim();
    const dateValue = $(element).closest("article").find("time[datetime]").first().attr("datetime");
    if (!url || !title || !dateValue) return;
    const publishedAt = new Date(`${dateValue}T12:00:00.000Z`);
    if (
      Number.isNaN(publishedAt.getTime()) ||
      publishedAt < range.from ||
      publishedAt > range.to
    ) {
      return;
    }

    posts.push({ title, url, publishedAt: publishedAt.toISOString() });
  });
  return posts;
}

export function buildAiBlogApiUrl(range: DateRange, page = 1): string {
  const url = new URL(AI_BLOG_API_URL);
  url.searchParams.set("categories", String(AI_AND_ML_CATEGORY_ID));
  url.searchParams.set("after", new Date(range.from.getTime() - 1).toISOString());
  url.searchParams.set("before", new Date(range.to.getTime() + 1).toISOString());
  url.searchParams.set("per_page", String(AI_BLOG_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("_fields", "link,date_gmt,title");
  return url.href;
}

export function parseAiBlogApiPage(json: string, range: DateRange): ArchivePost[] {
  return uniqueArchivePosts(parseAiBlogApiEntries(json, range));
}

function parseAiBlogApiEntries(json: string, range: DateRange): ArchivePost[] {
  const values = JSON.parse(json) as unknown;
  if (!Array.isArray(values)) throw new TypeError("Expected a JSON array of blog posts.");
  const posts: ArchivePost[] = [];
  for (const value of values as AiBlogApiPost[]) {
    if (!value.link || !value.date_gmt || !value.title?.rendered) continue;
    const url = normalizeUrl(value.link, AI_BLOG_API_URL);
    const publishedAt = new Date(`${value.date_gmt}Z`);
    const title = load(`<body>${value.title.rendered}</body>`)("body")
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (
      !url ||
      !title ||
      Number.isNaN(publishedAt.getTime()) ||
      publishedAt < range.from ||
      publishedAt > range.to
    ) {
      continue;
    }
    posts.push({ title, url, publishedAt: publishedAt.toISOString() });
  }
  return posts;
}

export function canonicalArticleUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.href;
}

type XmlNode = ReturnType<CheerioAPI>;

function xmlChildren(node: XmlNode, name: string): XmlNode {
  return node.children().filter((_, element) => element.name.split(":").at(-1) === name);
}

function xmlBase(node: XmlNode, sourceUrl?: string, fallbackUrl = sourceUrl): string | undefined {
  const bases: string[] = [];
  for (let current = node; current.length; current = current.parent()) {
    const base = current.attr("xml:base");
    if (base) bases.unshift(base);
  }
  return bases.length
    ? bases.reduce<string | undefined>((base, value) => normalizeUrl(value, base) ?? base, sourceUrl)
    : fallbackUrl;
}

function atomHtml(node: XmlNode): string {
  const type = node.attr("type") ?? "text";
  if (type === "xhtml") return node.html() ?? "";
  const text = node.text();
  if (type === "html" || type === "text/html") return text;
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseFeedEntries(xml: string, range: DateRange, sourceUrl?: string): ChangelogPost[] {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`Invalid RSS/XML: ${validation.err.msg}`);
  const $ = load(xml, { xml: true });
  const root = $.root().children().first();
  const atom = root.get(0)?.name.split(":").at(-1) === "feed";
  const channel = xmlChildren(root, "channel").first();
  if (!atom && (root.get(0)?.name !== "rss" || !channel.length)) {
    throw new Error("Expected an RSS document with an rss/channel element or an Atom feed element.");
  }
  const posts: ChangelogPost[] = [];
  xmlChildren(atom ? root : channel, atom ? "entry" : "item").each((_, element) => {
    const item = $(element);
    const child = (name: string) => xmlChildren(item, name).first();
    const titleNode = child("title");
    const title = (atom ? load(atomHtml(titleNode))("body").text() : titleNode.text())
      .replace(/\s+/g, " ").trim();
    const dates = atom ? [child("published").text(), child("updated").text()] : [child("pubDate").text()];
    const publishedAt = dates.map((date) => new Date(date.trim())).find((date) => !Number.isNaN(date.getTime()));
    if (!title || !publishedAt || publishedAt < range.from || publishedAt > range.to) return;

    let url: string | undefined;
    if (atom) {
      const links = xmlChildren(item, "link").filter((_, link) => {
        const rel = $(link).attr("rel");
        return !rel || rel === "alternate";
      }).toArray().sort((a, b) => {
        const isHtml = (node: typeof a) => /^(text\/html|application\/xhtml\+xml)$/i.test($(node).attr("type") ?? "");
        return Number(isHtml(b)) - Number(isHtml(a));
      });
      for (const link of links) {
        const href = $(link).attr("href")?.trim();
        if (href) url = normalizeUrl(href, xmlBase($(link), sourceUrl));
        if (url) break;
      }
    } else {
      const link = child("link");
      if (link.text().trim()) url = normalizeUrl(link.text().trim(), xmlBase(link, sourceUrl));
    }
    if (!url) return;

    const content = atom ? child("content") : child("encoded");
    const body = content.length && (!atom || !content.attr("src"))
      ? content : child(atom ? "summary" : "description");
    const html = atom ? atomHtml(body) : body.text();
    const author = atom
      ? xmlChildren(child("author").length ? child("author") : xmlChildren(root, "author").first(), "name").first().text()
      : (child("creator").text() || child("author").text());
    const baseUrl = xmlBase(body.length ? body : item, sourceUrl, atom ? sourceUrl ?? url : url) ?? url;
    posts.push(articleData(title, url, publishedAt.toISOString(), html, author.trim() || undefined, baseUrl));
  });
  return posts;
}

function selectArticles(articles: SelectedArticle[], options: ChangelogCollectionOptions): ArticleSelection {
  const selected: SelectedArticle[] = [];
  const entries: ArticleSelectionEntry[] = [];
  const seen = new Map<string, SelectedArticle>();
  const delivered = new Set([...(options.skipUrls ?? [])].map(canonicalArticleUrl));
  const includes = (options.include ?? []).map((value) => value.toLowerCase());
  const excludes = (options.exclude ?? []).map((value) => value.toLowerCase());
  for (const article of [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    const key = canonicalArticleUrl(article.url);
    const previous = seen.get(key);
    const title = article.title.toLowerCase();
    const excludedBy = excludes.findIndex((value) => title.includes(value));
    let status: ArticleSelectionEntry["status"];
    let reason: string;
    if (previous) {
      status = "duplicate";
      reason = `Duplicate URL of "${previous.title}" from ${previous.source}.`;
    } else if (delivered.has(key)) {
      status = "already-delivered";
      reason = "This URL was already delivered.";
    } else if (excludedBy !== -1) {
      status = "exclude-filter";
      reason = `Title matched exclude filter ${JSON.stringify(options.exclude![excludedBy])}.`;
    } else if (includes.length && !includes.some((value) => title.includes(value))) {
      status = "include-filter";
      reason = `Title did not match any include filter: ${options.include!.map((value) => JSON.stringify(value)).join(", ")}.`;
    } else if (selected.length >= (options.limit ?? Number.POSITIVE_INFINITY)) {
      status = "limit";
      reason = `Beyond the global limit of ${options.limit} articles.`;
    } else {
      status = "selected";
      reason = "Selected for content preparation.";
      selected.push(article);
    }
    if (!previous) seen.set(key, article);
    const { title: originalTitle, url, publishedAt, source } = article;
    entries.push({ title: originalTitle, url, publishedAt, source, status, reason });
  }
  return { selected, entries };
}

export function parseChangelogFeed(
  xml: string,
  range: DateRange,
  limit?: number,
  sourceUrl?: string,
): ChangelogPost[] {
  const { selected } = selectArticles(parseFeedEntries(xml, range, sourceUrl).map((content) => ({
    title: content.title, url: content.url, publishedAt: content.publishedAt, source: sourceUrl ?? "Feed", content,
  })), { limit });
  const selectedPosts = selected.map((post) => post.content!);
  selectedPosts.forEach(assertReadableSource);
  return selectedPosts;
}

function createTextFetcher(options: ChangelogCollectionOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (
    url: string,
    maximumAgeMs: number,
    resourceDescription: string,
    allowEndOfBlogPages = false,
  ) => {
    const cacheDirectory = options.cacheDirectory ?? defaultNewsCacheDirectory();
    return readThroughNewsCache(
      url,
      maximumAgeMs,
      async () => {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            headers: { "User-Agent": "copilot-changelog-cli/1.0" },
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          const reason =
            error instanceof Error && error.name === "TimeoutError"
              ? "The request timed out after 30 seconds."
              : `Network request failed: ${error instanceof Error ? error.message : String(error)}.`;
          throw new NewsDownloadError(
            `Could not download ${resourceDescription} from ${url}. ${reason} Check the internet connection and retry.`,
            { cause: error },
          );
        }
        if (!response.ok) {
          if (allowEndOfBlogPages && response.status === 400) {
            const body = await response.text();
            let problem: unknown;
            try {
              problem = JSON.parse(body);
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              throw new NewsDownloadError(`Could not download ${resourceDescription} from ${url}. HTTP 400 returned invalid JSON.`, { cause: error });
            }
            if (typeof problem === "object" && problem !== null &&
                "code" in problem && problem.code === "rest_post_invalid_page_number") {
              return "[]";
            }
          }
          throw new NewsDownloadError(
            `Could not download ${resourceDescription} from ${url}. The server returned HTTP ${response.status} ${response.statusText || "without a status description"}. Verify that the URL is available and retry.`,
          );
        }
        return response.text();
      },
      { cacheDirectory },
    ).catch((error: unknown) => {
      if (error instanceof NewsDownloadError) throw error;
      throw new Error(
        `Could not prepare ${resourceDescription}. The local cache at ${cacheDirectory} could not be read or updated: ${error instanceof Error ? error.message : String(error)}. Delete that cache folder and retry.`,
        { cause: error },
      );
    });
  };
}

/** Discovers and selects metadata without downloading or validating article bodies. */
export async function discoverChangelog(
  range: DateRange,
  source?: string,
  options: ChangelogCollectionOptions = {},
): Promise<ArticleSelection> {
  const fetchText = createTextFetcher(options);
  const loadFeed = async (feed: string): Promise<SelectedArticle[]> => {
    const local = !/^https?:\/\//i.test(feed);
    const source = local ? resolve(feed) : feed;
    let xml: string;
    if (local) {
      try {
        xml = await readFile(source, "utf8");
      } catch (error) {
        throw new Error(
          `Could not read the local feed file at ${source}: ${error instanceof Error ? error.message : String(error)}. Verify the path and file permissions, then retry.`,
          { cause: error },
        );
      }
    } else {
      xml = await fetchText(source, NEWS_INDEX_CACHE_MAX_AGE_MS, "the RSS/Atom feed");
    }
    let posts: ChangelogPost[];
    try {
      posts = parseFeedEntries(xml, range, local ? undefined : source);
    } catch (error) {
      throw new Error(
        `Could not parse the RSS/Atom feed at ${source}: ${error instanceof Error ? error.message : String(error)}. Verify the --feed or --rss source and provide valid RSS/Atom XML.`,
        { cause: error },
      );
    }
    await options.onFeedLoaded?.({ source, articles: posts.length, local });
    return posts.map((content) => ({
      title: content.title, url: content.url, publishedAt: content.publishedAt, source, content,
    }));
  };
  const loadBlog = async (): Promise<ArchivePost[]> => {
    const firstBlogPage = await fetchText(
      buildAiBlogApiUrl(range),
      NEWS_INDEX_CACHE_MAX_AGE_MS,
      "the GitHub AI & ML blog index",
    );
    const blogPosts = parseAiBlogApiEntries(firstBlogPage, range);
    let pageSize = (JSON.parse(firstBlogPage) as unknown[]).length;
    for (let page = 2; pageSize === AI_BLOG_PAGE_SIZE; page += 1) {
      const json = await fetchText(
        buildAiBlogApiUrl(range, page),
        NEWS_INDEX_CACHE_MAX_AGE_MS,
        `page ${page} of the GitHub AI & ML blog index`,
        true,
      );
      blogPosts.push(...parseAiBlogApiEntries(json, range));
      pageSize = (JSON.parse(json) as unknown[]).length;
    }
    return blogPosts;
  };
  const additionalFeeds = [...new Set(options.additionalFeeds ?? [])].filter((feed) => feed !== source);
  const sources = await Promise.allSettled([
    source ? loadFeed(source) : fetchText(
      buildArchiveUrl(range), NEWS_INDEX_CACHE_MAX_AGE_MS, "the GitHub Copilot changelog index",
    ).then((html) => parseArchiveEntries(html, range).map((post) => ({ ...post, source: "GitHub Copilot changelog" }))),
    ...(options.includeAiMl ? [loadBlog().then((posts) => posts.map((post) => ({ ...post, source: "GitHub AI & ML blog" })))] : []),
    ...additionalFeeds.map(loadFeed),
  ]);
  const discoveryErrors = sources.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (discoveryErrors.length === 1) throw discoveryErrors[0];
  if (discoveryErrors.length) {
    throw new AggregateError(discoveryErrors, `Source discovery failed: ${discoveryErrors.map(
      (error) => error instanceof Error ? error.message : String(error),
    ).join("\n")}`);
  }
  return selectArticles(sources.flatMap((result) => result.status === "fulfilled" ? result.value : []), options);
}

/** Prepares only the selected entries, preserving their discovery order. */
export async function prepareChangelog(
  selection: ArticleSelection,
  options: ChangelogCollectionOptions = {},
): Promise<ChangelogPost[]> {
  const fetchText = createTextFetcher(options);
  const selectedPosts = selection.selected;
  await options.onArticlesDiscovered?.(selectedPosts.length);
  const posts = new Array<ChangelogPost>(selectedPosts.length);
  const failures: Array<{ post: ArchivePost; error: unknown }> = [];
  let completed = 0;
  const concurrency = 5;
  let nextIndex = 0;
  const workerResults = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, selectedPosts.length) }, async () => {
      while (nextIndex < selectedPosts.length) {
        const index = nextIndex++;
        const post = selectedPosts[index];
        let succeeded = false;
        try {
          if (post.content && !options.fullArticles) {
            assertReadableSource(post.content);
            posts[index] = post.content;
          } else {
            const articleHtml = await fetchText(
              post.url,
              NEWS_ARTICLE_CACHE_MAX_AGE_MS,
              `the article "${post.title}"`,
            );
            posts[index] = extractArticleData(
              post.title,
              post.url,
              post.publishedAt,
              articleHtml,
            );
          }
          succeeded = true;
        } catch (error) {
          failures.push({ post, error });
        }
        completed += 1;
        await options.onArticleProgress?.({
          completed,
          total: selectedPosts.length,
          title: post.title,
          succeeded,
        });
      }
    }),
  );
  const progressFailures = workerResults.filter((result) => result.status === "rejected");
  if (progressFailures.length) {
    const errors: unknown[] = progressFailures.map((result) => result.reason);
    throw new AggregateError(errors, `Source preparation progress reporting failed: ${errors.map(
      (error) => error instanceof Error ? error.message : String(error),
    ).join("; ")}`);
  }
  if (failures.length) {
    const details = failures
      .slice(0, 5)
      .map(
        ({ post, error }) =>
          `- "${post.title}" (${post.url}): ${error instanceof Error ? error.message : String(error)}`,
      )
      .join("\n");
    const omitted = failures.length > 5 ? `\n- ${failures.length - 5} more download failures.` : "";
    throw new Error(
      [
        `Source preparation failed: ${failures.length} of ${selectedPosts.length} articles could not be prepared.`,
        "Copilot enrichment was not started because every selected article must be available first.",
        details + omitted,
        `Successfully downloaded articles remain cached in ${options.cacheDirectory ?? defaultNewsCacheDirectory()}. Fix the reported connection or URL problem, then rerun the same command.`,
      ].join("\n"),
    );
  }
  return posts;
}

export async function collectChangelog(
  range: DateRange,
  source?: string,
  options: ChangelogCollectionOptions = {},
): Promise<ChangelogPost[]> {
  return prepareChangelog(await discoverChangelog(range, source, options), options);
}
