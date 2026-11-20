# Deck design spec — dark Copilot theme + Microsoft Fluent 2

Implemented by `scripts/build_deck.py` (python-pptx). Change the renderer, never single slides, and never
write other pptx code: a deck built by hand-made code is exactly what went wrong in the GitHub Copilot run
(generic green/black theme, light/dark flips, overflowing titles, 9–10 pt text, 30 MB).

## Canvas and palette
- 16:9, 12,192,000 × 6,858,000 EMU, margin 457,200. Font Segoe UI (DejaVu metrics used for fitting when Segoe UI is not installed); Consolas only in the IDE mock-up.
- ONE dark ground on every slide: background `0F0A26` · card `1B1538` · card2 `141026` · border `2E2752` · ink `EDEAF7` · ink2 `C4BEDD` · muted `B8B1D6` · accent `A371F7`. Theme hyperlink colours `C9B6FF` / followed `B8B1D6` (readable on dark; used only by the internal agenda/index jumps).
- Status pills: GA `3FB950` on `10301E` · PREVIEW `E3B341` on `3A2E0C` · DISMESSO `F0883E` on `3A2014` · other `C4BEDD` on `2A2346`.
- Sections (colour / tint): Modelli `F778BA`/`3A1530` · Release `3FB950`/`10301E` · Improvement `A371F7`/`2A1A52` · Governance `58A6FF`/`0E2545` · IDE `39C5CF`/`0B3036` · Retired `F0883E`/`3A2014`.
- **No references on slides**: no source footer ("Fonte: …"), no "Documentazione ufficiale" link, no visible URL or external hyperlink, no image caption ("Immagine dall'articolo…", "Illustrazione generata"), no image provenance. Only internal jumps (agenda, index) are clickable.
- **Speaker notes = article reference only** on every news cover and detail slide: `Articolo: <titolo originale> – GitHub Changelog, <data>` + newline + post URL (`URL non disponibile` when `url` is null). No summary, points, doc links or image provenance in those notes. Non-news slides keep short notes (excluded posts, index rows with post URLs, calendar dates with post dates, changelog URL on the closing slide).
- **News date tag** on every news cover and detail slide: bottom-right corner, right edge on the 457,200 EMU margin, 1,500,000 × 380,000 EMU (≈ 1.6" × 0.4"), bottom edge 300,000 EMU (≈ 0.33") above the slide's bottom edge; ISO `yyyy-MM-dd` (e.g. `2026-11-18`, the post date), 13 pt bold `C4BEDD`, centred, no wrap, on an opaque pill (card2 `141026` fill, border `2E2752`) so it stays readable over images; shape name "Data news". Nothing else is placed in that corner.
- **No mid-word breaks**: auto-fit shrinks a text box until its longest word fits on one line; hero values are sized with `one_line()` so they never wrap inside a word.
- One card family: rounded rectangles with a soft shadow; text boxes auto-fitted (font shrinks to fit, never below 11 pt; titles wrap and shrink to ≥ 18–20 pt). Body text 13–16 pt.

## Slide order
1. Cover — `assets/cover.jpg` full bleed, "GITHUB CHANGELOG · LABEL COPILOT", title, "N news dal … al …", one pill per section with its count, author · date.
2. Panoramica — total, proportional section bar + legend, weekly bar chart (Monday-based weeks), 3 highlight cards from `deck_config.highlights`; excluded posts listed in the notes.
3. Agenda — one clickable row per section: count pill, name and subtitle (open the hidden index), and "slide a–b" (opens the divider).
4. Per section: divider (count in section colour, `ic-<section>.png` in a tinted circle, date-range pill) → index slides "<Sezione>: le news in breve" (7 clickable rows: date pill, original title, status pill, "→ N" to the news cover; **hidden by default** — `show="0"`, skipped in the slide show but still reached by the agenda/index links and still counted in the slide total; notes start with "Indice:") → per news a COVER + a DETAIL slide, newest first. Empty sections retain their divider and one hidden index. Retired ends with the calendar (≤ 9 rows per slide).
5. Chiusura — `assets/closer.jpg` left, "Cosa fare adesso" with 4 numbered cards from `deck_config.actions`; the changelog URL is in the speaker notes only.
6. PowerPoint sections: Introduzione · Modelli · Release · Improvement · Governance · IDE · Retired · Chiusura (including empty ones).

## News cover
Left column: eyebrow "SEZIONE · NEWS i/n", status pill, "data · type", title (30 pt, auto-fit), Italian summary, hero card (hero_value in section colour + hero_label); no footer; date tag bottom-right. Right side by image (no caption):
- landscape image (article image: screenshot, UI, diagram, infographic, code) → framed card with shadow, vertically centred;
- portrait image (generated 2:3 illustration) → full-height right panel;
- no image, or an image that is the generic changelog banner → section icon in a tinted circle (the renderer never places a banner and lists it in `banner_rejected`).
Notes: article reference only (title, date, URL).

## News detail (header: eyebrow "SEZIONE · DD MMM YYYY [· TYPE] · DETTAGLIO", status pill, title 26 pt auto-fit)
- **Modelli** — hero tile + 3 fact tiles; "PERCHÉ CONTA" bullets; card "DISPONIBILITÀ" + "COME ATTIVARLO".
- **Release** — 2×2 numbered feature grid (3 points → 4th cell holds the hero value); band "Disponibilità | Come iniziare".
- **Improvement** — "IMPATTO" panel (hero + availability); "COSA MIGLIORA" rows with ✓; "Come iniziare" strip.
- **Governance** — 3 fact chips; "COSA CAMBIA PER GLI ADMIN" checklist; "AZIONE PER L'ADMIN"; "AMBITO E DISPONIBILITÀ".
- **IDE** — editor-window mock-up (`cosa-cambia.md`, numbered lines) + cards Disponibilità / Come iniziare.
- **Retired** — rows "DA DISMETTERE → DATA → ALTERNATIVA" with arrows, other points as bullets, "Azione richiesta" strip.
No footer, no doc links (`doc_links` is not rendered); date tag bottom-right. Notes: article reference only (title, date, URL).

## Retirement calendar
Rows from `migrations`, labelled points (`Modello:/Data:/Alternativa:`) or `old → date → alternative` points; one row per (component, date), latest post wins; dates normalised to dd/mm/yyyy, newest first; status DISMESSO (date before period_end, or before `today` in the config) or IN ARRIVO.

## Images and size
- **Image policy**: the article image always wins; the only image rejected is the generic GitHub Changelog banner (the post's default social image: dark ground, glowing octocat dome, "Changelog" or the post title, type tag; blue, green or red). It is recognised **by its look, never by its size** — sizes vary because images get resized — through `scripts/banner.py` (brightness-map correlation with an embedded reference, threshold 0.82; 0.74–0.82 = review by eye). Calibrated on 89 real changelog images with 0 errors: banners ≥ 0.89, article images ≤ 0.73, generated illustrations ≤ 0.65. Fallback order: article image in the post body → `og:image` if not the banner → generated 2:3 illustration (Cowork) → section icon.
Every image is recompressed to ≤ 1600 px JPEG q82 before insertion (a ~90-news deck ≈ 5–6 MB). Target < 15 MB.

## UI verification (QA)
Run `scripts/check_deck.py --deck <deck>.pptx --news news.json --images images/ --raw raw/ --render --out qa/` after every build; deliver only with 0 errors.
- Static: sections (order, names) · ground (same dark background on every slide) · bounds · overflow (renderer metrics) · font (≥ 11 pt, Segoe UI/Consolas) · contrast (WCAG 4.5:1, 3:1 for large text, against the fill or the image area under the text) · overlap · picture (distortion, banner, resolution) · language (Italian body text and notes; titles and links excluded) · weekly posts · references (no "Fonte:", "Documentazione ufficiale", image caption, visible URL or external hyperlink on a slide) · links (each news URL in the speaker notes) · images policy (a non-banner article image must be used; no banner) · `date` (a news slide — notes starting "Articolo:" — without a yyyy-MM-dd tag bottom-right, or with a date different from the post URL date, is an ERROR) · `hidden` (a section index slide — notes starting "Indice:" — that is not hidden is an ERROR; so is any other hidden slide).
- Render (`--render`, LibreOffice → PDF with the `ExportHiddenSlides` filter option so hidden slides are rendered too, read with pypdfium2 or PyMuPDF): page count = slide count, no blank or light slide, `text_outside` (characters drawn outside every text box), `word_break` (a single word — hero value, badge, date — drawn on more than one line is an ERROR). An older LibreOffice that skips hidden slides → only the visible slides are checked, with a warning.
- Outputs: `qa/sheets/sheet_NN.jpg` (12 slides each, numbered bottom-left so the date tag stays visible, hidden slides labelled "N (nascosta)", red badge = errors), `qa/flagged/slide_NNN.png`, `qa/ui_report.md` + `.json` (Italian), one JSON summary line; exit code 1 on errors; `--reuse-pdf` reuses `qa/deck_render.pdf` when the deck did not change.
- Fix the record or the image and rebuild — never patch slides by hand; max 3 rounds. Then look at every contact sheet and flagged PNG.
- Overview chart week labels are on two lines at 11 pt (they used to shrink to 10 pt).
