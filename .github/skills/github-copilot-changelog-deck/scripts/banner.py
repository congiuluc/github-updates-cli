#!/usr/bin/env python3
"""Detect the GENERIC GitHub Changelog banner (the default social image of every post).

The banner always has the same composition whatever its colour (blue = improvement, green = new
release, red = retired) and size (1200x630/631, 2400x1260, …): dark ground, a glowing dome with the
octocat silhouette in the top half, then "Changelog" or the post title and a type tag. Such an image
explains nothing, so it never goes on a slide; every OTHER image of the post (screenshot, UI, diagram,
infographic, code) is the article image to use.

Test: brightness map (max of R,G,B) of the image scaled to 48x25, top 13 rows, Pearson correlation
with the reference map below (mean of 35 real banners). Calibrated on 89 changelog images:
banners >= 0.89, article images <= 0.73. Threshold 0.82; 0.74-0.82 = "look at it".

  python banner.py img1.png img2.jpg …     -> one JSON line per image {file, score, banner, review}
"""
import base64, json, sys
from PIL import Image

_W, _H, _ROWS = 48, 25, 13
_TPL = base64.b64decode("FxkbHiAjJykuLzM2ODs8QEFDRUdISUpKSkpJSEZFQ0FAPTs4NTQvLionIyAdGxgXFhcZGx0gJCYrLTEyNTg5PD1AQUNGTVRYWFRNRkJBQD48OTg1MzEtKyckIR4bGRcWFRYYGhweIiQoKi0vMjQ1ODk8SGB1gISGhYSAdWBJPTk4NTQyLy4qKCQiHxwaGBYVExUWGBocHyIlJyssLzEyNT5eeoF/f39/f39/f4B6Xj00MjEvLCsnJSEfHBoYFhUTEhMVFhgaHR8iJCcpKy0vQ2x4dnd3eHh4eHh4eHd2eGxDLy0rKSckIh8cGhgXFRMSERITFRcZGh0fISQmKCpBbG5ubm9wcHFxcXFwcG9ubW5xQykoJiUhHxwaGBYVExIRDxESExUWGBocHiAiJDVkZWVmZmdoaGhpaWhoaGdmZWVmVi0lIiEeHBoYFhQTERAPDg8QERIUFhcZHB0fJVFcXFtERFRfYF9fX19gX1VFQlpcWkMjHx4bGRcVFBIREA8ODA0ODxASExUWGBocNFNSU1ArJCo8QDk1NTg/PSskKU5TUk4tHBoYFhUTEhAPDg0MCgwMDg8QERIUFRYbPklKS0cmICEiIiIjIyMjIiEgJEVLSkg7GhcVExIREA8ODQwKCQoLDA0ODxAREhMdPEBBQkAjHB0eHh4fHx4eHh0cIT5CQUA8HhMSERAPDg0MCwoJCQkJCgsMDQ4PEBEiNzc4Oi4aGRoaGxsbGxsbGhkaGiw5ODc2IhEQDw4NDAsKCQkJCQkJCQkKCwwNDg8jLzAxMR0WGBgZGRoaGhkaGRgYFxswMDAuIw8ODQwLCgkJCQkJ")
THRESHOLD, REVIEW = 0.82, 0.74


def _vec(img):
    im = img.convert("RGB").resize((_W, _H), Image.BILINEAR)
    px = list(im.getdata())[: _W * _ROWS]
    return [max(p) for p in px]


def _corr(a, b):
    n = len(a); ma, mb = sum(a) / n, sum(b) / n
    da = [x - ma for x in a]; db = [x - mb for x in b]
    num = sum(x * y for x, y in zip(da, db))
    den = (sum(x * x for x in da) * sum(y * y for y in db)) ** 0.5
    return num / den if den else 0.0


def banner_score(src):
    """src: path or PIL image -> correlation with the changelog banner (-1..1)."""
    img = Image.open(src) if isinstance(src, str) else src
    if img.mode in ("P", "RGBA", "LA"):
        bg = Image.new("RGB", img.size, (0, 0, 0)); rgba = img.convert("RGBA"); bg.paste(rgba, mask=rgba.split()[-1]); img = bg
    return _corr(_vec(img), list(_TPL))


def is_changelog_banner(src):
    """-> (is_banner, score, needs_review)"""
    s = banner_score(src)
    return s >= THRESHOLD, round(s, 3), REVIEW <= s < THRESHOLD


if __name__ == "__main__":
    for f in sys.argv[1:]:
        b, s, r = is_changelog_banner(f)
        print(json.dumps(dict(file=f, score=s, banner=b, review=r)))
