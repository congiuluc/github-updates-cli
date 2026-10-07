import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { load } from "cheerio";
import { expect, test, vi } from "vitest";

const html = await readFile(resolve("docs", "index.html"), "utf8");
const script = await readFile(resolve("docs", "assets", "docs.js"), "utf8");

function browser(hash = "", mobile = false) {
  const $ = load(html);
  type Element = ReturnType<typeof $>[number];
  type Handler = (event: {
    target: DomElement;
    button: number;
    key?: string;
    ctrlKey?: boolean;
    preventDefault(): void;
  }) => void;
  const nodes = new Map<Element, DomElement>();
  const wrap = (node: Element): DomElement => {
    let result = nodes.get(node);
    if (!result) {
      result = new DomElement(node);
      nodes.set(node, result);
    }
    return result;
  };
  let activeElement: DomElement | undefined;
  const listeners = new Map<string, Handler[]>();
  const windowListeners = new Map<string, (() => void)[]>();
  const scroll = vi.fn();
  const location = { hash, href: `https://example.github.io/github-updates-cli/${hash}` };
  const history = [hash];
  let historyIndex = 0;
  const hashChange = (next: string) => {
    location.hash = next;
    for (const handler of windowListeners.get("hashchange") ?? []) handler();
  };

  class DomElement {
    handlers = new Map<string, Handler[]>();
    value = "";
    dataset: Record<string, string> = {};
    constructor(readonly node: Element) {}
    get id() { return $(this.node).attr("id") ?? ""; }
    get hash() { return $(this.node).attr("href") ?? ""; }
    get target() { return $(this.node).attr("target"); }
    get textContent() { return $(this.node).text(); }
    set textContent(value: string) { $(this.node).text(value); }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(value: boolean) {
      if (value) this.setAttribute("hidden", "");
      else this.removeAttribute("hidden");
    }
    get open() { return this.hasAttribute("open"); }
    set open(value: boolean) {
      if (value) this.setAttribute("open", "");
      else this.removeAttribute("open");
    }
    set tabIndex(value: number) { this.setAttribute("tabindex", String(value)); }
    getAttribute(name: string) { return $(this.node).attr(name); }
    setAttribute(name: string, value: string) { $(this.node).attr(name, value); }
    removeAttribute(name: string) { $(this.node).removeAttr(name); }
    hasAttribute(name: string) { return $(this.node).attr(name) !== undefined; }
    closest(selector: string) {
      const result = $(this.node).closest(selector).get(0);
      return result ? wrap(result) : null;
    }
    querySelectorAll(selector: string) { return $(this.node).find(selector).toArray().map(wrap); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(name: string, handler: Handler) {
      this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]);
    }
    focus() { activeElement = this; }
    scrollIntoView() { scroll(this.id); }
    append(child: DomElement) { $(this.node).append(child.node); }
    replaceChildren() { $(this.node).empty(); }
    set href(value: string) { this.setAttribute("href", value); }
    click() { click(this); }
  }
  const document = {
    title: "",
    documentElement: wrap($("html")[0]),
    querySelector: (selector: string) => {
      const node = $(selector).get(0);
      return node ? wrap(node) : null;
    },
    querySelectorAll: (selector: string) => $(selector).toArray().map(wrap),
    getElementById: (id: string) => document.querySelectorAll("[id]").find((node) => node.id === id) ?? null,
    createElement: (tag: string) => wrap($(`<${tag}>`)[0]),
    addEventListener: (name: string, handler: Handler) => {
      listeners.set(name, [...listeners.get(name) ?? [], handler]);
    },
  };
  const event = (target: DomElement, extra: { key?: string; ctrlKey?: boolean } = {}) => ({
    target, button: 0, preventDefault: vi.fn(), ...extra,
  });
  const click = (target: DomElement, ctrlKey = false) => {
    const clickEvent = event(target, { ctrlKey });
    for (const handler of listeners.get("click") ?? []) handler(clickEvent);
    if (ctrlKey) return;
    const link = target.closest("a");
    if (link?.hash && location.hash !== link.hash) {
      history.splice(++historyIndex, Infinity, link.hash);
      hashChange(link.hash);
    }
  };
  runInNewContext(script, {
    document, location, URL, URIError, console,
    localStorage: { setItem: vi.fn() },
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout, clearTimeout,
    window: {
      matchMedia: (query: string) => ({ matches: query.includes("max-width") && mobile, addEventListener: vi.fn() }),
      addEventListener: (name: string, handler: () => void) => {
        windowListeners.set(name, [...windowListeners.get(name) ?? [], handler]);
      },
    },
  });
  const find = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing fixture element: ${selector}`);
    return node;
  };
  return {
    document, location, scroll, find,
    visible: () => document.querySelectorAll(".doc-section").filter((node) => !node.hidden).map((node) => node.id),
    active: () => activeElement?.id,
    current: () => find("#docs-nav [aria-current]").hash,
    click: (selector: string, ctrlKey = false) => click(find(selector), ctrlKey),
    back: () => hashChange(history[--historyIndex]),
    forward: () => hashChange(history[++historyIndex]),
    search(query: string) {
      const input = find("#docs-search");
      input.value = query;
      for (const handler of input.handlers.get("input") ?? []) handler(event(input));
    },
    key(key: string) {
      const target = activeElement ?? find("body");
      for (const handler of target.handlers.get("keydown") ?? []) handler(event(target, { key }));
      for (const handler of listeners.get("keydown") ?? []) handler(event(target, { key }));
    },
  };
}

test.each([
  ["", "overview"], ["#install", "install"], ["#features", "overview"],
  ["#usage-title", "usage"], ["#cli%2Dreference", "cli-reference"], ["#missing", "overview"],
])("opens the containing topic for direct link %s", (hash, topic) => {
  const page = browser(hash);
  expect(page.visible()).toEqual([topic]);
  expect(page.current()).toBe(`#${topic}`);
  expect(page.document.title).toContain("Copilot Changelog CLI");
});

test("navigates sidebar, cross-topic links, overview and browser history", () => {
  const page = browser();
  page.click('#docs-nav a[href="#install"]');
  expect(page.visible()).toEqual(["install"]);
  expect(page.active()).toBe("install");
  expect(page.scroll).toHaveBeenLastCalledWith("install");
  page.click('#docs-nav a[href="#resume"]');
  expect(page.visible()).toEqual(["resume"]);
  page.back();
  expect(page.visible()).toEqual(["install"]);
  page.forward();
  expect(page.visible()).toEqual(["resume"]);
  page.click(".page-footer a");
  expect(page.visible()).toEqual(["overview"]);
  page.click('.feature[href="#review"]');
  expect(page.visible()).toEqual(["review"]);
});

test("search covers hidden sections, Enter opens a result and Escape restores navigation", () => {
  const page = browser();
  page.key("/");
  expect(page.active()).toBe("docs-search");
  page.search("checkpoint");
  expect(page.find("#docs-nav").hidden).toBe(true);
  expect(page.find('#search-results a[href="#resume"]').textContent).toContain("Continue");
  page.key("Enter");
  expect(page.visible()).not.toEqual(["overview"]);
  page.find("#docs-search").focus();
  page.key("Escape");
  expect(page.find("#docs-nav").hidden).toBe(false);
  expect(page.find("#search-results").hidden).toBe(true);
});

test("skip link retains the selected topic and modified clicks do not switch it", () => {
  const page = browser("#resume");
  page.click(".skip-link");
  expect(page.visible()).toEqual(["resume"]);
  expect(page.active()).toBe("main");
  page.click('#docs-nav a[href="#install"]', true);
  expect(page.visible()).toEqual(["resume"]);
});

test("mobile navigation collapses the topic picker and focuses the selected section", () => {
  const page = browser("#install", true);
  expect(page.find("#contents").open).toBe(false);
  page.key("/");
  expect(page.find("#contents").open).toBe(true);
  page.click('#docs-nav a[href="#usage"]');
  expect(page.visible()).toEqual(["usage"]);
  expect(page.find("#contents").open).toBe(false);
  expect(page.active()).toBe("usage");
});
