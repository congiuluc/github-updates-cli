# Maintaining Copilot Changelog CLI

This guide covers code structure and change safety. For command usage, see the
[README](README.md) and the [complete guide](docs/index.html).

## Development setup

Use the Node.js release in [.node-version](.node-version). From a fresh checkout:

```shell
npm ci
npm run typecheck
npm test
npm run build
```

There is no separate documentation build or lint command. TypeScript strict mode,
Vitest, and the existing formatting conventions are the baseline. Keep changes
focused; avoid dependency upgrades or new tooling just to perform a refactor.

Tests use temporary directories, mocked network responses and injected Copilot
sessions. They should not require credentials or spend AI credits. Native packaging
tests may be skipped on platforms that cannot run them.

## Module boundaries

| Area | Entry points | Responsibility |
| --- | --- | --- |
| Command shell | [cli.ts](src/cli.ts) | Startup status, Commander declarations, profile precedence, exit reporting. Loads the workflow only for generation commands. |
| Option parsing | [run-options.ts](src/run-options.ts), [profiles.ts](src/profiles.ts) | Convert untrusted flags/profile values into validated dates, numbers and canonical locales. |
| Run pipeline | [workflow.ts](src/workflow.ts) | Coordinate discovery/import, locks, checkpoints, accepted-content reuse, enrichment, exports and incremental completion. |
| Sources | [collector.ts](src/collector.ts), [news-cache.ts](src/news-cache.ts) | Discover RSS/Atom/changelog metadata, explain selection, prepare selected articles and cache downloads. |
| AI task | [enrichment-prompt.ts](src/enrichment-prompt.ts), [content-rules.ts](src/content-rules.ts) | Section-specific prompt construction and shared hard acceptance limits; no SDK calls or persistence. |
| AI execution | [enricher.ts](src/enricher.ts), [usage.ts](src/usage.ts) | Validate/correct responses, bound parallel sessions, account for credits, and drain/clean up sessions. |
| Content rules | [types.ts](src/types.ts), [generation.ts](src/generation.ts), [locales.ts](src/locales.ts) | Shared content contracts, evidence, targeted revisions and localization. |
| Saved state | [checkpoint.ts](src/checkpoint.ts), [run-lock.ts](src/run-lock.ts), [content-store.ts](src/content-store.ts), [incremental.ts](src/incremental.ts), [storage.ts](src/storage.ts) | Validate and persist different kinds of state without conflating their lifetimes. |
| Output | [presentation.ts](src/presentation.ts), [html.ts](src/html.ts) | Render accepted content; never make AI calls to fill missing fields. |
| User feedback | [console-output.ts](src/console-output.ts), [progress.ts](src/progress.ts), [trace.ts](src/trace.ts) | Terminal-aware severity colors, safe file links, final recovery summaries, compact status and unmodified diagnostic events. |
| Distribution | [updater.ts](src/updater.ts), [packaging/](packaging/), [workflows](.github/workflows/) | Verify updates and build native packages from tagged source. |

Keep shared data shapes in the domain modules. Use type-only imports when no
runtime dependency is needed. `GeneratedContent` describes validated text;
`EnrichedPost` combines it with source data and an optional downloaded image.
The re-export of `GeneratedContent` from the enricher is retained for compatibility.

## Execution and state contracts

### Preview, discovery and import

- Discovery selects metadata without downloading article bodies. Preparation
  downloads or validates only selected entries, in selection order.
- Title filters, deduplication and delivered-URL exclusions run before the global
  article limit. Dry-run must retain the reason for each in-range decision.
- Dry-run may use the source-index cache, but never writes briefing checkpoints,
  incremental progress or final outputs, and never calls AI.
- Import validates an editable document before rendering or spending credits.
  Ordinary import does not touch an unrelated run checkpoint or fetch source pages.
- Do not add generation dependencies to startup: help, version and update commands
  must work without importing the workflow, collector, enricher or exporters.

### Three distinct persistence lifetimes

| State | Purpose | Completion rule |
| --- | --- | --- |
| Per-briefing checkpoint | Accepted articles and cumulative usage for one selected briefing | Remove only after all requested outputs succeed and nothing remains pending. |
| Accepted-content cache | Reuse validated text across date ranges and output formats | Key by source fingerprint and every generation setting that affects text. Missing is a cache miss; malformed is an error. |
| Incremental history | Remember delivered URLs and the next time window | Advance only after full delivery. Freeze pending windows on failure, budget pause or review-only mode. |

The source-download cache is separate: it expires downloaded metadata/pages and
may refresh malformed entries. Do not apply that permissive policy to paid,
accepted-content caches.

`contentVersion` in [run-options.ts](src/run-options.ts) is a compatibility marker,
not the package/release version. Bump it when accepted generated content can no
longer be reused safely. Do not bump it for code moves or layout-only changes.

Run locks use exclusive creation and verify ownership on release. Never reclaim
an unknown lock automatically. Concurrent article and usage callbacks must share
the checkpoint write queue; atomic replacement alone does not serialize writers.
Keep incremental completion after successful exports, not after source collection
or after the first accepted article.

Explicit `unlock` recovery requires a dead local PID and unchanged ownership.
Its recovery fence blocks run acquisition before and after exclusive lock creation.
Do not add a force flag or recursive deletion to this command; foreign, malformed,
linked and updater-directory locks need separate investigation. An abandoned
recovery fence uses the same owner schema and can be recovered by its exact path.

### Concurrency, errors and credits

- Workers return articles in source order, not completion order.
- A content-review failure omits that article and continues. An operational failure
  stops queued work, drains active peers and preserves their accepted results.
- SDK timeouts do not cancel generation. Stop new requests, account for late usage,
  then abort/disconnect before stopping the runtime. Never retry a busy timed-out
  session.
- Usage callbacks carry **whole-invocation snapshots**, not deltas. Add each snapshot
  to the saved previous-run total; never add successive snapshots to one another.
- Persist the pending request before sending it. Keep usage listeners active until
  session cleanup finishes, and surface persistence failures through `flush()`.
- Credit limits are soft: active concurrent calls may overshoot. Missing billing
  reports make history incomplete, not free. A budget pause returns exit code 2
  and keeps the briefing resumable.
- Preserve the original failure when reporting cleanup failures. Do not turn
  errors into empty arrays, successful output, or unreported fallbacks.

### Locales, evidence and revisions

Canonicalize BCP 47 tags at input boundaries. Note keys, localization data, cache
keys and checkpoint settings must agree on the canonical spelling. Preserve
locale-specific punctuation, RTL direction, grapheme boundaries and date formatting.
Deterministic mode does not promise machine translation.

Evidence checks prove quote provenance and field coverage, not factual entailment.
The 80-140 word presenter-script size is a prompt target, not a validation rule.
Keep prompt instructions and validators aligned without restoring removed checks
accidentally.
Hard text budgets live in the shared content rules; optional translation budgets
live in the locale validator. Keep unrelated section guidance out of initial
prompts, and do not confuse prompt-size improvements with measured reductions in
real model retries. Retain boundary tests and the bounded retry safety net.

For targeted regeneration, merge only explicitly selected fields from the model
response. Preserve all other accepted fields, translations, images and evidence.
Failed revisions must not erase previously accepted content.

## Testing a change

Start with the smallest relevant group:

```shell
npm test -- src/run-options.test.ts src/enrichment-prompt.test.ts
npm test -- src/collector.test.ts src/news-cache.test.ts
npm test -- src/enricher.test.ts src/usage.test.ts src/generation.test.ts
npm test -- src/cli.test.ts src/workflow.test.ts
npm test -- src/docs.test.ts src/docs-navigation.test.ts
```

Then run type-check/build. For changes crossing orchestration, persistence or
export boundaries, run the full suite as well. On constrained machines, use
`npm test -- --maxWorkers 1 --testTimeout 30000`; investigate failures instead of
weakening assertions to make timing issues disappear.

When spawning child CLI processes, isolate `TMPDIR`, `TEMP` and `TMP` together.
macOS can otherwise read another test's cached feed, making network assertions
depend on test order. Always drain asynchronous work before removing fixtures.

New options belong in the CLI declaration, the raw option interface and the
relevant parser/profile schema. Add behavior tests, long-option documentation
examples and the short/long reference entry together. Keep README concise and
link detailed explanations from the Pages guide.

Style human output through the shared console helpers; never color JSON, verbose
trace records or machine-readable version output. Respect each destination
stream's TTY state and `NO_COLOR`. Fit progress rows before adding ANSI sequences.
Use encoded file URLs for terminal links, never shell commands or raw paths inside
OSC sequences. Print the completion summary after output/state work and the run
lock have finished, and preserve the explicit resume reminder for partial decks.
The progress spinner refreshes only the TTY frame; it must not manufacture completed
articles or percentages. Clear its unreferenced timer on stop, completion, failure
and budget pause. Use grapheme-aware cell widths so block glyphs take one cell,
CJK/emoji take two, and narrow displays retain counters without wrapping.

## Release and documentation changes

Tag releases use the tag-derived version in isolated package and lockfile copies.
Builds must use the exact resolved tagged commit. Recovery dispatch runs the updated
workflow on `main` with an existing tag; rerunning an old failed run uses its old
workflow. Do not move a published tag as a shortcut.

The release workflow intentionally keeps version resolution/stamping inline so it
can package older tagged commits that lack newer helper files. Changes to that
workflow need the packaging and release-workflow tests.

Updater status is local and read-only. Deferred update messages must say scheduled,
not installed; the helper verifies the version at the same installation root before
logging success. Keep source checkouts separate from npm-global installs, and drain
both binary/checksum downloads before removing their shared staging directory.

Stable releases then call the opt-in distribution workflow. The distribution
helpers in [packaging/](packaging/) prepare checksum-verified manifests, open
reviewable registry PRs and publish an already-built npm tarball. Keep tooling
checked out at the workflow revision and npm source at the immutable release
commit. Never rebuild packages with registry-write credentials, force-push
publication branches, or overwrite a published version. Run the distribution
and updater tests when modifying these paths; configure external publishers
separately as described in the Pages distribution guide.

Pages publishes [docs/](docs/) after changes reach `main`; local edits do not
publish anything. Keep section IDs and deep links stable, and preserve search,
Back/Forward, printing and no-JavaScript access. Scheduling examples remain outside
the active workflow directory until a user explicitly enables them.
