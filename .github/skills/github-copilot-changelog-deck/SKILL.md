---
name: github-copilot-changelog-deck
description: |
  Builds an Italian PowerPoint deck of GitHub Copilot news from the GitHub Changelog (label copilot), default last 30 days: cover + detail slide per news in 6 fixed sections (Modelli, Release, Improvement, Governance, IDE, Retired), dark Fluent 2 theme, explanatory images, retirement calendar, clickable agenda; article reference only in speaker notes. Rendered by the bundled build_deck.py, so it works in Cowork and in GitHub Copilot (CLI / VS Code). Use when the user asks "prepara il deck con le novità di GitHub Copilot", "deck changelog Copilot dell'ultimo mese", "aggiorna il deck changelog Copilot", "presentazione novità GitHub Copilot". Do NOT use for news of other products (Azure, M365 Copilot), a text-only summary, or editing an unrelated presentation (use pptx).
license: Personal use
metadata:
  category: productivity
  icon: SlideTextSparkle
---

# GitHub Copilot – Novità dal changelog (deck)

Every Copilot post of the GitHub Changelog in the period becomes a cover slide + a detail slide, grouped in six
coloured sections, in Italian. The deck is ALWAYS rendered by `scripts/build_deck.py` (python-pptx, portable):
the agent's job is to collect the news, write correct Italian records, pick the images and run the renderer.

## Regole non negoziabili (check every item before delivering)
- [ ] **Italiano ovunque**: slide text, summaries, points, speaker notes and the final reply. Only post titles stay in original English (plus product/model names). Never "ENGLISH" notes.
- [ ] **Esattamente 6 sezioni**, in this order: Modelli · Release · Improvement · Governance · IDE · Retired. Keep empty sections with a zero count and a hidden empty index. No "Announcements", "Enterprise Admins" or other catch-all. Classify (test in this order, first match wins):
  - `modelli` = models, model availability in plans/clients, Fusion/HydraFusion/auto routing, model benchmarks — even when typed Release/Improvement;
  - `retired` = deprecations, retirements, end of support;
  - `governance` = admin, policies, managed settings, billing, usage metrics/telemetry, seats/licences, audit, identity, admin-facing security;
  - `ide` = changes specific to VS Code, Visual Studio, JetBrains, Xcode or Eclipse;
  - `release` = new features; `improvement` = improvements to existing features.
- [ ] **Escludi** the "GitHub Copilot weekly release(s) …" roundups (the renderer also drops them) and every post outside `period_start`–`period_end`.
- [ ] **Ogni news = copertina + dettaglio**, newest first in each section (the renderer does it).
- [ ] **Nessun riferimento sulle slide**: niente fonti, link, URL o didascalie delle immagini; il riferimento all'articolo (titolo, data, URL) sta solo nelle note del relatore.
- [ ] **Mai inventare** posts, URLs, dates, model names or numbers. Unknown URL → `null`, and say so.
- [ ] **Mai scrivere codice pptx proprio**: no python-pptx/pptxgenjs/HTML-to-pptx code of your own, no EditArtifact batches. Always `scripts/build_deck.py`.
- [ ] **Immagini**: Immagini dell'articolo sempre, tranne il banner generico del changelog (riconosciuto da banner.py per aspetto, non per dimensione): solo allora illustrazione generata (Cowork) o icona di sezione.
- [ ] **Data della news** in basso a destra su copertina e dettaglio, formato aaaa-MM-gg (es. 2026-11-18).
- [ ] **Slide indice delle sezioni nascoste di default** (raggiungibili dai link di agenda/indice).
- [ ] **Nessuna parola spezzata** a metà su due righe (valori hero, badge, data).
- [ ] **Verifica UI superata**: `check_deck.py` senza errori; se il rendering è attivo, fogli di anteprima guardati prima della consegna.

## When to Use
- "prepara il deck con le novità di GitHub Copilot dell'ultimo mese" / "di ottobre" / "dal 1 al 15 novembre"
- "aggiorna il deck changelog Copilot" (rebuild the whole deck for the new period)
- "fammi una presentazione delle news GitHub Copilot dal changelog"

## When NOT to Use
- News of other products (Azure updates, Microsoft 365 Copilot, VS Code release notes alone) — different sources.
- A chat or email summary of the news with no deck — answer directly from the changelog.
- Edits to an unrelated presentation — use the pptx skill.

## Inputs and defaults
- **Period**: last 30 days ending today; the user can override (`period_start`, `period_end`, `YYYY-MM-DD`).
- **Author line**: "Luca Congiu · Cloud Solution Architect".
- **File name**: "GitHub Copilot - Novità dal changelog (<periodo>).pptx", e.g. "(1 ott - 19 nov 2026)".

## Esecuzione in GitHub Copilot (CLI / VS Code agent)
- **Where the skill lives**: unzip the folder into `~/.copilot/skills/github-copilot-changelog-deck/` (personal) or `<repo>/.github/skills/github-copilot-changelog-deck/` (repository). `SKILL_DIR` below is that folder.
- **Prerequisites**: Python 3.9+ and `pip install python-pptx` (which also installs Pillow; check with `python -c "import pptx, PIL"`). The project CLI runs static checks only; `--preview` additionally uses `pip install render-pptx==0.2.0` for approximate PNGs that can omit content and do not verify visual layout. When using `check_deck.py` directly, rendered verification in step 5 additionally needs LibreOffice and `pypdfium2` or PyMuPDF — Windows `winget install TheDocumentFoundation.LibreOffice`, macOS `brew install --cask libreoffice`, Linux `apt install libreoffice-impress`. `check_deck.py` finds `soffice` via `--soffice`, `$SOFFICE`, PATH, `/opt/libreoffice*/program/soffice`, Windows Program Files and macOS Applications. In Cowork, LibreOffice is at `/opt/libreoffice*/program/soffice` and is found automatically.
- **Reading the changelog**: use the agent's own web fetch on https://github.blog/changelog/label/copilot/ (then `/page/2/`, …) or, better, the RSS feed https://github.blog/changelog/label/copilot/feed/ — each item holds the full post HTML with its text and its images.
- **Images**: save the RSS feed to `deck/feed.xml`, list the image URLs with `scripts/pick_images.py urls`, download them yourself with curl/requests into `deck/raw/<id>/01.<ext>, 02…`, then `pick_images.py pick` (step 3). GitHub Copilot has no image generator: news without an explanatory image get the section icon on the cover — say so in the reply.
- **Build**: always `python SKILL_DIR/scripts/build_deck.py …` (step 4). Write the deck in the current folder. Never write your own pptx code, even if the script fails: fix the record or the input and re-run.

## Workflow (same in every environment; paths relative to a work folder `deck/` — in Cowork `working/deck/`)

### 0. Prepare
1. Locate `SKILL_DIR` (Cowork: copy it first, `cp -r /mnt/user-config/skills/github-copilot-changelog-deck/. working/ccd/`, and use `working/ccd`).
2. `pip install python-pptx` if the import fails; it installs Pillow as a dependency. For rendered verification only, also install LibreOffice and `pypdfium2` or PyMuPDF. Create `deck/`, `deck/images/`.
3. Write `deck/deck_config.json` from `assets/deck_config.example.json`: period, author, deck_date; rewrite `highlights` (max 3) and `actions` (4) from the new data, or drop them for the defaults.

### 1. Collect the news (never invent a post)
1. Read the changelog list (web fetch of the label pages or the RSS feed) until posts are older than `period_start`. Record date, original title, type (Release / Improvement / Retired) and URL.
2. Save it as `deck/list.json`, then `python SKILL_DIR/scripts/split_news.py deck/list.json deck/news --start <start> --end <end>` → `master.json` (ids) + `in_0..3.json`, weekly roundups removed.

### 2. Write the records (Italian)
One record per post, format and length limits in `references/news-record-format.md` (examples: `assets/example-news.json`). Read each post (or its RSS item) and keep only facts written there; assign `section` with the rules above. `doc_links` is optional and is not shown in the deck: no need to collect it. With more than 20 posts, parallelise where the environment can (Cowork: four background sub-agents with the brief in that reference, one per `in_k.json`). Merge everything into `deck/news.json` and check every id of `master.json` has a record.

### 3. Images (article first)
**Priority** for each news: (1) the explanatory image in the post body — screenshot, UI, diagram, infographic, code; (2) the post's `og:image`, only if it is not the banner; (3) a generated illustration (Cowork) or, without an image generator, the section icon.
1. Where there is network: save the RSS feed as `deck/feed.xml` (and, for posts not in the feed, the post page as `deck/pages/<id>.html`); `python SKILL_DIR/scripts/pick_images.py urls --news deck/news.json --feed deck/feed.xml --pages deck/pages > deck/image_urls.json`; download each id's URLs in order into `deck/raw/<id>/01.<ext>`, `02.<ext>`… (curl -L, requests, or the agent's fetch — the bundled scripts never open a connection); then `python SKILL_DIR/scripts/pick_images.py pick --news deck/news.json --raw deck/raw --images deck/images --update`. Always pass `--update`, **even when illustrations already exist**: the article image always wins and replaces an earlier generated illustration. It keeps the first non-banner image as `images/<id>.jpg` with `image_kind: "article"` and lists ids with no usable image as `needs_illustration` in `images/_report.json` (per id: `status`, `source`, `banner_score`, `review`; plus `banners_rejected`). No network (e.g. Cowork sandbox): skip to 3.
2. **Banner rule**: the generic changelog banner (the post's default social image: dark ground, glowing octocat dome, "Changelog" or the post title, RELEASE/IMPROVEMENT/RETIRED tag; blue, green or red; any size) is NOT explanatory and never goes on a slide. It is recognised **by its look, never by its size**: `scripts/banner.py` correlates the image's brightness map with a reference banner (score ≥ 0.82 = banner; calibrated on 89 real changelog images with 0 errors). `pick_images.py` and `build_deck.py` both use it; check any file with `python SKILL_DIR/scripts/banner.py <img>…`. **`review: true`** (score 0.74–0.82) means LOOK at the image: keep it if it explains the news, delete it if it is a banner.
3. For `needs_illustration` ids: in Cowork generate a portrait 2:3 Fluent 2 illustration per id (concepts + template in `references/runscript-templates.md`, prompts like `assets/example-concepts.json`) into `deck/images/<id>.png` and set `image_kind: "generated"`. Without an image generator (GitHub Copilot) leave them without image: the renderer shows the section icon.
4. Article images supplied by the user: save as `deck/images/<id>.<ext>`, `image_kind: "article"`.

### 4. Build
```bash
python SKILL_DIR/scripts/build_deck.py --news deck/news.json --config deck/deck_config.json \
  --images deck/images --assets SKILL_DIR/assets \
  --out "deck/GitHub Copilot - Novità dal changelog (<periodo>).pptx"
```
It enforces the layout rules itself (see `references/design-spec.md`): one dark ground, 6 sections newest-first, auto-fit text ≥ 11 pt, per-section detail layouts, clickable agenda/index, notes = article reference only ("Articolo: <titolo originale> – GitHub Changelog, <data>" + URL), no references/captions on slides (no source footer, no visible URL or external hyperlink, no image caption), the news date bottom-right on every cover and detail slide (yyyy-MM-dd on a small opaque tag, readable over images), section index slides hidden by default (still reachable through the agenda/index links), no mid-word breaks (auto-fit shrinks the text until the longest word fits on one line; hero values are sized to stay on one line), retirement calendar, PowerPoint sections. It never places a banner (safety net: a news whose image is a banner falls back to the section icon and is listed in `banner_rejected`). It prints one JSON line: `out, slides, news, per_section, dropped, size_mb, images` (article / generated / icon counts) `, banner_rejected`.

### 5. Verifica UI (obbligatoria)
1. Read the `build_deck.py` JSON summary: `slides` = 3 + per section (1 divider + max(1, ⌈n/7⌉) index + 2n) + calendar + 1 closer (hidden index slides count too); `size_mb` < 15 (else check that `images/` holds no huge or duplicated files); every `dropped` entry is a weekly roundup, an out-of-period post or a bad `section` you then fix; `images` counts as expected; every `banner_rejected` id must end up with a generated illustration or the section icon, never a banner.
2. Run the static check:
   ```bash
   python SKILL_DIR/scripts/check_deck.py --deck "deck/<file>.pptx" --news deck/news.json \
     --images deck/images --raw deck/raw --out deck/qa
   ```
   When invoking the script directly, add `--render` to enable optional rendered verification and contact sheets.
   STATIC checks: sections (order, names), ground (same dark background everywhere), bounds, overflow (renderer metrics), font (≥ 11 pt, Segoe UI/Consolas), contrast (WCAG 4.5:1, 3:1 for large text, against the fill or the image area under the text), overlap, picture (distortion, banner, resolution), language (Italian body text and notes; titles and links excluded), weekly posts, references (no "Fonte:", "Documentazione ufficiale", image caption, visible URL or external hyperlink on any slide), `date` (every news slide — notes starting "Articolo:" — has a yyyy-MM-dd tag bottom-right matching the post URL date), `hidden` (every section index slide — notes starting "Indice:" — is hidden; no other slide is hidden), links (each news URL in the speaker notes), images policy (a non-banner article image must be used; no banner). RENDER checks (LibreOffice → PDF with hidden slides exported via `ExportHiddenSlides`, read with pypdfium2 or PyMuPDF): page count = slide count, no blank or light slide, `text_outside` (characters actually drawn outside every text box), `word_break` (a single word — hero value, badge, date — drawn on more than one line). An older LibreOffice that skips hidden slides makes it check only the visible slides, with a warning. Output: `qa/sheets/sheet_NN.jpg` contact sheets (12 slides each, numbered bottom-left so the date tag stays visible, hidden slides labelled "N (nascosta)", red badge = slide with errors), `qa/flagged/slide_NNN.png` per slide with an error, `qa/ui_report.md` + `qa/ui_report.json` (Italian) and one JSON line `{"errors", "warnings", …}`; exit code 1 when there are errors.
3. **While errors > 0**: fix the cause in the record (shorter text, right section, Italian wording) or the image, rebuild with `build_deck.py`, re-run `check_deck.py`. Use `--reuse-pdf` only when the deck did not change. Never patch slides by hand. Stop after 3 rounds and report what remains.
4. When rendered verification is enabled, **LOOK** at every contact sheet in `qa/sheets/` (Cowork: view the image files directly; GitHub Copilot CLI / VS Code: open or attach the JPGs) and at every `qa/flagged/` PNG. Visual checklist: title fully visible and not cut; no empty or crowded card; article image readable and not stretched; no banner; badges aligned; nessuna fonte, link o didascalia visibile sulle slide; data aaaa-MM-gg leggibile in basso a destra; indici marcati "(nascosta)" nei fogli; nessuna parola spezzata; calendar readable; the same dark ground everywhere. If render verification is skipped, inspect the deck manually before sharing.
5. **Warnings**: review them, keep only the justified ones (e.g. an English UI setting name quoted inside Italian text) and list them in the reply.

### 6. Deliver
- **Cowork**: build into `working/deck/`, then `CopyArtifact(surface="output", source="working/deck/<file>.pptx", destination="<file>.pptx")` (create-only: never `overwrite=true` for a .pptx — if the name exists, add a suffix such as "v2"). Check the result is `ok: true`; it returns the deck's `file_N` handle, which is what you show the user and what `GetArtifactModel` renders for QA.
- **GitHub Copilot / CLI**: the `.pptx` stays in the work folder; give its path.
- The `qa/` folder stays in the work folder (Cowork: `working/deck/qa/`) and is not delivered unless the user asks.

### 7. Reply (Italian, short)
- Table: sezione · slide da–a · numero di news (from the JSON summary / agenda).
- One line: "Le slide indice delle sezioni sono nascoste (si raggiungono dai link di agenda e indice); ogni news riporta la data in basso a destra (aaaa-MM-gg)."
- Period covered and excluded posts (weekly roundups, out of period).
- Verifica UI: one line "Verifica UI: 0 errori, N avvisi (…)" naming the justified warnings.
- Image provenance from the build_deck `images` counts: article / generated / icon, plus how many banners were discarded.
- Caveats: ids with `url: null`, file size.

## Output format
One `.pptx` named "GitHub Copilot - Novità dal changelog (<periodo>).pptx": cover, panoramica, agenda, per section divider + index (hidden by default, reachable from the agenda/index links) + cover/detail pairs (news date bottom-right, yyyy-MM-dd), Retired calendar, closing slide; PowerPoint sections Introduzione · Modelli · Release · Improvement · Governance · IDE · Retired · Chiusura. No source, link, URL or image caption on any slide; each news slide's speaker notes hold only the article reference (original title, date, URL). A ~90-news period ≈ 200 slides (hidden index slides included), ≈ 6 MB.

## Tools used
Web fetch / web search (changelog, RSS, posts) · Bash/Python (curl or requests for image downloads) for `split_news.py`, `banner.py`, `pick_images.py`, `build_deck.py`, `check_deck.py` · LibreOffice `soffice` (render check) and pypdfium2 (PDF reading) · Cowork only: `task` sub-agents (extraction), `core-RunScript` + `host-ImageGenerate` (illustrations), `host-CopyArtifact` (publish to output), `host-GetArtifactModel` + `core-RenderArtifact` (QA).

## Example
```
User: "prepara il deck con le novità di GitHub Copilot dal 1 ottobre"
→ 90 posts in the RSS/label pages, 4 weekly roundups excluded → 86 Italian records
→ pick_images.py --update: article images kept (banners rejected by look via banner.py) → generated illustrations for the rest (Cowork)
→ build_deck.py → {"slides": 200, "news": 86, "per_section": {"modelli": 14, "release": 23, ...}, "size_mb": 5.8, "images": {"article": ..., "generated": ..., "icon": ...}, "banner_rejected": [...]}
→ check_deck.py --render → {"errors": 0, "warnings": 3, ...} (references: 0; date: every news slide dated bottom-right; hidden: 15 index slides hidden; word_break: 0); contact sheets in qa/sheets/ looked at
→ reply: "Deck pronto: 200 slide, 86 news. Modelli 4–35 (14) · Release 36–86 (23) · … Esclusi i 4 riepiloghi settimanali. Le 15 slide indice sono nascoste (raggiungibili da agenda e indici); data aaaa-MM-gg in basso a destra su ogni news. Verifica UI: 0 errori, 3 avvisi (nomi di impostazioni in inglese citati nel testo)."
```

## Bundled files
- `scripts/build_deck.py` — the deck renderer (python-pptx); the only build path; never places a banner; dates every news slide bottom-right (yyyy-MM-dd) and hides the section index slides.
- `scripts/pick_images.py` — lists post image URLs (from the saved feed/pages) and picks the article image per news, rejecting only the generic banner (via `banner.py`); `--update` also replaces earlier generated illustrations; offline.
- `scripts/banner.py` — recognises the generic changelog banner by its look (brightness-map correlation, threshold 0.82, review band 0.74–0.82), never by its size; `python banner.py img…`.
- `scripts/check_deck.py` — UI verification of the built deck: static checks (incl. `references`: no source/caption on slides; `date`; `hidden`) + LibreOffice render checks (incl. hidden slides, `word_break`), contact sheets, flagged slides, Italian report; exit 1 on errors.
- `scripts/split_news.py` — list → `master.json` + extraction batches, weekly roundups removed.
- `references/news-record-format.md` — record schema (`doc_links` optional, not rendered), section rules, extraction brief.
- `references/design-spec.md` — palette, slide order, layouts, calendar, size rules.
- `references/runscript-templates.md` — Cowork-only parallel ImageGenerate template.
- `assets/` — `cover.jpg`, `closer.jpg`, `ic-<section>.png` (6 section icons), `deck_config.example.json`, `example-news.json`, `example-concepts.json`.

## Guardrails
- Facts only from the changelog posts; never invent a post, URL, date, model name or number.
- Always exclude "GitHub Copilot weekly release(s)…" roundups; respect the period.
- The article reference (original title, date, URL) is ONLY in the speaker notes of each news slide; nothing about sources, links or image provenance goes on the slides.
- Nothing is sent, shared or e-mailed; the deck is only written to the work folder / output.
- If `build_deck.py` fails, read the error, fix the input and re-run; do not fall back to hand-written slides.
- Never deliver a deck while `check_deck.py` reports errors (after 3 fix rounds, report what remains); never put a generic changelog banner on a slide.
