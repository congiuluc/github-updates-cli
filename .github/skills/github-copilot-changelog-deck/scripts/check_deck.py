#!/usr/bin/env python3
"""UI check of the built deck: run it after EVERY build_deck.py run and fix all errors before delivering.

  python check_deck.py --deck "<deck>.pptx" [--news news.json] [--images images/] [--raw raw/] \
      [--render] [--soffice <path>] [--out qa/]

STATIC checks (python-pptx, always):
  sections      PowerPoint sections in the fixed order, no extra/unknown section
  ground        same dark background on every slide (no light/dark flip)
  bounds        every shape inside the 16:9 slide
  overflow      measured text height/width fits its box (same metrics as the renderer)
  font          every run >= 11 pt, Segoe UI / Consolas
  contrast      WCAG contrast text vs the fill (or image area) under it: >= 4.5, >= 3 for large text
  overlap       two text boxes covering each other
  picture       no distortion, no generic changelog banner, enough resolution
  language      Italian body text and notes (post titles, doc-link titles and links may stay English)
  weekly        no "GitHub Copilot weekly release(s)" post
  references    NO source references or image captions on the slides ("Fonte:", "Documentazione ufficiale",
                "Immagine dall'articolo", "Illustrazione generata", visible URLs, hyperlinked footers)
  date          every news slide (notes "Articolo: …") shows its date as yyyy-MM-dd in the bottom-right corner
  hidden        section index slides (notes "Indice: …") are hidden; no other slide is hidden
  links         every news URL appears in the speaker notes of its slides (needs --news)
  images        with --news/--images/--raw: the ARTICLE image is used whenever the post has one that is
                not the generic banner; no banner used; counts article / generated / icon
RENDER checks (--render: LibreOffice -> PDF, then pypdfium2 or PyMuPDF):
  render        page count = slide count, no blank slide, no light slide
  text_outside  text actually drawn outside every text box (real overflow / clipped wraps)
  word_break    a single word (hero value, badge, date) drawn on more than one line
  The PDF stays as qa/deck_render.pdf (--reuse-pdf skips the conversion when it is newer than the deck).
  + contact sheets qa/sheets/sheet_NN.jpg (12 slides each, numbered bottom-left, "(nascosta)" for hidden slides) and qa/flagged/slide_NNN.png for
    every slide with an error: LOOK at them.

Output: qa/ui_report.json + qa/ui_report.md (Italian); one JSON summary line on stdout.
Exit code 1 when there is at least one error. Needs python-pptx + Pillow; --render also needs
LibreOffice (soffice) and `pip install pypdfium2` (or PyMuPDF).
"""
import argparse, glob, io, json, os, re, shutil, subprocess, sys, tempfile
from collections import Counter, defaultdict
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageStat
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Emu

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from banner import is_changelog_banner  # noqa: E402
try:
    from build_deck import wrap_lines, text_w  # same metrics as the renderer
except Exception:  # pragma: no cover
    def text_w(t, size, bold=False): return len(t) * size * (7400 if not bold else 7900)

    def wrap_lines(t, size, width, bold=False):
        n = 0
        for para in str(t).split("\n"):
            n += max(1, int(text_w(para, size, bold) // max(1, width)) + 1)
        return n

SECTIONS = ["Introduzione", "Modelli", "Release", "Improvement", "Governance", "IDE", "Retired", "Chiusura"]
FONTS = {"Segoe UI", "Segoe UI Semibold", "Segoe UI Light", "Consolas", "Segoe UI Emoji", "Segoe UI Symbol"}
WEEKLY = re.compile(r"weekly release", re.I)
REFS = re.compile(r"(^|\s)(fonte\s*:|documentazione ufficiale|immagine dall.articolo|illustrazione generata|"
                  r"https?://|github\.blog/|docs\.github\.com|learn\.microsoft\.com)", re.I)
EN = set("the and with for now your you are is to of this that can will from on into when which their they "
         "available enables allows using new more these be has have was were it its by an or at".split())
IT = set("il lo la le gli di del della dei degli delle e è per con che nel nella nei sono può ora un una "
         "alla alle al ai si non più anche come dal dalla dai tra già questo questa sul sulla".split())
P14 = "{http://schemas.microsoft.com/office/powerpoint/2010/main}"


class Report:
    def __init__(self): self.errors, self.warnings, self.info = [], [], {}

    def err(self, slide, check, msg): self.errors.append(dict(slide=slide, check=check, msg=msg))

    def warn(self, slide, check, msg): self.warnings.append(dict(slide=slide, check=check, msg=msg))


# ------------------------------------------------------------------ colour helpers
def lum(hexc):
    def ch(v):
        v /= 255; return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hexc[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def solid(fill):
    try:
        if fill.type == 1: return str(fill.fore_color.rgb)
    except Exception:
        pass
    return None


def theme_hlink(prs):
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    try:
        xml = prs.slide_master.part.part_related_by(RT.THEME).blob.decode("utf-8")
        m = re.search(r"<a:hlink>\s*<a:srgbClr val=\"([0-9A-Fa-f]{6})\"", xml)
        return m.group(1).upper() if m else "0563C1"
    except Exception:
        return "0563C1"


def rect(sh): return (sh.left or 0, sh.top or 0, (sh.left or 0) + (sh.width or 0), (sh.top or 0) + (sh.height or 0))


def inside(pt, r, tol=0): return r[0] - tol <= pt[0] <= r[2] + tol and r[1] - tol <= pt[1] <= r[3] + tol


def inter(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0, w) * max(0, h)


def pic_area_color(pic, r):
    """mean colour of the picture area under rect r (EMU)."""
    try:
        im = Image.open(io.BytesIO(pic.image.blob)).convert("RGB")
    except Exception:
        return None
    pw, ph = im.size
    cl, cr, ct, cb = pic.crop_left, pic.crop_right, pic.crop_top, pic.crop_bottom
    x0, y0, x1, y1 = rect(pic)
    def mx(x): return int(pw * (cl + (1 - cl - cr) * (x - x0) / max(1, x1 - x0)))
    def my(y): return int(ph * (ct + (1 - ct - cb) * (y - y0) / max(1, y1 - y0)))
    a = (max(0, mx(max(r[0], x0))), max(0, my(max(r[1], y0))), min(pw, mx(min(r[2], x1))), min(ph, my(min(r[3], y1))))
    if a[2] - a[0] < 2 or a[3] - a[1] < 2: return None
    m = ImageStat.Stat(im.crop(a)).mean
    return "%02X%02X%02X" % tuple(int(v) for v in m[:3])


# ------------------------------------------------------------------ static checks
def text_shapes(slide):
    out = []
    for i, sh in enumerate(slide.shapes):
        if sh.has_text_frame and sh.text_frame.text.strip():
            out.append((i, sh))
    return out


def para_info(p):
    runs = [r for r in p.runs if r.text]
    size = next((r.font.size.pt for r in runs if r.font.size), None)
    bold = any(r.font.bold for r in runs)
    return "".join(r.text for r in runs), size, bold


def check_static(prs, rep, news):
    W, H = prs.slide_width, prs.slide_height
    hl = theme_hlink(prs)
    titles = {n["title"].strip() for n in news} if news else set()
    doc_titles = {d.get("title", "").strip() for n in news or [] for d in n.get("doc_links") or []}
    slides = list(prs.slides)
    # sections
    names = [s.get("name") for s in prs.part._element.iter(P14 + "section")]
    if not names:
        rep.warn(0, "sections", "nessuna sezione PowerPoint")
    else:
        bad = [n for n in names if n not in SECTIONS]
        order = [n for n in names if n in SECTIONS]
        if bad: rep.err(0, "sections", f"sezioni non previste: {bad}")
        if order != SECTIONS: rep.err(0, "sections", f"sezioni mancanti, duplicate o in ordine errato: {order}")
        rep.info["sections"] = names
    # ground
    grounds = []
    for k, s in enumerate(slides, 1):
        try:
            g = solid(s.background.fill) if s.follow_master_background is False else None
        except Exception:
            g = None
        grounds.append(g)
    main = Counter(g for g in grounds if g).most_common(1)
    main = main[0][0] if main else None
    rep.info["ground"] = main
    if main and lum(main) > 0.2: rep.err(0, "ground", f"fondo principale chiaro #{main}: il tema è scuro")
    for k, g in enumerate(grounds, 1):
        if g != main: rep.err(k, "ground", f"fondo #{g or 'del master'} diverso da #{main}")
    seen_urls = defaultdict(set)
    for k, s in enumerate(slides, 1):
        shapes = list(s.shapes)
        if not shapes: rep.err(k, "render", "slide vuota")
        ground = grounds[k - 1] or main or "FFFFFF"
        for sh in shapes:
            x0, y0, x1, y1 = rect(sh)
            if x0 < -12700 or y0 < -12700 or x1 > W + 12700 or y1 > H + 12700:
                rep.err(k, "bounds", f"'{sh.name}' esce dalla slide ({x0},{y0})–({x1},{y1})")
            if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
                check_picture(k, sh, rep)
            if sh.has_text_frame and REFS.search(sh.text_frame.text):
                rep.err(k, "references", f"riferimento o didascalia sulla slide (va solo nelle note): '{sh.text_frame.text[:60]}'")
            if sh.has_text_frame and any(r.hyperlink.address for p in sh.text_frame.paragraphs for r in p.runs if r.hyperlink):
                rep.err(k, "references", f"link esterno sulla slide (va solo nelle note): '{sh.text_frame.text[:60]}'")
        if s.has_notes_slide:
            for u in re.findall(r"https?://[^\s)]+", s.notes_slide.notes_text_frame.text): seen_urls[u.rstrip("/.,")].add(k)
        nt0 = s.notes_slide.notes_text_frame.text if s.has_notes_slide else ""
        hidden = s._element.get("show") in ("0", "false")
        if nt0.startswith("Indice:") and not hidden: rep.err(k, "hidden", "slide indice di sezione non nascosta")
        if hidden and not nt0.startswith("Indice:"): rep.err(k, "hidden", "slide nascosta che non è un indice di sezione")
        if nt0.startswith("Articolo:"):
            tags = [sh for sh in shapes if sh.has_text_frame and re.fullmatch(r"\d{4}-\d{2}-\d{2}", sh.text_frame.text.strip())]
            br = [sh for sh in tags if rect(sh)[2] >= W * 0.85 and rect(sh)[3] >= H * 0.88]
            if not br: rep.err(k, "date", "data della news (aaaa-MM-gg) assente in basso a destra")
            else:
                d = br[0].text_frame.text.strip(); m = re.search(r"/(\d{4}-\d{2}-\d{2})-", nt0)
                if m and m.group(1) != d: rep.err(k, "date", f"data {d} diversa da quella del post {m.group(1)}")
        tsh = text_shapes(s)
        body_en = 0
        for i, sh in tsh:
            tf = sh.text_frame
            r = rect(sh)
            ml = tf.margin_left if tf.margin_left is not None else 91440
            mr = tf.margin_right if tf.margin_right is not None else 91440
            mt = tf.margin_top if tf.margin_top is not None else 45720
            mb = tf.margin_bottom if tf.margin_bottom is not None else 45720
            iw, ih = (r[2] - r[0]) - ml - mr, (r[3] - r[1]) - mt - mb
            need, sizes = 0, []
            for p in tf.paragraphs:
                t, size, bold = para_info(p)
                if not t: continue
                if size is None:
                    rep.warn(k, "font", f"dimensione non esplicita: '{t[:40]}'"); size = 18
                sizes.append(size)
                if tf.word_wrap is False:
                    if text_w(t, size, bold) > iw * 1.04: rep.err(k, "overflow", f"testo più largo del box: '{t[:60]}'")
                    need += size * 12700 * 1.2
                else:
                    need += wrap_lines(t, size, iw, bold) * size * 12700 * 1.2
                for run in p.runs:
                    if run.font.size and run.font.size.pt < 11 - 1e-6:
                        rep.err(k, "font", f"{run.font.size.pt:g} pt < 11 pt: '{run.text[:40]}'")
                    if run.font.name and run.font.name not in FONTS:
                        rep.warn(k, "font", f"font {run.font.name}: '{run.text[:30]}'")
            if need > ih * 1.10 + 25400:
                rep.err(k, "overflow", f"testo alto {need / 914400:.2f}\" in un box di {ih / 914400:.2f}\": '{tf.text[:70]}'")
            # contrast
            bg = solid(sh.fill) if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE else None
            if bg is None:
                c = ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)
                for j in range(i - 1, -1, -1):
                    u = shapes[j]
                    if not inside(c, rect(u)): continue
                    if u.shape_type == MSO_SHAPE_TYPE.PICTURE:
                        bg = pic_area_color(u, r); break
                    f = solid(u.fill) if u.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE else None
                    if f: bg = f; break
                bg = bg or ground
            for p in tf.paragraphs:
                for run in p.runs:
                    if not run.text.strip(): continue
                    link = bool(run.hyperlink and run.hyperlink.address)
                    try:
                        col = hl if link else (str(run.font.color.rgb) if run.font.color and run.font.color.type else "000000")
                    except Exception:
                        col = "000000"
                    size = run.font.size.pt if run.font.size else 18
                    need_cr = 3.0 if size >= 18 or (run.font.bold and size >= 14) else 4.5
                    cr = contrast(col, bg)
                    if cr < need_cr:
                        rep.err(k, "contrast", f"contrasto {cr:.1f}:1 < {need_cr}:1 (#{col} su #{bg}): '{run.text[:40]}'")
            # language
            t = tf.text.strip()
            if t in titles or t in doc_titles or any(r.hyperlink.address for p in tf.paragraphs for r in p.runs if r.hyperlink):
                continue
            words = re.findall(r"[a-zàèéìòù']+", t.lower())
            en, it = sum(w in EN for w in words), sum(w in IT for w in words)
            if en >= 4 and en > 2 * it:
                rep.err(k, "language", f"testo in inglese: '{t[:70]}'")
            elif en >= 3 and en > it:
                rep.warn(k, "language", f"testo forse in inglese: '{t[:70]}'")
            if WEEKLY.search(t): rep.err(k, "weekly", f"riepilogo settimanale nel deck: '{t[:60]}'")
        # overlap between text boxes
        for a in range(len(tsh)):
            for b in range(a + 1, len(tsh)):
                ra, rb = rect(tsh[a][1]), rect(tsh[b][1])
                area = inter(ra, rb)
                small = min((ra[2] - ra[0]) * (ra[3] - ra[1]), (rb[2] - rb[0]) * (rb[3] - rb[1])) or 1
                if area / small > 0.25:
                    rep.warn(k, "overlap", f"box sovrapposti: '{tsh[a][1].text_frame.text[:30]}' / '{tsh[b][1].text_frame.text[:30]}'")
        # notes
        if s.has_notes_slide:
            nt = s.notes_slide.notes_text_frame.text
            if nt.strip().upper().startswith("ENGLISH"): rep.err(k, "language", "note che iniziano con 'ENGLISH'")
            for t_ in sorted(titles | doc_titles, key=len, reverse=True):
                if t_: nt = nt.replace(t_, " ")
            words = re.findall(r"[a-zàèéìòù']+", re.sub(r"https?://\S+", "", nt).lower())
            en, it = sum(w in EN for w in words), sum(w in IT for w in words)
            if en >= 8 and en > 2 * it: rep.err(k, "language", "note del relatore in inglese")
        else:
            rep.warn(k, "language", "slide senza note del relatore")
    # links
    if news:
        for n in news:
            u = (n.get("url") or "").rstrip("/")
            if u and not seen_urls.get(u):
                rep.warn(0, "links", f"id {n['id']}: link al post non presente nelle note ({u})")
    rep.info["slides"] = len(slides)


def check_picture(k, sh, rep):
    try:
        blob = sh.image.blob; im = Image.open(io.BytesIO(blob)); iw, ih = im.size
    except Exception:
        rep.warn(k, "picture", f"immagine non leggibile '{sh.name}'"); return
    cw = iw * (1 - sh.crop_left - sh.crop_right); ch = ih * (1 - sh.crop_top - sh.crop_bottom)
    if sh.width and sh.height and ch:
        d = abs((cw / ch) / (sh.width / sh.height) - 1)
        if d > 0.03: rep.err(k, "picture", f"immagine deformata del {d:.0%} ('{sh.name}')")
    if sh.width and sh.width > 2 * 914400 and cw / (sh.width / 914400) < 72:
        rep.warn(k, "picture", f"immagine a bassa risoluzione ({cw / (sh.width / 914400):.0f} px/inch)")
    ban, score, review = is_changelog_banner(im)
    if ban: rep.err(k, "picture", f"banner generico del changelog sulla slide (score {score})")
    elif review: rep.warn(k, "picture", f"immagine simile al banner del changelog (score {score}): guardala")


def check_images(news, images, raw, rep):
    """policy: article image whenever the post has a non-banner one; never a banner."""
    if not news or not images: return
    st = Counter()
    for n in news:
        if WEEKLY.search(n.get("title", "")) or n.get("exclude"): continue
        i = str(n["id"])
        cands = [n.get("image")] if n.get("image") else []
        cands += [f"{i}.{e}" for e in ("jpg", "png", "jpeg", "webp")]
        src = next((os.path.join(images, c) for c in cands if c and os.path.exists(os.path.join(images, c))), None)
        kind = n.get("image_kind") if src else "icon"
        if src and is_changelog_banner(src)[0]:
            rep.err(0, "images", f"id {i}: l'immagine scelta è il banner generico del changelog"); kind = "banner"
        art = []
        if raw:
            for f in sorted(glob.glob(os.path.join(raw, i, "*"))):
                try:
                    im = Image.open(f); im.load()
                except Exception:
                    continue
                if im.size[0] >= 400 and not is_changelog_banner(im)[0]: art.append(f)
        if art and kind != "article":
            rep.err(0, "images", f"id {i}: il post ha un'immagine esplicativa ({os.path.basename(art[0])}) ma la copertina usa '{kind}'")
        st[kind or "article"] += 1
    rep.info["images"] = dict(st)


# ------------------------------------------------------------------ render checks
def find_soffice(given):
    cands = [given, os.environ.get("SOFFICE"), shutil.which("soffice"), shutil.which("libreoffice")]
    cands += glob.glob("/opt/libreoffice*/program/soffice") + glob.glob("/usr/lib/libreoffice/program/soffice")
    cands += [r"C:\Program Files\LibreOffice\program\soffice.exe", r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
              "/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    for path in cands:
        if path and os.path.exists(path):
            console = os.path.splitext(path)[0] + ".com" if os.name == "nt" and os.path.basename(path).lower() == "soffice.exe" else path
            return console if os.path.exists(console) else path
    return None


class PDF:
    """minimal wrapper: pypdfium2 or PyMuPDF."""
    def __init__(self, path):
        try:
            import pypdfium2 as pdfium
            self.kind, self.doc = "pdfium", pdfium.PdfDocument(path)
        except ImportError:
            import fitz  # PyMuPDF
            self.kind, self.doc = "fitz", fitz.open(path)

    def __len__(self): return len(self.doc)

    def size(self, i):
        if self.kind == "pdfium": return self.doc[i].get_size()
        r = self.doc[i].rect; return r.width, r.height

    def chars(self, i):
        """[(char, x_center_pt, y_center_pt_from_top)]"""
        out = []
        if self.kind == "pdfium":
            page = self.doc[i]; tp = page.get_textpage(); h = page.get_size()[1]
            for c in range(tp.count_chars()):
                ch = tp.get_text_range(c, 1)
                if not ch.strip(): continue
                l, b, r, t = tp.get_charbox(c)
                out.append((ch, (l + r) / 2, h - (b + t) / 2))
        else:
            for blk in self.doc[i].get_text("rawdict")["blocks"]:
                for ln in blk.get("lines", []):
                    for sp in ln["spans"]:
                        for c in sp["chars"]:
                            if c["c"].strip():
                                x0, y0, x1, y1 = c["bbox"]; out.append((c["c"], (x0 + x1) / 2, (y0 + y1) / 2))
        return out

    def render(self, i, width):
        w, _ = self.size(i)
        if self.kind == "pdfium": return self.doc[i].render(scale=width / w).to_pil().convert("RGB")
        import fitz
        pix = self.doc[i].get_pixmap(matrix=fitz.Matrix(width / w, width / w))
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def check_render(prs, deck, out, soffice, rep, reuse_pdf=False):
    so = find_soffice(soffice)
    if not so:
        rep.warn(0, "render", "LibreOffice non trovato: controlli di rendering e fogli di anteprima saltati"); return
    try:
        PDF.__init__  # noqa
        import importlib
        if not (importlib.util.find_spec("pypdfium2") or importlib.util.find_spec("fitz")): raise ImportError
    except ImportError:
        rep.warn(0, "render", "manca pypdfium2 (pip install pypdfium2): rendering saltato"); return
    tmp = tempfile.mkdtemp(prefix="deckqa_")
    pdfp = os.path.join(out, "deck_render.pdf")
    if not (reuse_pdf and os.path.exists(pdfp) and os.path.getmtime(pdfp) > os.path.getmtime(deck)):
        src = os.path.join(tmp, "deck.pptx"); shutil.copy(deck, src)
        flt = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
        profile = Path(tmp, "lo-profile").as_uri()
        subprocess.run([so, f"-env:UserInstallation={profile}", "--headless", "--convert-to", flt, "--outdir", tmp, src],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
        if os.path.exists(os.path.join(tmp, "deck.pdf")): shutil.move(os.path.join(tmp, "deck.pdf"), pdfp)
    if not os.path.exists(pdfp):
        rep.err(0, "render", "conversione in PDF non riuscita"); return
    pdf = PDF(pdfp); slides = list(prs.slides); allsl = list(prs.slides)
    if len(pdf) != len(slides):
        vis = [x for x in slides if x._element.get("show") not in ("0", "false")]
        if len(pdf) == len(vis):
            rep.warn(0, "render", "LibreOffice non esporta le slide nascoste: controllate solo le slide visibili"); slides = vis
        else:
            rep.err(0, "render", f"{len(pdf)} pagine renderizzate per {len(slides)} slide")
    W = prs.slide_width; tol = 73152  # 0.08"
    nums = [allsl.index(x) + 1 for x in slides]          # real slide number of each rendered page
    hid = {i + 1 for i, x in enumerate(allsl) if x._element.get("show") in ("0", "false")}
    thumbs = []
    for k in range(min(len(pdf), len(slides))):
        pw_, ph_ = pdf.size(k); sx, sy = W / pw_, prs.slide_height / ph_
        boxes = [rect(sh) for sh in slides[k].shapes if sh.has_text_frame and sh.text_frame.text.strip()]
        lost = []; chars = pdf.chars(k)
        for ch, x, y in chars:
            p = (x * sx, y * sy)
            if not any(inside(p, b, tol) for b in boxes): lost.append(ch)
        # a single word (hero value, badge) broken over two lines
        for sh in slides[k].shapes:
            if not sh.has_text_frame: continue
            t = sh.text_frame.text.strip()
            if not t or re.search(r"\s", t) or len(t) < 3: continue
            runs = [r for p_ in sh.text_frame.paragraphs for r in p_.runs if r.font.size]
            fs = runs[0].font.size.pt if runs else 18
            r_ = rect(sh); ys = [y for ch, x, y in chars if inside((x * sx, y * sy), r_)]
            if ys and (max(ys) - min(ys)) > 0.6 * fs:
                rep.err(nums[k], "word_break", f"parola spezzata su più righe: '{t[:40]}'")
        if len(lost) >= 3:
            rep.err(nums[k], "text_outside", f"{len(lost)} caratteri disegnati fuori dai box: '{''.join(lost)[:60]}'")
        im = pdf.render(k, 480)
        st = ImageStat.Stat(im.convert("L"))
        if st.stddev[0] < 2: rep.err(nums[k], "render", "slide renderizzata vuota/uniforme")
        if st.mean[0] > 150: rep.warn(nums[k], "render", f"slide chiara (luminosità media {st.mean[0]:.0f}) su un tema scuro")
        thumbs.append(im)
    # contact sheets + flagged slides
    sd = os.path.join(out, "sheets"); fd = os.path.join(out, "flagged")
    for d in (sd, fd):
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    flagged = sorted({e["slide"] for e in rep.errors if e["slide"]})
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
    except Exception:
        font = ImageFont.load_default()
    sheets = []
    for n0 in range(0, len(thumbs), 12):
        S = Image.new("RGB", (4 * 490 + 10, 3 * 290 + 10), (40, 40, 40)); dr = ImageDraw.Draw(S)
        for j, im in enumerate(thumbs[n0:n0 + 12]):
            x, y = 10 + (j % 4) * 490, 10 + (j // 4) * 290
            S.paste(im, (x, y)); num = nums[n0 + j]
            lab = f"{num} (nascosta)" if num in hid else str(num)
            bw_ = int(dr.textlength(lab, font=font)) + 14
            bx, by = x, y + im.height - 32   # bottom-left: keeps eyebrow and date tag readable
            dr.rectangle([bx, by, bx + bw_, by + 32], fill=(220, 40, 40) if num in flagged else (0, 0, 0))
            dr.text((bx + 7, by + 4), lab, fill="white", font=font)
        f = os.path.join(sd, f"sheet_{n0 // 12 + 1:02d}.jpg"); S.save(f, quality=80); sheets.append(f)
    for k in flagged:
        if k in nums: pdf.render(nums.index(k), 1280).save(os.path.join(fd, f"slide_{k:03d}.png"))
    rep.info["sheets"] = sheets; rep.info["flagged"] = [os.path.join(fd, f"slide_{k:03d}.png") for k in flagged]
    shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ main
def write_md(rep, path):
    L = ["# Verifica UI del deck", "", f"Slide: {rep.info.get('slides')} · errori: {len(rep.errors)} · avvisi: {len(rep.warnings)}", ""]
    if rep.info.get("images"): L += [f"Immagini: {rep.info['images']}", ""]
    for title, items in (("Errori (da correggere prima della consegna)", rep.errors), ("Avvisi (da guardare)", rep.warnings)):
        L += [f"## {title}", ""]
        L += [f"- slide {e['slide'] or '—'} · {e['check']} · {e['msg']}" for e in items] or ["- nessuno"]
        L += [""]
    if rep.info.get("sheets"): L += ["## Fogli di anteprima", ""] + [f"- {s}" for s in rep.info["sheets"]]
    open(path, "w", encoding="utf-8").write("\n".join(L) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deck", required=True); ap.add_argument("--news"); ap.add_argument("--images"); ap.add_argument("--raw")
    ap.add_argument("--render", action="store_true"); ap.add_argument("--soffice"); ap.add_argument("--out", default="qa")
    ap.add_argument("--reuse-pdf", action="store_true", help="reuse qa/deck_render.pdf if newer than the deck")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    prs = Presentation(a.deck); rep = Report()
    news = json.load(open(a.news, encoding="utf-8")) if a.news else None
    check_static(prs, rep, news)
    check_images(news, a.images, a.raw, rep)
    if a.render: check_render(prs, a.deck, a.out, a.soffice, rep, a.reuse_pdf)
    json.dump(dict(errors=rep.errors, warnings=rep.warnings, info=rep.info),
              open(os.path.join(a.out, "ui_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    write_md(rep, os.path.join(a.out, "ui_report.md"))
    print(json.dumps(dict(errors=len(rep.errors), warnings=len(rep.warnings),
                          by_check=dict(Counter(e["check"] for e in rep.errors)),
                          warn_by_check=dict(Counter(e["check"] for e in rep.warnings)),
                          slides_with_errors=sorted({e["slide"] for e in rep.errors if e["slide"]})[:40],
                          images=rep.info.get("images"), sheets=len(rep.info.get("sheets", [])),
                          report=os.path.join(a.out, "ui_report.md")), ensure_ascii=False))
    sys.exit(1 if rep.errors else 0)


if __name__ == "__main__":
    main()
