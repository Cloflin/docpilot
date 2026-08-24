# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
package follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Release headings are read by a machine as well as by you:
`scripts/check-publish.js` matches the first `## x.y.z` heading in this file
against `package.json`'s version and refuses the publish if they disagree.

## 0.2.0 — 2026-08-24

The first release published to npm. 0.1.0 existed only in this repository, so
what follows describes the package as it stands rather than a diff anyone could
have installed. The **Breaking** section still matters: it names changes against
0.1.0 for anyone who was running the package from a clone.

### Breaking

**Continuation chunk ids moved from `#anchor-N` to `#anchor~N`.** A section too
long for one chunk is cut into parts, and the second and later parts used to
take a `-2` suffix — the same suffix the indexer appends to disambiguate two
headings that slug identically. The two could collide, and the collision is
silent: a `gold_chunks` pin, a citation, or a deep link resolves to the wrong
half of a page. `~` cannot collide, because the slugger deletes that character
before it ever reaches an anchor, so no heading can produce one.

Upgrading: rebuild with `npx docpilot index`, then run `npx docpilot lint`. Any
`gold_chunks` entry naming a continuation part now errors with `matches nothing
in index <hash> — repoint it`, and that error is the complete list of what has
to change. Records pinned to a first part (`page#anchor`, no suffix) are
unaffected.

**`topK` woke up.** It has been in the config reference since the first release
and was read by nothing: the gate's k was a literal in `retriever.js`, so the
value an author wrote had no effect. It is now the author's half of the
retrieval-lever channel — clamped to the swept band 1..12, and it overrides the
k that `docpilot tune` measured, exactly as a hand-set `guard.tau` overrides a
calibrated threshold. A site that already sets this key starts getting the
effect the reference always promised, which is a behaviour change on upgrade.
Leave it `null` to keep what the corpus measured.

### Added

**A block-aware chunker.** The cutter now works on blocks — paragraphs, fenced
code, tables, lists — instead of on lines. A table too long for one chunk splits
at a row boundary with its header row re-emitted on each part, so no chunk is
data with unlabelled columns; a fence too long for one chunk is closed and
reopened with the same fence characters, indent and info string, so no chunk
holds code outside a fence and the language survives the cut. Fence detection is
one scanner shared with `normalise.js` — while the two disagreed, a `~~~` line
inside a ``` sample flipped one of them and whole pages were emptied.

**Six golden-set tiers: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.**
`eval`, `bench` and `tune` all take `--level=`, the tiers are cumulative
(`--level=medium` runs low + medium), a record with no `level` reads as `high`,
and a run with no `--level` runs everything. A smoke-sized regression is
therefore a regression in the full set too — and two reports are comparable only
within one tier.

**`docpilot tune`** — the retrieval levers measured instead of guessed. It
sweeps the MMR relevance/diversity knob and the excerpt count against the golden
set (`--lambda=0.5:1.0:0.05`, `--k=4:12`), needs the embedding endpoint only, and
contacts no chat model. Only a full-pool run writes `docpilot/tuning.json`;
`--level` and `--limit` both narrow the pool and both make the run report-only,
because the file is inlined into every reader's bundle.

**The tuning-lever channel, end to end.** `tune` writes `tuning.json`, `index`
inlines it into the manifest, and the browser resolves levers on the same rule
the refusal thresholds already used: what your corpus measured beats what ours
measured, and what the author wrote beats both. Until `index` runs again, a swept
lever is a file on disk and nothing more.

**Hosts that are not VitePress.** Five new entry points, and the dividing line
between them is whether the host's bundler can compile a `.vue` file:

| entry | for |
| --- | --- |
| `@cloflin/docpilot/mount` | any bundler with the Vue SFC plugin — Vite, Rollup, Nuxt, Astro |
| `@cloflin/docpilot/vue` | a Vue application |
| `@cloflin/docpilot/react` | React |
| `@cloflin/docpilot/docusaurus` | Docusaurus, plus `/docusaurus/client` |
| `@cloflin/docpilot/web` | a plain `<script>` tag, as `window.DocPilot` |

The last three resolve to a pre-built bundle with Vue and Shiki compiled in,
because a Docusaurus site has React and a blog has nothing. `/web.css` and
`/style/docusaurus.css` ship the stylesheets those hosts need.

**A pluggable highlighter API.** `@cloflin/docpilot/highlight` is the interface;
`/shiki`, `/prism` and `/hljs` are implementations, and each one's library is an
optional peer dependency, so a site that highlights with Prism never installs
Shiki. A host that already has a highlighter can pass its own.

**Living on the free tier.** OpenRouter's free tier meters **requests**, not
tokens — 50 a day under 10 lifetime credits — and a turn spends three or four of
them. The panel now keeps a ledger of what is left, reads the provider's
`x-ratelimit-*` headers, tells a reader how many questions remain instead of
reporting an outage that is not one, and treats the free ids as a pool: a 429 on
one chat model rotates to the next, while a daily exhaustion stops the rotation
because there is nothing left to rotate to. See `docs/guide/free-tier.md`.

**`embed: false`** — a third, declared option beside "use this embedder" and
"guess one". It says the site has no embedder and retrieval is BM25 over the
chunk text. The cost is printed rather than implied: measured once on a
1191-chunk corpus, recall@8 fell from 0.97 to 0.41 and retrieval F1 from 0.35 to
0.18. `npx docpilot eval --gate-only --lexical` reports the number for your
corpus.

**Conversation history.** A turn is no longer alone: the panel keeps the
reader's threads on their device — the archive in `localStorage`, shared across
tabs, and which thread a tab is showing in that tab's `sessionStorage`, so a new
tab starts a new conversation rather than adopting one mid-way through.

**Quoting.** Selecting text — in an answer, or in the host's own article — offers
to ask about exactly that passage, which is the gesture a confused reader
actually has and which previously led nowhere.

**A switch for every reader-visible action.** `quote.*`, `citations.*` and
`composer.*` join the `scope.*`, `history.*`, `prompt.*` and `feedback.*` blocks:
anything the panel offers a reader can be removed by the project that mounts it.

**Hand-written TypeScript declarations** for every entry point, under `types/`.
The `types` condition comes first in each subpath, because Node and TypeScript
resolve conditions in declaration order and one placed after `default` never
wins.

### Changed

- `vitepress` is now an **optional** peer, and its range widened to
  `^1.6.4 || ^2.0.0-alpha.16`. `vue` is optional too. A React, Docusaurus or
  `<script>`-tag consumer was being told it needed VitePress for a panel that
  reaches it as `dist/docpilot.web.mjs` with Vue already bundled in — and the
  narrow range failed the package's own peer contract against the alpha this
  repo develops against, which is where `npm install` produced ERESOLVE.
- `publishConfig.access` is `public`. A scoped package without it publishes
  restricted, and a free npm account is refused with `E402 Payment Required`
  after the tarball has already been uploaded.
- `prepublishOnly` runs `verify`, then `build`, then `scripts/check-publish.js`.
  The build is repeated there deliberately: npm's order is `prepublishOnly` →
  `prepack` → `prepare` → pack, so a check wired straight into `prepublishOnly`
  would grade the previous build.

### Fixed

- `bin/build-css.js` and `bin/build-web.js` no longer skip quietly during a
  release. Both catch a missing `sass`/`vite` so a contributor's install does not
  fail over a stylesheet they can rebuild — but `npm publish` and `npm pack` set
  `npm_command`, and under either of those the missing tool is rethrown. The skip
  had a green exit code, which meant a machine without devDependencies could
  publish a tarball with no `dist/` behind an exports map naming six files inside
  it.
- The comment in `bin/build-css.js` that said npm runs `prepare` for a consumer
  installing from the registry. It does not — `prepare` runs for local-directory
  and git installs and before `pack`/`publish`. A registry consumer unpacks
  `dist/` from the tarball and never reaches that code path.
