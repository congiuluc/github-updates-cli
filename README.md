<p align="center">
  <img src="docs/assets/copilot-icon.png" width="88" height="88" alt="Copilot Changelog CLI">
</p>

<h1 align="center">Copilot Changelog CLI</h1>

<p align="center">
  <strong>The changelog. Ready to present.</strong><br>
  Turn GitHub Copilot updates into AI-edited PowerPoint briefings<br>
  with speaker notes and an optional searchable offline website.
</p>

<p align="center">
  <a href="https://congiuluc.github.io/GitHub-Updates-CLI/"><strong>Documentation</strong></a> ·
  <a href="https://congiuluc.github.io/GitHub-Updates-CLI/#usage">Quick start</a> ·
  <a href="https://github.com/congiuluc/GitHub-Updates-CLI/releases">Releases</a> ·
  <a href="https://github.com/congiuluc/GitHub-Updates-CLI/issues">Report an issue</a>
</p>

<p align="center">
  <a href="https://github.com/congiuluc/GitHub-Updates-CLI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/congiuluc/GitHub-Updates-CLI/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://congiuluc.github.io/GitHub-Updates-CLI/"><img alt="Documentation deployment" src="https://github.com/congiuluc/GitHub-Updates-CLI/actions/workflows/pages.yml/badge.svg"></a>
  <a href="https://congiuluc.github.io/GitHub-Updates-CLI/#install"><img alt="Node.js 24 LTS, minimum 24.21.0" src="https://img.shields.io/badge/Node.js-24.21.0%2B%20LTS-6930c3?logo=node.js"></a>
  <img alt="Windows, Linux, macOS" src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-625c71">
</p>

---

## From updates to a briefing

| Collect | Present | Recover |
| --- | --- | --- |
| Collect the Copilot changelog for your date range; optionally add RSS feeds and GitHub Blog AI & ML articles. | Get section-aware slides, source links, and English or Italian speaker notes. | Keep accepted work and retry omitted slides with `--resume`. |

Copilot receives validation errors to correct rejected content instead of mechanically trimming facts. If final content review still fails, the CLI warns, skips that article, and continues.

Transient request retries also receive the latest error, original task, and any outstanding validation problems. Timeouts are not retried on a potentially busy session.

## Get started

**Requirements:** Node.js **24 LTS, version 24.21.0 or newer within 24.x**, and an authenticated GitHub Copilot account for AI enrichment. Self-contained release packages include Node.js. CI and bundled runtimes use the version pinned in [.node-version](.node-version).

From a local checkout:

```shell
npm ci
npm run build
npm install --global .
copilot-changelog --from 2026-08-01 --to 2026-08-31
```

Prefer a packaged install? See [platform downloads and authentication](https://congiuluc.github.io/GitHub-Updates-CLI/#install). This README describes the current source; published releases may lag behind. Check `copilot-changelog -h` for installed options, or build from source to use newer features. Publishing the docs does not update installed CLI packages.

### Make it yours

```shell
# Italian slides, bilingual notes, and an offline website
copilot-changelog -f 2026-08-01 -t 2026-08-31 -s it -n en,it -w

# Retry missing slides without regenerating accepted content
copilot-changelog -f 2026-08-01 -t 2026-08-31 -R

# Add one or more RSS feeds alongside the changelog (URLs or local XML files)
copilot-changelog -r https://example.com/news.xml https://example.org/releases.xml

# Opt into GitHub Blog AI & ML articles (disabled by default)
copilot-changelog --include-ai-ml  # short form: -a
```

All options have **case-sensitive short aliases**; long forms remain valid and can be mixed with short forms. `-r` adds RSS; `-R` resumes; `-S` restarts. `-a` adds the AI & ML blog; `-A` disables AI enrichment. `-f` selects the start date; `-F` replaces the base feed. See the [complete short/long option reference](https://congiuluc.github.io/GitHub-Updates-CLI/#cli-reference).

`--rss` also accepts repeated occurrences. Added feeds include every article in the date range, not only Copilot mentions. All sources are merged, URL-deduplicated, and sorted newest-first before the global `--limit`. Selected RSS entries must contain readable text in `content:encoded` or `description`. `--feed` replaces the base changelog with a custom feed; `--rss` and `--include-ai-ml` can still add to it.

When resuming a customized run, keep its original language, model, and source options, including `--rss` and `--include-ai-ml`.

Interactive terminals show an in-place progress bar and a status row per concurrent worker (`--concurrency 1` through `8`). Source preparation updates in place too. Redirected output, `TERM=dumb`, and `--verbose` keep plain scrolling logs; warnings and errors remain visible.

AI runs print reported AI credits at the end, including failed attempts and reviewer calls. `--resume` shows cumulative usage plus the current execution's usage. Usage is saved to the checkpoint as requests run and included in the trace. Older checkpoints, missing billing events, and interrupted requests are marked **incomplete** or **unavailable**, never assumed free. `--restart` starts a new total; completed runs retain their totals in the trace.

Files are written to `output/`: a `.pptx` deck, a `.trace.jsonl` log, and optional `.html` digest. **Review trace logs before sharing:** they contain prompts and generated text.

Use `copilot-changelog -V` for the installed version, `copilot-changelog update -k` to check releases without installing, and `copilot-changelog update` to install an update.

## Explore the documentation

The online guide shows one section at a time, selected from the sidebar or search results. Section links and browser Back/Forward work as usual. Printing or disabling JavaScript shows the complete guide.

| Start here | Go deeper |
| --- | --- |
| [Installation](https://congiuluc.github.io/GitHub-Updates-CLI/#install) | [Every CLI option](https://congiuluc.github.io/GitHub-Updates-CLI/#cli-reference) |
| [Quick start](https://congiuluc.github.io/GitHub-Updates-CLI/#usage) | [AI review and corrections](https://congiuluc.github.io/GitHub-Updates-CLI/#review) |
| [Presentation design](https://congiuluc.github.io/GitHub-Updates-CLI/#presentation) | [Resume and troubleshooting](https://congiuluc.github.io/GitHub-Updates-CLI/#resume) |
| [Development](https://congiuluc.github.io/GitHub-Updates-CLI/#development) | [Packaging and releases](https://congiuluc.github.io/GitHub-Updates-CLI/#packaging) |

## Contribute

```shell
npm run typecheck
npm test
npm run build
```

The CLI lives in [src/](src/), platform scripts in [packaging/](packaging/), and the complete static documentation in [docs/](docs/).

**Update the published docs:** push changes under `docs/` to `main`, or run [Deploy documentation](.github/workflows/pages.yml) manually. Preview [docs/index.html](docs/index.html) locally first. For a fork or a new site, follow the [publishing checklist](https://congiuluc.github.io/GitHub-Updates-CLI/#github-pages).

---

<sub>Built with the GitHub Copilot SDK. Independent project; not an official GitHub product. GitHub and Copilot are trademarks of GitHub, Inc.</sub>
