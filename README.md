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
  <a href="https://congiuluc.github.io/GitHub-Updates-CLI/#install"><img alt="Node.js 22.12+, 24.x, or 26+" src="https://img.shields.io/badge/Node.js-22.12%2B%20%7C%2024%20%7C%2026%2B-6930c3?logo=node.js"></a>
  <img alt="Windows, Linux, macOS" src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-625c71">
</p>

---

## From updates to a briefing

| Collect | Present | Recover |
| --- | --- | --- |
| Combine the Copilot changelog and GitHub Blog AI & ML articles for your date range. | Get section-aware slides, source links, and English or Italian speaker notes. | Keep accepted work and retry omitted slides with `--resume`. |

Copilot receives validation errors to correct rejected content instead of mechanically trimming facts. If final content review still fails, the CLI warns, skips that article, and continues.

## Get started

**Requirements:** Node.js **22.12+ on 22.x, 24.x, or 26+**, and an authenticated GitHub Copilot account for AI enrichment. Self-contained release packages include Node.js.

From a local checkout:

```shell
npm ci
npm run build
npm install --global .
copilot-changelog --from 2026-08-01 --to 2026-08-31
```

Prefer a packaged install? See [platform downloads and authentication](https://congiuluc.github.io/GitHub-Updates-CLI/#install). Downloads and npm installation require the corresponding package to have been published.

### Make it yours

```shell
# Italian slides, bilingual notes, and an offline website
copilot-changelog --from 2026-08-01 --to 2026-08-31 --slides-language it --speaker-notes-languages en,it --website

# Retry missing slides without regenerating accepted content
copilot-changelog --from 2026-08-01 --to 2026-08-31 --resume
```

When resuming a customized run, keep its original language, model, and feed options.

Files are written to `output/`: a `.pptx` deck, a `.trace.jsonl` log, and optional `.html` digest. **Review trace logs before sharing:** they contain prompts and generated text.

## Explore the documentation

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

**Publish the docs:** push to `main`, select **Settings → Pages → GitHub Actions**, and run [Deploy documentation](.github/workflows/pages.yml). See the [publishing checklist](https://congiuluc.github.io/GitHub-Updates-CLI/#github-pages). Until the first deployment, open [docs/index.html](docs/index.html) locally; hosted links and workflow badges may return 404.

---

<sub>Built with the GitHub Copilot SDK. Independent project; not an official GitHub product. GitHub and Copilot are trademarks of GitHub, Inc.</sub>
