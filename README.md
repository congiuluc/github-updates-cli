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
  <a href="https://congiuluc.github.io/github-updates-cli/"><strong>Documentation</strong></a> ·
  <a href="https://congiuluc.github.io/github-updates-cli/#usage">Quick start</a> ·
  <a href="https://github.com/congiuluc/github-updates-cli/releases">Releases</a> ·
  <a href="https://github.com/congiuluc/github-updates-cli/issues">Report an issue</a>
</p>

<p align="center">
  <a href="https://github.com/congiuluc/github-updates-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/congiuluc/github-updates-cli/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://congiuluc.github.io/github-updates-cli/"><img alt="Documentation deployment" src="https://github.com/congiuluc/github-updates-cli/actions/workflows/pages.yml/badge.svg"></a>
  <a href="https://congiuluc.github.io/github-updates-cli/#install"><img alt="Node.js 24 LTS, minimum 24.21.0" src="https://img.shields.io/badge/Node.js-24.21.0%2B%20LTS-6930c3?logo=node.js"></a>
  <img alt="Windows, Linux, macOS" src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-625c71">
</p>

---

## From updates to a briefing

| Collect | Present | Recover |
| --- | --- | --- |
| Collect the Copilot changelog, optional RSS/Atom feeds and AI & ML articles; preview and filter before spending. | Get audience-aware slides, source quotations, editable JSON, and locale-selected presenter notes. | Reuse accepted content, cap credits, and resume or schedule incremental briefings. |

Copilot receives validation errors to correct rejected content instead of mechanically trimming facts. If final review fails, the CLI warns, skips that article, and continues. Transient retries receive the latest error, original task and outstanding validation problems; timeouts are not retried on a potentially busy session.

## Get started

**Requirements:** Node.js **24 LTS, version 24.21.0 or newer within 24.x**, and an authenticated GitHub Copilot account for AI enrichment. Self-contained release packages include Node.js. CI and bundled runtimes use the version pinned in [.node-version](.node-version).

From a local checkout:

```shell
npm ci
npm run build
npm install --global .
copilot-changelog --from 2026-08-01 --to 2026-08-31
```

Prefer a packaged install? See [platform downloads and authentication](https://congiuluc.github.io/github-updates-cli/#install). This README describes the current source; published releases may lag behind. Check `copilot-changelog --help` for installed options, or build from source to use newer features. Publishing the docs does not update installed CLI packages.

### Make it yours

```shell
# Canadian French slides, multilingual notes, and an offline website
copilot-changelog --from 2026-08-01 --to 2026-08-31 --slides-language fr-CA --speaker-notes-languages fr-CA,ja,ar --website

# Retry missing slides without regenerating accepted content
copilot-changelog --from 2026-08-01 --to 2026-08-31 --resume

# Add one or more RSS feeds alongside the changelog (URLs or local XML files)
copilot-changelog --rss https://example.com/news.xml https://example.org/releases.xml

# Opt into GitHub Blog AI & ML articles (disabled by default)
copilot-changelog --include-ai-ml
```

Examples use long options for clarity; **case-sensitive short aliases** remain available in the [complete option reference](https://congiuluc.github.io/github-updates-cli/#cli-reference).

`--rss` accepts RSS and Atom, including repeated occurrences. `--include` / `--exclude` filter titles before the global `--limit`; otherwise all in-range articles are eligible. `--full-articles` fetches linked pages instead of embedded feed text. `--feed` replaces the base changelog; `--rss` and `--include-ai-ml` can still add to it.

Languages accept canonical BCP 47 locale tags, such as `de`, `pt-BR`, `zh-Hant` and `ar`, not a fixed language list. AI also localizes slide headings and introductory notes; translation quality depends on the model. When resuming, keep the original locale, model and source options. `--no-ai` does not translate source text and uses English template fallbacks where built-in translations are unavailable.

Interactive terminals show an in-place progress bar and a status row per concurrent worker (`--concurrency 1` through `8`). Source preparation updates in place too. Redirected output, `TERM=dumb`, and `--verbose` keep plain scrolling logs; warnings and errors remain visible.

AI runs report cumulative credits across resume. `--max-credits` stops new requests at a soft limit; active calls may overshoot. Missing billing data pauses budgeted runs rather than assuming calls are free. Budget pauses retain the checkpoint and exit with code 2. Accepted content is cached by source and generation settings; `--no-cache` disables reuse and `--restart` requests new content.

### Repeatable briefings

```shell
copilot-changelog --config examples/profiles.json --profile team --dry-run
copilot-changelog --config examples/profiles.json --profile executive --max-credits 5 --review-only --export-json review.json
copilot-changelog --import-json review.json --website
copilot-changelog --import-json review.json --regenerate https://example.com/article --regenerate-field summary --export-json revised.json
copilot-changelog --config examples/profiles.json --profile team --since-last-run --resume
```

Start with the [sample profiles](examples/profiles.json). Profiles, preview, budgets, editable content, evidence and targeted regeneration are explained in the [workflow guide](https://congiuluc.github.io/github-updates-cli/#review-content). [Scheduling templates](https://congiuluc.github.io/github-updates-cli/#automation) are opt-in: nothing registers a task or starts a schedule automatically. Replace the regeneration URL with one listed in your exported JSON.

Files are written to `output/`: a `.pptx` deck, a `.trace.jsonl` log, and optional `.html` digest. **Review trace logs before sharing:** they contain prompts and generated text.

Use `copilot-changelog --version` for the installed version, `copilot-changelog update --check` to check releases without installing, and `copilot-changelog update` to install an update. Release tags supply the version stamped into packaged manifests and lockfiles; existing tags can be rebuilt through the Release workflow's `tag` input.

## Explore the documentation

The online guide shows one section at a time, selected from the sidebar or search results. Section links and browser Back/Forward work as usual. Printing or disabling JavaScript shows the complete guide.

| Start here | Go deeper |
| --- | --- |
| [Installation](https://congiuluc.github.io/github-updates-cli/#install) | [Every CLI option](https://congiuluc.github.io/github-updates-cli/#cli-reference) |
| [Quick start](https://congiuluc.github.io/github-updates-cli/#usage) | [AI review and corrections](https://congiuluc.github.io/github-updates-cli/#review) |
| [Presentation design](https://congiuluc.github.io/github-updates-cli/#presentation) | [Resume and troubleshooting](https://congiuluc.github.io/github-updates-cli/#resume) |
| [Development](https://congiuluc.github.io/github-updates-cli/#development) | [Packaging and releases](https://congiuluc.github.io/github-updates-cli/#packaging) |

## Contribute

```shell
npm run typecheck
npm test
npm run build
```

See the [maintainer guide](CONTRIBUTING.md) for architecture, state contracts and testing. The CLI lives in [src/](src/), workflow templates in [examples/](examples/), platform scripts in [packaging/](packaging/), and the complete static documentation in [docs/](docs/).

**Update the published docs:** push changes under `docs/` to `main`, or run [Deploy documentation](.github/workflows/pages.yml) manually. Preview [docs/index.html](docs/index.html) locally first. For a fork or a new site, follow the [publishing checklist](https://congiuluc.github.io/github-updates-cli/#github-pages).

---

<sub>Built with the GitHub Copilot SDK. Independent project; not an official GitHub product. GitHub and Copilot are trademarks of GitHub, Inc.</sub>
