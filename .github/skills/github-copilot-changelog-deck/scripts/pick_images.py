#!/usr/bin/env python3
"""Pick the EXPLANATORY image of each changelog post (screenshot, UI, diagram) and reject the generic
changelog banners. Offline by design: it never opens a network connection — the agent downloads the
files itself (curl, requests, or its own web fetch). Needs Pillow.

1) List the image URLs of every post, in document order:
     python pick_images.py urls --news news.json --feed feed.xml [--pages pages/] > image_urls.json
   feed.xml  = the saved RSS feed https://github.blog/changelog/label/copilot/feed/ (each item's
               content:encoded holds the full post HTML); pages/<id>.html = saved post pages (fallback,
               also gives og:image). Output: {"<id>": ["https://…png", …]}.
2) Download them into raw/<id>/01.<ext>, 02.<ext>, … keeping that order (e.g. curl -L -o).
3) Choose:
     python pick_images.py pick --news news.json --raw raw/ --images images/ [--update]
   RULE: the article image ALWAYS wins; only the generic changelog banner (the default social image:
   dark ground, glowing octocat dome, "Changelog"/post title, RELEASE/IMPROVEMENT/RETIRED tag — any colour,
   any size) is rejected, recognised by its LOOK (banner.py), never by its size. Images under 400 px wide
   and unreadable files are skipped too. The first image left becomes images/<id>.jpg (max 1600 px, q85).
   Writes images/_report.json {id: {status: article|needs_illustration, source, size, banner_score,
   review, rejected[]}}; with --update sets image / image_kind "article" in news.json and REPLACES a
   previously generated illustration when an article image exists.
needs_illustration ids (no image, or only the banner) get a generated 2:3 illustration (Cowork) or no
image (build_deck.py then shows the section icon). review=true (score 0.74-0.82): LOOK at the image.
"""
import argparse, glob, json, os, re, sys, urllib.parse
from html.parser import HTMLParser
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from banner import is_changelog_banner  # noqa: E402

SKIP = re.compile(r"(avatar|gravatar|logo|octicon|emoji|favicon|\.svg(\?|$)|/icons?/)", re.I)


class Imgs(HTMLParser):
    def __init__(self):
        super().__init__(); self.imgs, self.og = [], None

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == "meta" and a.get("property") in ("og:image", "twitter:image") and not self.og:
            self.og = a.get("content")
        if tag in ("img", "source"):
            src = a.get("src") or a.get("data-src") or (a.get("srcset") or "").split(" ")[0]
            if src and not src.startswith("data:"): self.imgs.append(src)


def image_urls(html, base):
    p = Imgs(); p.feed(html); seen, out = set(), []
    for u in p.imgs + ([p.og] if p.og else []):
        u = urllib.parse.urljoin(base, u.strip()); k = u.split("?")[0]
        if k not in seen and not SKIP.search(u): seen.add(k); out.append(u)
    return out


def feed_items(path):
    xml = open(path, encoding="utf-8", errors="replace").read(); m = {}
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S):
        link = re.search(r"<link>\s*(.*?)\s*</link>", item, re.S)
        body = re.search(r"<content:encoded>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</content:encoded>", item, re.S)
        if link and body: m[link.group(1).strip().rstrip("/")] = body.group(1)
    return m


def cmd_urls(a, news):
    fm = feed_items(a.feed) if a.feed else {}
    out = {}
    for n in news:
        url = (n.get("url") or "").rstrip("/")
        html = fm.get(url)
        page = os.path.join(a.pages, f"{n['id']}.html") if a.pages else None
        if html is None and page and os.path.exists(page): html = open(page, encoding="utf-8", errors="replace").read()
        out[str(n["id"])] = image_urls(html, url or "https://github.blog/") if html else []
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1); print()
    print(f"{sum(1 for v in out.values() if v)}/{len(out)} news con immagini candidate", file=sys.stderr)


def cmd_pick(a, news):
    os.makedirs(a.images, exist_ok=True); rep = {}
    for n in news:
        i = str(n["id"]); out = os.path.join(a.images, f"{i}.jpg")
        r = dict(status="needs_illustration", rejected=[])
        for f in sorted(glob.glob(os.path.join(a.raw, i, "*"))):
            try: im = Image.open(f); im.load()
            except Exception: r["rejected"].append(dict(file=f, reason="non leggibile")); continue
            w, h = im.size
            if w < 400: r["rejected"].append(dict(file=f, size=[w, h], reason="troppo piccola")); continue
            ban, score, review = is_changelog_banner(im)
            if ban: r["rejected"].append(dict(file=f, size=[w, h], banner_score=score, reason="banner generico del changelog")); continue
            if im.mode in ("P", "RGBA", "LA"):
                bg = Image.new("RGB", im.size, (15, 10, 38)); im = im.convert("RGBA"); bg.paste(im, mask=im.split()[-1]); im = bg
            im = im.convert("RGB"); im.thumbnail((1600, 1600)); im.save(out, quality=85, optimize=True)
            r.update(status="article", source=f, size=[w, h], banner_score=score, review=review)
            if n.get("image_kind") == "generated": r["replaced_generated"] = n.get("image")
            n["image"], n["image_kind"] = f"{i}.jpg", "article"
            break
        rep[i] = r
    json.dump(rep, open(os.path.join(a.images, "_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if a.update: json.dump(news, open(a.news, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(dict(article=sum(v["status"] == "article" for v in rep.values()),
                          needs_illustration=[k for k, v in rep.items() if v["status"] != "article"],
                          banners_rejected=sum(any("banner" in x["reason"] for x in v["rejected"]) for v in rep.values()),
                          review=[k for k, v in rep.items() if v.get("review")]), ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("urls"); u.add_argument("--news", required=True); u.add_argument("--feed"); u.add_argument("--pages")
    p = sub.add_parser("pick"); p.add_argument("--news", required=True); p.add_argument("--raw", default="raw")
    p.add_argument("--images", default="images"); p.add_argument("--update", action="store_true")
    a = ap.parse_args(); news = json.load(open(a.news, encoding="utf-8"))
    (cmd_urls if a.cmd == "urls" else cmd_pick)(a, news)


if __name__ == "__main__":
    main()
