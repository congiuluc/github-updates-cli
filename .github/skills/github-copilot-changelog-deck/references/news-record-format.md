# Per-news record format and extraction brief

One JSON object per changelog post. All records end up in ONE `news.json` array (the `--news` input of
`scripts/build_deck.py`); with parallel extraction they are first written to `news/out_<k>.json` and merged.
See `assets/example-news.json` for three real records (Modelli, Governance, Retired).
`build_deck.py` itself drops weekly roundups, records with `exclude: true`, records outside the period and
records with an unknown `section` — the dropped list is in its JSON summary.

| Field | Rule (hard layout limits — count characters) |
|---|---|
| `id` | integer from `master.json` |
| `date` | `YYYY-MM-DD`, publication date on the changelog |
| `title` | original English title, unchanged |
| `type` | `Release` · `Improvement` · `Retired` as labelled on the changelog |
| `section` | `modelli` · `release` · `improvement` · `governance` · `ide` · `retired` (rules below) |
| `url` | verified post URL `https://github.blog/changelog/YYYY-MM-DD-<slug>/`, or `null` — never invented |
| `category` | `agenti` · `automazioni` · `cloud` · `code-review` · `governance` · `ide` · `metriche` · `modelli` · `sicurezza` |
| `status` | `GA` · `PUBLIC PREVIEW` · `PRIVATE PREVIEW` · `DISMESSO` · `DISPONIBILE` · `NON INDICATO` (when the source does not establish a status) |
| `hero_value` | key number or word, ≤ 9 chars (`8`, `71,2%`, `14/12`, `GA`, `2×`); prefer a real number from the post |
| `hero_label` | what `hero_value` means, ≤ 8 words / 48 chars |
| `summary` | one Italian sentence, ≤ 150–160 chars |
| `points` | exactly 4 Italian bullets (3 tolerated), ≤ 105–110 chars each. Retired: `old → YYYY-MM-DD or dd/mm/yyyy → alternative` (`;` separates several migrations in one bullet), or labelled `Modello: …` / `Data: 18 dicembre 2026` / `Alternativa: …` |
| `availability` | plans + surfaces/clients + state, ≤ 130 chars |
| `how_to` | how to enable / where it is (settings path, command, policy), ≤ 130 chars; if the post does not say, what an admin should know |
| `facts` | exactly 3 chips, ≤ 26 chars each (`Pro+ · Business · Ent.`, `VS Code · CLI · app`) |
| `doc_links` | optional, **not rendered** (kept for compatibility): 0–3 `{"title", "url"}` official-doc links from the post, or omit / `[]`. Do not spend time collecting them |
| `exclude` | optional `true` to drop a record without deleting it |
| `image` | optional file name inside `--images` (default: `<id>.jpg` / `.png` / `.jpeg` / `.webp`); no file → section icon on the cover |
| `image_kind` | `article` (explanatory image from the post, set by `pick_images.py pick --update`) or `generated` (illustration); drives the cover layout only (no caption, nothing in the notes) |
| `migrations` | optional, Retired only: `[[old, date, alternative], …]` — overrides parsing of the points for the calendar |

## Section rules (test in this order, first match wins; there is NO catch-all "Announcements" section)
1. **modelli** — new or updated AI models, model availability in new plans/surfaces/clients, model routing (Fusion, HydraFusion, auto model selection), benchmarks/evaluations of models — whatever the changelog type (Release or Improvement).
2. **retired** — deprecations, retirements, end of support of models or features (type Retired, or a post announcing a removal date).
3. **governance** — admin and enterprise controls: policies, managed settings, billing, licences/seats, usage metrics and telemetry, metrics/usage APIs, audit log, identity, admin-facing security and compliance.
4. **ide** — changes specific to one editor: VS Code, Visual Studio, JetBrains, Xcode, Eclipse (a feature shipped in many clients at once goes to release/improvement).
5. **release** — new features (type Release) not covered above.
6. **improvement** — improvements to existing features (type Improvement) not covered above.
The deck order stays Modelli · Release · Improvement · Governance · IDE · Retired; the list above is the order in which to TEST the rules.

Excluded always: the recurring roundups titled "GitHub Copilot weekly release(s) …".

## Brief for the per-post extraction sub-agents (Italian; from the November 2026 run, doc-link step removed)

> Ricevi un file JSON di input con una lista di news (id, date, title, type, section) pubblicate sul GitHub Changelog. Per OGNI news:
> 1. Trova l'URL esatto del post (forma `https://github.blog/changelog/YYYY-MM-DD-<slug>/`, slug = titolo in minuscolo, punteggiatura tolta, spazi → trattini). Usa web_search con il titolo esatto tra virgolette + "github changelog"; puoi provare l'URL ipotizzato con web_fetch. NON inventare URL: se non lo trovi, `"url": null`.
> 2. Leggi il post completo con web_fetch e ricava SOLO fatti scritti nel post (niente supposizioni né conoscenza esterna). I nomi di modelli/prodotti possono esserti sconosciuti: riportali come scritti.
> 3. Scrivi i campi in ITALIANO, stile diretto e tecnico, rispettando le lunghezze massime della tabella (vincoli di layout).
> 4. Assegna `section` con le regole delle sezioni (modelli, retired, governance, ide, poi release/improvement; mai una sezione generica); per le dismissioni scrivi i points come `modello → YYYY-MM-DD → alternativa`.
> 5. Scrivi tutto in italiano tranne `title` (titolo originale inglese) e i nomi propri di prodotti/modelli.
> Niente markdown, emoji o virgolette tipografiche che rompano il JSON. Prima di scrivere il file verifica con python che il JSON sia valido e che nessun campo superi la lunghezza massima. Scrivi il risultato come array JSON nel file indicato (`json.dump(..., ensure_ascii=False, indent=1)`). Non inviare, pubblicare o modificare nient'altro; non creare documenti Office. Messaggio finale: percorso del file, numero di news elaborate, id con url null.
