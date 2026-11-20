#!/usr/bin/env python3
"""Build the "GitHub Copilot - Novità dal changelog" deck locally with python-pptx.

Portable: runs in GitHub Copilot (CLI / VS Code agent), Cowork or any Python 3.9+
with `pip install python-pptx` (which installs Pillow).

Usage:
  python build_deck.py --news news.json --config deck_config.json \
      --images images/ --assets assets/ --out "GitHub Copilot - Novità dal changelog (novembre 2026).pptx"

Inputs
  news.json    array of Italian records (see references/news-record-format.md):
               id, date, title, type, section, url, category, status, hero_value,
               hero_label, summary, points[4], availability, how_to, facts[3], doc_links[]
               optional: image (file name inside --images), image_kind ("article"|"generated")
  deck_config  period_start, period_end, author, deck_date, highlights[], actions[]
  --images     folder with one image per news: <id>.jpg / <id>.png (or record["image"]);
               a news without image gets its section icon on the cover
               landscape image -> framed card (no caption);
               portrait image (2:3 generated illustration) -> full-height right panel
  --assets     folder with cover.jpg, closer.jpg and ic-<section>.png icons
Rules enforced here (not left to the model):
  * weekly roundups ("GitHub Copilot weekly release…") and records outside the period are dropped
  * six sections in fixed order, newest first inside each section
  * text is auto-fitted (font shrinks, never below 11 pt) so nothing overflows its box
  * one dark ground on every slide, one rounded card shape, Segoe UI
  * every news slide (cover + detail) shows its date bottom-right as yyyy-MM-dd
  * section index slides ("<Sezione>: le news in breve") are HIDDEN by default (show="0")
  * images are recompressed (max 1600 px, JPEG q82) to keep the file small
  * a generic changelog banner (banner.py) is never placed: the cover falls back to the section icon
    and the id is listed in "banner_rejected" of the JSON summary
"""
import argparse, datetime as dt, io, json, os, re, sys
from collections import Counter
from PIL import Image, ImageFont
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn
from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from banner import is_changelog_banner  # noqa: E402  (generic changelog banner = never on a slide)

W, H = 12192000, 6858000
M = 457200
CW = W - 2 * M
BG, CARD, CARD2, BORDER = "0F0A26", "1B1538", "141026", "2E2752"
INK, INK2, MUTED, ACC = "EDEAF7", "C4BEDD", "B8B1D6", "A371F7"
FONT, MONO = "Segoe UI", "Consolas"
SEC = [
    ("modelli", "Modelli", "F778BA", "3A1530", "Nuovi modelli, Fusion e benchmark"),
    ("release", "Release", "3FB950", "10301E", "Nuove funzionalità e integrazioni"),
    ("improvement", "Improvement", "A371F7", "2A1A52", "Miglioramenti a funzionalità esistenti"),
    ("governance", "Governance", "58A6FF", "0E2545", "Policy, identità, licenze, sicurezza e metriche per gli admin"),
    ("ide", "IDE", "39C5CF", "0B3036", "VS Code, Visual Studio, JetBrains, Xcode ed Eclipse"),
    ("retired", "Retired", "F0883E", "3A2014", "Modelli e componenti in dismissione"),
]
SM = {s[0]: s for s in SEC}
MESI = ["", "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto",
        "settembre", "ottobre", "novembre", "dicembre"]
MS = ["", "gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
WEEKLY = re.compile(r"weekly release", re.I)


def D(s):
    return dt.date.fromisoformat(s[:10])


def dl(s):
    d = D(s); return f"{d.day} {MESI[d.month]} {d.year}"


def ds(s):
    d = D(s); return f"{d.day:02d} {MS[d.month]}"


def dd(s):
    d = D(s); return f"{d.day:02d}/{d.month:02d}/{d.year}"


def pillc(st):
    st = (st or "").upper()
    if st == "GA": return "3FB950", "10301E"
    if "PREVIEW" in st: return "E3B341", "3A2E0C"
    if "DISM" in st: return "F0883E", "3A2014"
    return "C4BEDD", "2A2346"


# ---------------------------------------------------------------- text measuring
def _font_paths(bold):
    names = (["segoeuib.ttf"] if bold else ["segoeui.ttf"]) + \
            (["DejaVuSans-Bold.ttf"] if bold else ["DejaVuSans.ttf"])
    dirs = [r"C:\Windows\Fonts", "/usr/share/fonts/dejavu-sans-fonts", "/usr/share/fonts/truetype/dejavu",
            "/Library/Fonts", "/System/Library/Fonts/Supplemental", os.path.expanduser("~/.fonts")]
    for n in names:
        for d in dirs:
            p = os.path.join(d, n)
            if os.path.exists(p): return p
    return None


_FC = {}


def _font(size, bold):
    k = (round(size * 4), bold)
    if k not in _FC:
        p = _font_paths(bold)
        _FC[k] = ImageFont.truetype(p, int(size * 4)) if p else None
    return _FC[k]


def text_w(t, size, bold=False):
    """width in EMU of a single line (measured at 4x for precision)."""
    f = _font(size, bold)
    if f is None:
        return len(t) * size * (7400 if not bold else 7900)
    return f.getlength(t) / 4 * 12700 * 1.03


def wrap_lines(t, size, width, bold=False):
    lines = 0
    for para in str(t).split("\n"):
        words, cur = para.split(" "), ""
        n = 1
        for w in words:
            n += int(text_w(w, size, bold) // max(1, width))  # a word wider than the box breaks mid-word
            cand = (cur + " " + w).strip()
            if text_w(cand, size, bold) <= width or not cur:
                cur = cand
            else:
                n += 1; cur = w
        lines += n
    return lines


def fit(t, size, w, h, bold=False, minsize=11, ls=1.2):
    """largest size <= size so that the wrapped text fits the box (inner margins 0.1in)."""
    iw, ih = w - 2 * 91440, h - 2 * 45720
    s = size
    while s > minsize:
        if wrap_lines(t, s, iw, bold) * s * 12700 * ls <= ih: return s
        s -= 1
    return minsize


def one_line(t, size, w, bold=True, minsize=11, safety=1.15):
    """largest size <= size at which each word of t fits on one line (no mid-word break of a hero value)."""
    iw = w - 2 * 91440; longest = max(str(t).split() or [""], key=len)
    while size > minsize and text_w(longest, size, bold) * safety > iw: size -= 1
    return size


def clip(t, n):
    t = str(t or "")
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


# ---------------------------------------------------------------- pptx helpers
def rgb(h): return RGBColor.from_string(h)


def _shadow(shape):
    spPr = shape._element.spPr
    eff = etree.SubElement(spPr, qn("a:effectLst"))
    sh = etree.SubElement(eff, qn("a:outerShdw"), blurRad="190500", dist="38100", dir="5400000", algn="t", rotWithShape="0")
    c = etree.SubElement(sh, qn("a:srgbClr"), val="000000")
    etree.SubElement(c, qn("a:alpha"), val="40000")


def box(s, x, y, w, h, fill, line=None, lw=9525, shadow=False, shape="round", radius=110000):
    kind = {"round": MSO_SHAPE.ROUNDED_RECTANGLE, "rect": MSO_SHAPE.RECTANGLE, "oval": MSO_SHAPE.OVAL,
            "arrow": MSO_SHAPE.RIGHT_ARROW}[shape]
    sp = s.shapes.add_shape(kind, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    if shape == "round":
        sp.adjustments[0] = min(0.5, radius / max(1, min(w, h)))
    sp.fill.solid(); sp.fill.fore_color.rgb = rgb(fill)
    if line:
        sp.line.color.rgb = rgb(line); sp.line.width = Emu(lw)
    else:
        sp.line.fill.background()
    if shadow: _shadow(sp)
    sp.text_frame.text = ""
    return sp


def _runfmt(r, size, color, bold, font, ls=None):
    r.font.size = Pt(size); r.font.bold = bold; r.font.name = font
    r.font.color.rgb = rgb(color)
    rPr = r._r.get_or_add_rPr()
    for tag in ("a:latin", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None: el = etree.SubElement(rPr, qn(tag))
        el.set("typeface", font)
    if ls: rPr.set("spc", str(int(ls * 100)))


def text(s, x, y, w, h, t=None, size=14, color=INK, bold=False, align="left", anchor="top",
         font=FONT, ls=None, paras=None, autofit=True, minsize=11, link=None, target=None):
    """paras: list of dict(text,size,color,bold). Auto-fits by shrinking all sizes together."""
    tb = s.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    tf = tb.text_frame; tf.word_wrap = True
    tf.margin_left = tf.margin_right = Emu(91440); tf.margin_top = tf.margin_bottom = Emu(45720)
    tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}[anchor]
    if paras is None: paras = [dict(text=t, size=size, color=color, bold=bold)]
    if autofit:
        # shrink factor applied to every paragraph until the whole block fits
        for k in range(0, 12):
            tot = 0
            for p in paras:
                sz = max(minsize, p.get("size", size) - k)
                tot += wrap_lines(p["text"], sz, w - 182880, p.get("bold", bold)) * sz * 12700 * 1.2
                lw_ = max(str(p["text"]).split() or [""], key=len)          # never break a word mid-way
                if text_w(lw_, sz, p.get("bold", bold)) * 1.12 > w - 182880: tot = h * 10
            if tot <= h - 91440 or all(max(minsize, p.get("size", size) - k) == minsize for p in paras): break
        shrink = k
    else:
        shrink = 0
    for i, p in enumerate(paras):
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        para.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}[p.get("align", align)]
        r = para.add_run(); r.text = str(p["text"])
        _runfmt(r, max(minsize, p.get("size", size) - shrink), p.get("color", color), p.get("bold", bold),
                p.get("font", font), p.get("ls", ls))
        if link and i == len(paras) - 1: r.hyperlink.address = link
    if target is not None:
        tb.click_action.target_slide = target
    return tb


def picture(s, path, x, y, w, h, mode="cover", alt=""):
    im = Image.open(path); iw, ih = im.size
    if mode == "cover":
        pic = s.shapes.add_picture(path, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
        r_img, r_box = iw / ih, w / h
        if r_img > r_box:
            c = (1 - r_box / r_img) / 2; pic.crop_left = c; pic.crop_right = c
        else:
            c = (1 - r_img / r_box) / 2; pic.crop_top = c; pic.crop_bottom = c
    else:  # contain
        sc = min(w / iw, h / ih); pw_, ph_ = iw * sc, ih * sc
        pic = s.shapes.add_picture(path, Emu(int(x + (w - pw_) / 2)), Emu(int(y + (h - ph_) / 2)), Emu(int(pw_)), Emu(int(ph_)))
    pic._element.nvPicPr.cNvPr.set("descr", alt[:250])
    return pic


def pill(s, x, y, w, t, col, fill, size=12, h=420000):
    b = box(s, x, y, w, h, fill, line=col, radius=h / 2)
    tf = b.text_frame; tf.margin_left = tf.margin_right = Emu(60000); tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
    r = p.add_run(); r.text = t; _runfmt(r, size, col, True, FONT)
    return b


def pw(t, size=12): return int(text_w(t, size, True) + 300000)


def label(s, x, y, w, t, col=MUTED): text(s, x, y, w, 400000, t, size=12, color=col, bold=True, ls=1, autofit=False)


def eyebrow(s, t, col, w=7400000, y=330000, x=M): text(s, x, y, w, 400000, t, size=12, color=col, bold=True, ls=2, autofit=False)


def footer(s, t, x=M, w=CW, link=None):
    """no source references on the slides: the article reference lives only in the speaker notes."""
    return None


def notes(s, t): s.notes_slide.notes_text_frame.text = t


DATE_X, DATE_Y, DATE_W, DATE_H = W - M - 1500000, H - 300000 - 380000, 1500000, 380000


def date_tag(s, iso):
    """news date, bottom-right of every news slide, ISO yyyy-MM-dd, on an opaque tag (readable over images)."""
    b = box(s, DATE_X, DATE_Y, DATE_W, DATE_H, CARD2, line=BORDER, radius=DATE_H / 2)
    tf = b.text_frame; tf.margin_left = tf.margin_right = Emu(60000); tf.margin_top = tf.margin_bottom = Emu(0)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE; tf.word_wrap = False
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
    r = p.add_run(); r.text = D(iso).isoformat(); _runfmt(r, 13, INK2, True, FONT)
    b.name = "Data news"
    return b


def hide(s):
    """hidden by default in the slide show (still reachable through the agenda/index links)."""
    s._element.set("show", "0")


def bullet_row(s, x, y, w, h, t, col, size=14, mark="dot", tint=None):
    """bullet always sits on the first line (top-anchored text)."""
    sz = fit(t, size, w - 360000, h)
    first_center = y + 45720 + sz * 12700 * 0.6
    if mark == "dot":
        box(s, x + 30000, first_center - 80000, 160000, 160000, col, shape="oval")
    elif mark in ("check", "num"):
        b = box(s, x, first_center - 190000, 380000, 380000, tint or CARD2, line=col, shape="oval")
        tf = b.text_frame; tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = Emu(0)
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
        r = p.add_run(); r.text = "✓" if mark == "check" else mark_num(t); _runfmt(r, 12, col, True, FONT)
    text(s, x + 440000, y, w - 440000, h, t, size=sz, color=INK, autofit=False)


def mark_num(_): return ""


def card_text(s, x, y, w, h, head, body, col, fill=CARD, line=BORDER, size=13):
    box(s, x, y, w, h, fill, line=line, shadow=fill == CARD)
    text(s, x + 160000, y + 70000, w - 320000, h - 140000,
         paras=[dict(text=head, size=12, bold=True, color=col, ls=1), dict(text=body, size=size, color=INK)])


# ---------------------------------------------------------------- sections xml
def add_sections(prs, groups):
    """groups: list of (name, [slide objects])."""
    P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
    pres = prs.part._element
    extLst = pres.find(qn("p:extLst"))
    if extLst is None: extLst = etree.SubElement(pres, qn("p:extLst"))
    ext = etree.SubElement(extLst, qn("p:ext"), uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}")
    sl = etree.SubElement(ext, "{%s}sectionLst" % P14, nsmap={"p14": P14})
    import uuid
    for name, slides in groups:
        sec = etree.SubElement(sl, "{%s}section" % P14, name=name, id="{%s}" % str(uuid.uuid4()).upper())
        lst = etree.SubElement(sec, "{%s}sldIdLst" % P14)
        for sld in slides:
            etree.SubElement(lst, "{%s}sldId" % P14, id=str(sld.slide_id))


def set_link_colors(prs, link="C9B6FF", followed="B8B1D6"):
    """hyperlinks use the theme colours: make them readable on the dark ground."""
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    th = prs.slide_master.part.part_related_by(RT.THEME)
    xml = th.blob.decode("utf-8")
    for tag, val in (("hlink", link), ("folHlink", followed)):
        xml = re.sub(r"<a:%s>.*?</a:%s>" % (tag, tag), "<a:%s><a:srgbClr val=\"%s\"/></a:%s>" % (tag, val, tag), xml, flags=re.S)
    th._blob = xml.encode("utf-8")


# ---------------------------------------------------------------- data
def load(args):
    news = json.load(open(args.news, encoding="utf-8"))
    cfg = json.load(open(args.config, encoding="utf-8")) if args.config else {}
    p0, p1 = cfg.get("period_start"), cfg.get("period_end")
    keep, dropped = [], []
    for n in news:
        why = None
        if WEEKLY.search(n.get("title", "")) or n.get("exclude"): why = "riepilogo settimanale/escluso"
        elif p0 and n["date"] < p0: why = "prima del periodo"
        elif p1 and n["date"] > p1: why = "dopo il periodo"
        elif n.get("section") not in SM: why = f"sezione non valida: {n.get('section')}"
        (dropped if why else keep).append((n, why))
    items = {k[0]: [] for k in SEC}
    for n, _ in keep: items[n["section"]].append(n)
    for k in items: items[k].sort(key=lambda n: (n["date"], str(n["id"])), reverse=True)
    return items, cfg, [(n["title"], w) for n, w in dropped]


def prep_image(path, outdir, maxpx=1600):
    os.makedirs(outdir, exist_ok=True)
    im = Image.open(path)
    if im.mode in ("P", "RGBA", "LA"):
        bg = Image.new("RGB", im.size, (15, 10, 38)); im = im.convert("RGBA"); bg.paste(im, mask=im.split()[-1]); im = bg
    im = im.convert("RGB"); im.thumbnail((maxpx, maxpx))
    out = os.path.join(outdir, os.path.splitext(os.path.basename(path))[0] + ".jpg")
    im.save(out, quality=82, optimize=True)
    return out, im.size


def find_image(n, folder):
    cands = [n.get("image")] if n.get("image") else []
    cands += [f"{n['id']}.jpg", f"{n['id']}.png", f"{n['id']}.jpeg", f"{n['id']}.webp"]
    for c in cands:
        if c and os.path.exists(os.path.join(folder, c)): return os.path.join(folder, c)
    return None


# ---------------------------------------------------------------- detail layouts
def header(s, n, key):
    _, name, col, tint, _ = SM[key]
    ty = "" if n["type"].lower() == key else f" · {n['type'].upper()}"
    eyebrow(s, f"{name.upper()} · {ds(n['date']).upper()} {D(n['date']).year}{ty} · DETTAGLIO", col, w=8200000, y=300000)
    pc, pf = pillc(n["status"]); w = pw(n["status"]); pill(s, M + CW - w, 290000, w, n["status"], pc, pf)
    text(s, M, 740000, CW, 1060000, n["title"], size=26, bold=True, minsize=18)


def d_modelli(s, n, col, tint):
    tw = (CW - 3 * 150000) // 4; y = 1900000
    box(s, M, y, tw, 1050000, tint, line=col)
    hv = n["hero_value"]
    text(s, M + 60000, y + 40000, tw - 120000, 560000, hv, size=28, bold=True, color=col, align="center", minsize=16)
    text(s, M + 60000, y + 600000, tw - 120000, 420000, n["hero_label"], size=12, color=INK, align="center")
    for j, f in enumerate(n["facts"][:3]):
        x = M + (j + 1) * (tw + 150000)
        box(s, x, y, tw, 1050000, CARD, line=BORDER, shadow=True)
        text(s, x + 80000, y, tw - 160000, 1050000, f, size=15, bold=True, align="center", anchor="middle")
    label(s, M, 3080000, 6900000, "PERCHÉ CONTA")
    for j, p in enumerate(n["points"][:4]):
        bullet_row(s, M, 3480000 + j * 640000, 6900000, 620000, p, col, size=14)
    rx = M + 7150000; rw = CW - 7150000
    box(s, rx, 3080000, rw, 2820000, CARD, line=BORDER, shadow=True)
    text(s, rx + 180000, 3150000, rw - 360000, 1300000,
         paras=[dict(text="DISPONIBILITÀ", size=12, bold=True, color=col, ls=1), dict(text=n["availability"], size=13)])
    text(s, rx + 180000, 4500000, rw - 360000, 1340000,
         paras=[dict(text="COME ATTIVARLO", size=12, bold=True, color=col, ls=1), dict(text=n["how_to"], size=13)])


def d_release(s, n, col, tint):
    pts = n["points"][:4]; cw = (CW - 200000) // 2; ch = 1200000
    cells = pts + ([None] if len(pts) == 3 else [])
    for j, p in enumerate(cells):
        x = M + (j % 2) * (cw + 200000); y = 1900000 + (j // 2) * (ch + 150000)
        if p is None:
            box(s, x, y, cw, ch, tint, line=col)
            text(s, x + 100000, y, 1900000, ch, n["hero_value"], size=one_line(n["hero_value"], 32, 1900000, minsize=18), bold=True, color=col, align="center", anchor="middle", minsize=18)
            text(s, x + 2100000, y, cw - 2250000, ch, n["hero_label"], size=15, anchor="middle")
            continue
        box(s, x, y, cw, ch, CARD, line=BORDER, shadow=True)
        b = box(s, x + 160000, y + 130000, 520000, 520000, tint, radius=100000)
        tf = b.text_frame; tf.vertical_anchor = MSO_ANCHOR.MIDDLE; tf.margin_left = tf.margin_right = Emu(0)
        pp = tf.paragraphs[0]; pp.alignment = PP_ALIGN.CENTER; r = pp.add_run(); r.text = str(j + 1); _runfmt(r, 15, col, True, FONT)
        text(s, x + 780000, y + 110000, cw - 930000, ch - 180000, p, size=15)
    yb = 4600000; hb = 1300000
    for j, (h_, b_) in enumerate([("DISPONIBILITÀ", n["availability"]), ("COME INIZIARE", n["how_to"])]):
        x = M + j * (cw + 200000)
        box(s, x, yb, cw, hb, CARD2, line=col if j == 0 else BORDER)
        text(s, x + 180000, yb + 60000, cw - 360000, hb - 120000,
             paras=[dict(text=h_, size=12, bold=True, color=col, ls=1), dict(text=b_, size=13)])


def d_improvement(s, n, col, tint):
    lw = 3900000; y = 1900000; hgt = 4000000
    box(s, M, y, lw, hgt, tint, line=col)
    label(s, M + 220000, y + 150000, lw - 440000, "IMPATTO", col)
    text(s, M + 150000, y + 560000, lw - 300000, 1150000, n["hero_value"], size=one_line(n["hero_value"], 54, lw - 300000, minsize=26), bold=True, color=col, minsize=26)
    text(s, M + 220000, y + 1750000, lw - 440000, 800000, n["hero_label"], size=15)
    text(s, M + 220000, y + 2600000, lw - 440000, 1340000,
         paras=[dict(text="DISPONIBILITÀ", size=12, bold=True, color=col, ls=1), dict(text=n["availability"], size=13)])
    rx = M + lw + 250000; rw = CW - lw - 250000
    label(s, rx, 1880000, rw, "COSA MIGLIORA")
    for j, p in enumerate(n["points"][:4]):
        yy = 2300000 + j * 740000
        box(s, rx, yy, rw, 700000, CARD, line=BORDER)
        bullet_row(s, rx + 150000, yy + 30000, rw - 300000, 650000, p, col, size=14, mark="check", tint=tint)
    box(s, rx, 5300000, rw, 600000, CARD2, line=BORDER)
    text(s, rx + 160000, 5300000, rw - 320000, 600000, "Come iniziare: " + n["how_to"], size=13, color=INK2, anchor="middle")


def d_governance(s, n, col, tint):
    cw3 = (CW - 2 * 150000) // 3
    for j, f in enumerate(n["facts"][:3]):
        x = M + j * (cw3 + 150000)
        box(s, x, 1880000, cw3, 480000, tint, line=col)
        text(s, x + 60000, 1880000, cw3 - 120000, 480000, f, size=13, bold=True, align="center", anchor="middle")
    label(s, M, 2480000, 6900000, "COSA CAMBIA PER GLI ADMIN")
    for j, p in enumerate(n["points"][:4]):
        yy = 2900000 + j * 750000
        box(s, M, yy, 6900000, 720000, CARD, line=BORDER)
        bullet_row(s, M + 150000, yy + 35000, 6600000, 660000, p, col, size=14, mark="check", tint=CARD2)
    rx = M + 7150000; rw = CW - 7150000
    box(s, rx, 2480000, rw, 1700000, tint, line=col, lw=19050)
    text(s, rx + 180000, 2540000, rw - 360000, 1580000,
         paras=[dict(text="AZIONE PER L'ADMIN", size=12, bold=True, color=col, ls=1), dict(text=n["how_to"], size=14)])
    card_text(s, rx, 4280000, rw, 1620000, "AMBITO E DISPONIBILITÀ", n["availability"], col)


def d_ide(s, n, col, tint):
    ww = 7300000; y = 1900000; hgt = 4000000
    box(s, M, y, ww, hgt, CARD2, line=BORDER, shadow=True)
    box(s, M, y, ww, 420000, "2A2346", radius=110000)
    for j, c in enumerate(["FF5F57", "FEBC2E", "28C840"]):
        box(s, M + 180000 + j * 230000, y + 140000, 140000, 140000, c, shape="oval")
    text(s, M + 1000000, y, ww - 1200000, 420000, "cosa-cambia.md", size=12, color=MUTED, font=MONO, anchor="middle", autofit=False)
    for j, p in enumerate(n["points"][:4]):
        yy = y + 540000 + j * 850000
        text(s, M + 100000, yy, 500000, 400000, str(j + 1), size=13, color=col, align="right", font=MONO, autofit=False)
        text(s, M + 750000, yy, ww - 950000, 820000, p, size=15)
    rx = M + ww + 250000; rw = CW - ww - 250000
    card_text(s, rx, y, rw, 1950000, "DISPONIBILITÀ", n["availability"], col, line=col)
    card_text(s, rx, y + 2050000, rw, 1950000, "COME INIZIARE", n["how_to"], col)


def norm_date(b, post_date):
    b = b.strip(); y0 = D(post_date).year
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", b)
    if m: return f"{m[3]}/{m[2]}/{m[1]}"
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})", b)
    if m:
        y = y0 if (int(m[2]), int(m[1])) >= (D(post_date).month, D(post_date).day) else y0 + 1
        return f"{int(m[1]):02d}/{int(m[2]):02d}/{y}"
    return b


def date_key(b):
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", b): return b
    m = re.fullmatch(r"(\d{2})/(\d{2})/(\d{4})", b)
    if m: return f"{m[3]}-{m[2]}-{m[1]}"
    m = re.search(r"(\d{4})", b)
    mon = next((i for i, x in enumerate(MS) if x and x in b.lower()), 12)
    return f"{m[1] if m else '9999'}-{mon:02d}-28"


def parse_migrations(n):
    if n.get("migrations"):  # explicit override: [[old, date, alternative], ...]
        return [tuple(r) for r in n["migrations"]], [p for p in n["points"] if "→" not in p]
    rows, other = parse_labelled(n), []
    if rows: return rows, [p for p in n["points"] if not re.match(r"(Modello|Componente|Data|Alternativa)\s*:", p, re.I)]
    for p in n["points"]:
        ok, tmp = True, []
        for sg in [x.strip() for x in re.split(r";\s*", p) if x.strip()]:
            parts = [re.sub(r"\s*\(.*?\)", "", x).strip() for x in sg.split("→")]
            if len(parts) == 3 and len(parts[1]) <= 16 and all(parts): tmp.append((parts[0], norm_date(parts[1], n["date"]), parts[2]))
            else: ok = False
        if ok and tmp: rows += tmp
        else: other.append(p)
    return rows, other


def parse_labelled(n):
    """points like 'Modello: X', 'Data: 18 dicembre 2026 ...', 'Alternativa: Y' -> one migration row."""
    f = {}
    for p in n["points"]:
        m = re.match(r"(Modello|Componente|Data|Alternativa)\s*:\s*(.+)", p, re.I)
        if m: f[m[1].lower()[:4]] = m[2]
    if "mode" in f or "comp" in f:
        if "data" in f and "alte" in f:
            dm = re.search(r"(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})", f["data"], re.I)
            d = f"{int(dm[1]):02d}/{MESI.index(dm[2].lower()):02d}/{dm[3]}" if dm else clip(f["data"], 16)
            alt = re.sub(r"\s*\(.*?\)", "", f["alte"]).strip()
            return [(f.get("mode") or f.get("comp"), d, alt)]
    return []


def d_retired(s, n, col, tint):
    rows, other = parse_migrations(n)
    cols = [(0, 4000000), (4500000, 1900000), (6900000, CW - 6900000)]
    if rows:
        for ci, h_ in enumerate(["DA DISMETTERE", "DATA", "ALTERNATIVA"]):
            label(s, M + cols[ci][0] + 120000, 1880000, cols[ci][1], h_)
        rh = 560000 if len(rows) <= 4 else 430000
        for j, (a, b, c) in enumerate(rows[:6]):
            yy = 2300000 + j * (rh + 50000)
            for (cx, cwid), t, fill, line, tc in [(cols[0], a, "3A2014", col, INK), (cols[1], b, CARD, BORDER, col), (cols[2], c, "10301E", "3FB950", INK)]:
                box(s, M + cx, yy, cwid, rh, fill, line=line, radius=90000)
                text(s, M + cx + 60000, yy, cwid - 120000, rh, t, size=13, bold=True, color=tc, align="center", anchor="middle")
            box(s, M + 4060000, yy + rh // 2 - 100000, 360000, 200000, "4A4270", shape="arrow")
            box(s, M + 6460000, yy + rh // 2 - 100000, 360000, 200000, "4A4270", shape="arrow")
        yn = 2300000 + min(6, len(rows)) * (rh + 50000) + 60000
    else:
        yn = 1900000
    for p in other:
        if yn + 520000 > 5150000: break
        bullet_row(s, M, yn, CW, 520000, p, col, size=14); yn += 560000
    box(s, M, 5280000, CW, 620000, tint, line=col)
    text(s, M + 180000, 5280000, CW - 360000, 620000, "Azione richiesta: " + n["how_to"], size=13, anchor="middle")


DET = dict(modelli=d_modelli, release=d_release, improvement=d_improvement, governance=d_governance, ide=d_ide, retired=d_retired)


def nnotes(n, img_kind=None):
    """speaker notes of a news slide = ONLY the reference to the changelog article."""
    return f"Articolo: {n['title']} – GitHub Changelog, {dl(n['date'])}\n{n.get('url') or 'URL non disponibile'}"


# ---------------------------------------------------------------- build
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--news", required=True); ap.add_argument("--config")
    ap.add_argument("--images", default="images"); ap.add_argument("--assets", default="assets")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    items, cfg, dropped = load(args)
    cnt = {k: len(v) for k, v in items.items()}; TOT = sum(cnt.values())
    allnews = [n for k in items for n in items[k]]
    p0 = cfg.get("period_start") or min(n["date"] for n in allnews)
    p1 = cfg.get("period_end") or max(n["date"] for n in allnews)
    work = os.path.join(os.path.dirname(os.path.abspath(args.out)) or ".", ".deck_img")

    prs = Presentation(); prs.slide_width, prs.slide_height = W, H
    banner_rejected, img_stats = [], Counter()
    blank = prs.slide_layouts[6]

    def new():
        s = prs.slides.add_slide(blank)
        s.background.fill.solid(); s.background.fill.fore_color.rgb = rgb(BG)
        return s

    asset = lambda f: os.path.join(args.assets, f)
    groups = []
    # --- plan slides first so index rows can link to covers
    S_cover, S_over, S_agenda = new(), new(), new()
    groups.append(("Introduzione", [S_cover, S_over, S_agenda]))
    plan = {}
    for key, *_ in SEC:
        div = new(); L = items[key]
        chunks = [L[i:i + 7] for i in range(0, len(L), 7)] or [[]]
        idx = [new() for _ in chunks]
        pairs = [(new(), new()) for _ in L]
        cal = []
        if key == "retired":
            seen = {}
            for n in L:  # newest post first: keep the latest statement for each (component, date)
                for a, b, c in parse_migrations(n)[0]: seen.setdefault((a.lower(), b), (a, b, c, n["date"]))
            cal_rows = sorted(seen.values(), key=lambda r: date_key(r[1]), reverse=True)
            ncal = (len(cal_rows) + 8) // 9
            cal = [new() for _ in range(ncal)]
        plan[key] = (div, chunks, idx, pairs, cal)
        if cal: plan["_cal_rows"] = cal_rows
        groups.append((SM[key][1], [div] + idx + [x for p in pairs for x in p] + cal))
    S_close = new(); groups.append(("Chiusura", [S_close]))
    num = {id(s): i + 1 for i, s in enumerate(prs.slides)}
    sn = lambda s: list(prs.slides).index(s) + 1

    # --- cover
    s = S_cover
    if os.path.exists(asset("cover.jpg")):
        picture(s, asset("cover.jpg"), 0, 0, W, H, alt="Illustrazione astratta con nastri di luce viola su fondo lavanda scuro")
    text(s, M + 150000, 1350000, 6600000, 400000, "GITHUB CHANGELOG · LABEL COPILOT", size=13, color=ACC, bold=True, ls=2, autofit=False)
    text(s, M + 150000, 1800000, 6600000, 1600000, paras=[dict(text="GitHub Copilot"), dict(text="novità dal changelog")], size=40, bold=True)
    text(s, M + 150000, 3450000, 6400000, 800000,
         paras=[dict(text=f"{TOT} news dal {dl(p0)} al {dl(p1)},"), dict(text="per sezione e dalla più recente, con dettaglio")], size=18, color=INK2)
    x, y = M + 150000, 4450000
    for key, name, col, tint, _ in SEC:
        if not cnt[key]: continue
        lab = f"{cnt[key]} {name}"; w = pw(lab, 14)
        if x + w > M + 6900000: x = M + 150000; y += 520000
        pill(s, x, y, w, lab, col, tint, size=14); x += w + 130000
    text(s, M + 150000, 5650000, 6600000, 400000, f"{cfg.get('author', '')} · {cfg.get('deck_date', dl(p1))}".strip(" ·"), size=14, color=MUTED, autofit=False)
    notes(s, f"Aggiornamenti GitHub Copilot dal GitHub Changelog (label copilot) pubblicati dal {dd(p0)} al {dd(p1)}, "
             f"esclusi i riepiloghi 'GitHub Copilot weekly releases'.\nFonte: https://github.blog/changelog/label/copilot/")

    # --- overview
    s = S_over
    eyebrow(s, f"PANORAMICA · {dl(p0).upper()} – {dl(p1).upper()}", ACC)
    text(s, M, 720000, CW, 700000, f"{TOT} novità nel periodo", size=28, bold=True, autofit=False)
    x = M
    act = [k for k in SEC if cnt[k[0]]]
    for key, name, col, *_ in act:
        w = round(CW * cnt[key] / TOT); box(s, x, 1550000, w, 380000, col, shape="rect"); x += w
    step = CW // len(act)
    for j, (key, name, col, *_) in enumerate(act):
        xx = M + j * step
        box(s, xx, 2110000, 170000, 170000, col, shape="oval")
        text(s, xx + 220000, 1990000, step - 240000, 420000, f"{cnt[key]} {name}", size=14, bold=True)
    # weekly buckets (Monday based)
    d0, d1 = D(p0), D(p1); start = d0 - dt.timedelta(days=d0.weekday()); weeks = []
    while start <= d1:
        a, b = max(start, d0), min(start + dt.timedelta(days=6), d1)
        lab = f"{a.day}–{b.day}\n{MS[b.month]}" if a.month == b.month else f"{a.day}–{b.day}\n{MS[a.month]}/{MS[b.month]}"
        weeks.append((lab, a.isoformat(), b.isoformat())); start += dt.timedelta(days=7)
    wc = [sum(1 for n in allnews if a <= n["date"] <= b) for _, a, b in weeks]
    cx0, cw, top = M, 6500000, 2700000
    box(s, cx0, top, cw, 3250000, CARD, line=BORDER, shadow=True)
    label(s, cx0 + 220000, top + 90000, cw - 440000, "NEWS PER SETTIMANA")
    base, maxh, mx = top + 2700000, 1600000, max(wc) or 1
    nb = len(weeks); bw = min(700000, (cw - 440000) // nb - 80000); gap = ((cw - 440000) - nb * bw) // max(1, nb - 1)
    box(s, cx0 + 220000, base, cw - 440000, 12700, "4A4270", shape="rect")
    for j, (lab, _, _) in enumerate(weeks):
        h_ = max(20000, round(maxh * wc[j] / mx)); bx = cx0 + 220000 + j * (bw + gap)
        box(s, bx, base - h_, bw, h_, ACC if wc[j] == mx else "5B4B8A", shape="rect")
        text(s, bx - 150000, base - h_ - 430000, bw + 300000, 420000, str(wc[j]), size=15, bold=True, align="center", autofit=False)
        text(s, bx - gap // 2 + 10000, base + 30000, bw + gap - 20000, 480000, lab, size=11, color=MUTED, align="center", autofit=False)
    hl = cfg.get("highlights") or []
    if not hl:
        top_days = Counter(n["date"] for n in allnews).most_common(2)
        hl = [dict(value=str(c), label=f"news pubblicate il {dl(d)}", detail="") for d, c in top_days]
        hl.append(dict(value=str(sum(1 for n in items["modelli"] if n["type"].lower() == "release")), label="nuovi modelli o release di modelli", detail=""))
    rx = cx0 + cw + 200000; rw = W - M - rx
    for j, h_ in enumerate(hl[:3]):
        if h_.get("date"): val = str(sum(1 for n in allnews if n["date"] == h_["date"]))
        elif h_.get("count_section"): val = str(cnt.get(h_["count_section"], 0))
        else: val = str(h_.get("value", ""))
        yy = top + j * (1030000 + 80000)
        box(s, rx, yy, rw, 1030000, CARD, line=BORDER, shadow=True)
        text(s, rx + 100000, yy, 1250000, 1030000, val, size=36, bold=True, color=ACC, align="center", anchor="middle", autofit=False)
        text(s, rx + 1400000, yy + 40000, rw - 1500000, 950000, paras=[dict(text=h_["label"], size=14, bold=True), dict(text=h_.get("detail", ""), size=12, color=INK2)])
    footer(s, "Fonte: GitHub Changelog, label copilot · esclusi i riepiloghi settimanali · conteggio per data di pubblicazione")
    notes(s, "News per settimana: " + ", ".join(f"{w[0]}: {c}" for w, c in zip(weeks, wc)) +
          ("\nEsclusi: " + "; ".join(f"{t} ({w})" for t, w in dropped) if dropped else ""))

    # --- agenda
    s = S_agenda
    eyebrow(s, "COME È ORGANIZZATO IL DECK", ACC)
    text(s, M, 720000, CW, 700000, f"{len(SEC)} sezioni, una news per coppia di slide", size=28, bold=True, autofit=False)
    for j, (key, name, col, tint, sub) in enumerate(SEC):
        yy = 1500000 + j * 770000
        div, chunks, idx, pairs, cal = plan[key]
        last = cal[-1] if cal else pairs[-1][1] if pairs else idx[-1]
        box(s, M, yy, CW, 720000, CARD, line=BORDER, shadow=True)
        pill(s, M + 170000, yy + 140000, 900000, str(cnt[key]), col, tint, size=18, h=440000)
        text(s, M + 1300000, yy + 20000, 7000000, 680000, paras=[dict(text=name, size=17, bold=True), dict(text=sub, size=12, color=INK2)], target=idx[0])
        text(s, M + CW - 2700000, yy + 140000, 2500000, 440000, f"slide {sn(div)}–{sn(last)}", size=14, color=col, bold=True, align="right", autofit=False, target=div)
    notes(s, "Ogni news ha una copertina (immagine dell'articolo o illustrazione esplicativa, dato chiave) e una slide di dettaglio con layout diverso per sezione.\nOrdine dalla più recente in ogni sezione. Il nome apre l'indice nascosto; l'intervallo apre la sezione.")

    imgdir = os.path.join(work)
    # --- sections
    for key, name, col, tint, sub in SEC:
        div, chunks, idx, pairs, cal = plan[key]; L = items[key]
        s = div; nsec = [k[0] for k in SEC].index(key) + 1
        text(s, M, 1150000, 6000000, 400000, f"SEZIONE {nsec} DI {len(SEC)}", size=13, color=MUTED, bold=True, ls=2, autofit=False)
        text(s, M, 1600000, 5000000, 2150000, str(len(L)), size=130, bold=True, color=col, autofit=False)
        text(s, M, 3800000, 6500000, 800000, name, size=36, bold=True, autofit=False)
        text(s, M, 4620000, 6600000, 700000, sub, size=18, color=INK2)
        lab = f"{ds(L[-1]['date'])} → {ds(L[0]['date'])} {D(L[0]['date']).year}" if L else "Nessuna novità nel periodo"
        pill(s, M, 5400000, pw(lab, 14), lab, col, tint, size=14)
        box(s, 7300000, 1250000, 4200000, 4200000, tint, shape="oval")
        ic = asset(f"ic-{key}.png")
        if os.path.exists(ic): picture(s, ic, 7900000, 1850000, 3000000, 3000000, mode="contain", alt=f"Icona della sezione {name}")
        notes(s, f"Sezione {name}: {len(L)} news, dal {dl(L[-1]['date'])} al {dl(L[0]['date'])}, in ordine dalla più recente."
              if L else f"Sezione {name}: nessuna novità nel periodo.")
        # index
        for ci, (ch, s) in enumerate(zip(chunks, idx)):
            eyebrow(s, f"{name.upper()} · INDICE {ci + 1}/{len(chunks)}", col)
            text(s, M, 700000, CW - 2000000, 650000, f"{name}: le news in breve" + (f" ({ci + 1}/{len(chunks)})" if len(chunks) > 1 else ""), size=26, bold=True, autofit=False)
            if ci + 1 < len(idx):
                text(s, M + CW - 1900000, 780000, 1900000, 450000, "Indice successivo →", size=12, color=col, align="right", target=idx[ci + 1])
            if not ch:
                text(s, M, 1600000, CW, 600000, "Nessuna novità nel periodo.", size=18, color=INK2)
            for j, n in enumerate(ch):
                yy = 1450000 + j * 700000; cov = pairs[L.index(n)][0]
                box(s, M, yy, CW, 650000, CARD, line=BORDER)
                pill(s, M + 110000, yy + 115000, 1000000, ds(n["date"]), col, tint, size=13)
                text(s, M + 1250000, yy, 7500000, 650000, n["title"], size=14, bold=True, anchor="middle", target=cov)
                pc, pf = pillc(n["status"]); st = n["status"].replace("PUBLIC ", "").replace("PRIVATE ", "PRIV. ")
                pill(s, M + 8850000, yy + 115000, 1500000, st, pc, pf, size=12)
                text(s, M + 10400000, yy + 115000, CW - 10450000, 420000, f"→ {sn(cov)}", size=13, color=MUTED, bold=True, align="right", autofit=False, target=cov)
            hide(s)
            notes(s, "Indice: data, titolo originale, stato e slide di copertina (righe cliccabili).\n" + "\n".join(f"{n['date']} · {n['title']} · {n['url']}" for n in ch))
        # news
        for i, (n, (sc, sd)) in enumerate(zip(L, pairs)):
            src = find_image(n, args.images); kind = n.get("image_kind") or ("article" if src else None)
            if src and is_changelog_banner(src)[0]:
                banner_rejected.append(n["id"]); src = None; kind = None
            img_stats[kind or "icon"] += 1
            s = sc
            pc, pf = pillc(n["status"])
            if src:
                img, (iw, ih) = prep_image(src, imgdir)
            if src and ih > iw * 1.05:      # portrait illustration -> full-height panel
                picture(s, img, 7620000, 0, 4572000, H, alt=f"Illustrazione: {n['summary']}"); LW = 6750000
            elif src:                         # landscape article image -> framed card
                LW = 5500000; cx, cwid = M + LW + 300000, W - M - (M + LW + 300000)
                sc_ = min((cwid - 200000) / iw, 4300000 / ih); ph = int(ih * sc_)
                cy = max(900000, (H - ph - 200000) // 2)
                box(s, cx, cy, cwid, ph + 200000, CARD, line=BORDER, shadow=True)
                picture(s, img, cx + 100000, cy + 100000, cwid - 200000, ph, mode="contain", alt=f"Immagine dall'articolo: {n['title']}")
            else:                             # no image: section icon in a tinted circle (never a blank cover)
                LW = 6750000; ic = asset(f"ic-{key}.png")
                box(s, 7750000, 1500000, 3900000, 3900000, tint, shape="oval")
                if os.path.exists(ic): picture(s, ic, 8300000, 2050000, 2800000, 2800000, mode="contain", alt=f"Icona della sezione {name}")
            eyebrow(s, f"{name.upper()} · NEWS {i + 1}/{len(L)}", col, w=LW - 2200000, y=560000)
            w = pw(n["status"]); pill(s, M + LW - w, 540000, w, n["status"], pc, pf)
            text(s, M, 1000000, LW, 440000, f"{dl(n['date'])} · {n['type']}", size=14, color=MUTED, autofit=False)
            text(s, M, 1500000, LW, 1800000, n["title"], size=30, bold=True, minsize=20)
            text(s, M, 3350000, LW, 1100000, n["summary"], size=16, color=INK2)
            box(s, M, 4560000, LW, 1250000, CARD, line=BORDER, shadow=True)
            text(s, M + 80000, 4560000, 2300000, 1250000, n["hero_value"], size=one_line(n["hero_value"], 40, 2300000, minsize=20), bold=True, color=col, align="center", anchor="middle", minsize=20)
            text(s, M + 2450000, 4560000, LW - 2600000, 1250000, n["hero_label"], size=15, anchor="middle")
            footer(s, f"Fonte: GitHub Changelog, post del {dd(n['date'])}", w=LW, link=n["url"])
            date_tag(s, n["date"])
            notes(s, nnotes(n, kind if src else None))
            s = sd
            header(s, n, key); DET[key](s, n, col, tint)
            footer(s, f"Fonte: GitHub Changelog, post del {dd(n['date'])}", w=CW // 2, link=n["url"])
            date_tag(s, n["date"])
            notes(s, nnotes(n, None))
        # retired calendar
        if cal:
            today = cfg.get("today") or p1
            rows = plan["_cal_rows"]
            for ci, s in enumerate(cal):
                per = -(-len(rows) // len(cal)); part = rows[ci * per:(ci + 1) * per]
                eyebrow(s, f"RETIRED · CALENDARIO {ci + 1}/{len(cal)}", col)
                text(s, M, 700000, CW, 650000, "Calendario delle dismissioni", size=26, bold=True, autofit=False)
                cols_ = [(0, 3500000), (3500000, 1900000), (5400000, 1800000), (7200000, CW - 7200000)]
                ty, rh = 1500000, 450000
                for k, h_ in enumerate(["MODELLO / COMPONENTE", "DATA", "STATO", "ALTERNATIVA SUGGERITA"]):
                    label(s, M + cols_[k][0] + 200000, ty, cols_[k][1] - 250000, h_)
                for ri, (a, b, c, d) in enumerate(part):
                    yy = ty + (ri + 1) * rh
                    past = date_key(b) < (cfg.get("today") or p1)
                    box(s, M, yy, CW, rh - 30000, "231C45" if ri % 2 == 0 else CARD, radius=60000)
                    text(s, M + 200000, yy, cols_[0][1] - 250000, rh - 30000, a, size=14, bold=True, anchor="middle")
                    text(s, M + cols_[1][0] + 200000, yy, cols_[1][1] - 250000, rh - 30000, b, size=14, bold=True, color=MUTED if past else col, anchor="middle")
                    pill(s, M + cols_[2][0] + 150000, yy + 45000, 1450000, "DISMESSO" if past else "IN ARRIVO", MUTED if past else col, "2A2346" if past else tint, size=12, h=340000)
                    text(s, M + cols_[3][0] + 200000, yy, cols_[3][1] - 250000, rh - 30000, c, size=14, color=INK2, anchor="middle")
                footer(s, "Fonte: annunci di dismissione del GitHub Changelog (sezione Retired)")
                notes(s, "Date e alternative dagli annunci di dismissione.\n" + "\n".join(f"{a} → {b} → {c} (post del {dd(d)})" for a, b, c, d in part))

    # --- closer
    s = S_close
    if os.path.exists(asset("closer.jpg")):
        picture(s, asset("closer.jpg"), 0, 0, 4900000, H, alt="Illustrazione astratta: gradini di luce viola")
    X0 = 5400000; XW = W - M - X0
    text(s, X0, 420000, XW, 400000, "PROSSIMI PASSI", size=12, color=ACC, bold=True, ls=2, autofit=False)
    text(s, X0, 800000, XW, 700000, "Cosa fare adesso", size=28, bold=True, autofit=False)
    acts = cfg.get("actions") or [
        dict(title="Aggiorna le policy dei modelli", body="Abilita le alternative prima delle date di dismissione nel calendario Retired."),
        dict(title="Rivedi la governance", body="Controlla le novità della sezione Governance: policy, metriche e controlli enterprise."),
        dict(title="Prova le novità principali", body="Parti dalle news in GA della sezione Release e dai nuovi modelli."),
        dict(title="Aggiorna gli IDE", body="Porta VS Code, Visual Studio e JetBrains alle versioni citate nella sezione IDE.")]
    for j, a in enumerate(acts[:4]):
        yy = 1650000 + j * 1120000
        box(s, X0, yy, XW, 1040000, CARD, line=BORDER, shadow=True)
        b = box(s, X0 + 180000, yy + 240000, 560000, 560000, "2A1A52", line=ACC, lw=12700, shape="oval")
        tf = b.text_frame; tf.vertical_anchor = MSO_ANCHOR.MIDDLE; tf.margin_left = tf.margin_right = Emu(0)
        pp = tf.paragraphs[0]; pp.alignment = PP_ALIGN.CENTER; r = pp.add_run(); r.text = str(j + 1); _runfmt(r, 18, ACC, True, FONT)
        text(s, X0 + 900000, yy + 40000, XW - 1050000, 960000, paras=[dict(text=a["title"], size=16, bold=True), dict(text=a["body"], size=13, color=INK2)])
    footer(s, "Changelog: github.blog/changelog/label/copilot", x=X0, w=XW, link="https://github.blog/changelog/label/copilot/")
    notes(s, "Azioni suggerite a partire dagli annunci del changelog.\nChangelog Copilot: https://github.blog/changelog/label/copilot/")

    add_sections(prs, groups)
    set_link_colors(prs)
    prs.save(args.out)
    print(json.dumps(dict(out=args.out, slides=len(prs.slides), news=TOT, per_section=cnt, dropped=dropped,
                          images=dict(img_stats), banner_rejected=banner_rejected,
                          size_mb=round(os.path.getsize(args.out) / 1e6, 1)), ensure_ascii=False))


if __name__ == "__main__":
    main()
