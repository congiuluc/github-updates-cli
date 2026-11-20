#!/usr/bin/env python3
"""Turn the collected changelog list into master.json + N extraction batches.

Usage:
    python3 split_news.py <list.json> <out_dir> [--batches 4] [--start YYYY-MM-DD --end YYYY-MM-DD]

<list.json> is a JSON array of {"date": "YYYY-MM-DD", "title": "...", "type": "Release|Improvement|Retired",
"url": "..." (optional), "section": "..." (optional first guess)} read from the GitHub Changelog
Copilot label. Weekly roundups ("GitHub Copilot weekly release(s) ...") and posts outside the period
are dropped. Writes <out_dir>/master.json (with ids 1..N, newest first) and <out_dir>/in_<k>.json
(round-robin batches for the parallel per-post extraction).
"""
import argparse, json, os, re
from collections import Counter

ap = argparse.ArgumentParser()
ap.add_argument("list_json"); ap.add_argument("out_dir")
ap.add_argument("--batches", type=int, default=4)
ap.add_argument("--start"); ap.add_argument("--end")
a = ap.parse_args()
raw = json.load(open(a.list_json, encoding="utf-8"))
keep, dropped, seen = [], [], set()
for r in raw:
    t = r["title"].strip()
    if re.search(r"weekly release", t, re.I): dropped.append(t); continue
    if (a.start and r["date"] < a.start) or (a.end and r["date"] > a.end): continue
    if (r["date"], t) in seen: continue
    seen.add((r["date"], t)); keep.append(r)
keep.sort(key=lambda r: r["date"], reverse=True)
items = [dict(id=i + 1, date=r["date"], title=r["title"].strip(), type=r.get("type", "Release"),
              section=r.get("section") or {"retired": "retired", "improvement": "improvement"}.get(r.get("type", "").lower(), "release"),
              url=r.get("url")) for i, r in enumerate(keep)]
os.makedirs(a.out_dir, exist_ok=True)
json.dump(items, open(os.path.join(a.out_dir, "master.json"), "w"), ensure_ascii=False, indent=1)
for k in range(a.batches):
    json.dump(items[k::a.batches], open(os.path.join(a.out_dir, f"in_{k}.json"), "w"), ensure_ascii=False, indent=1)
print(len(items), "news;", "excluded weekly:", dropped, ";", dict(Counter(i["type"] for i in items)))
