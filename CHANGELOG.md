# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
package follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Release headings are read by a machine as well as by you:
`scripts/check-publish.js` matches the first `## x.y.z` heading in this file
against `package.json`'s version and refuses the publish if they disagree.

## Unreleased

### Added

**`embed: { fallback: 'lexical' }` — a vectorless index preferred to no index.**
`npx docpilot index` dies when the embedder will not answer, and that stays the
default: an index quietly missing its vectors is a site whose retrieval got
materially worse with nothing said. Declaring the fallback says what to do
instead — build without vectors, which is the mode [`embed: false`](https://docpilot-nine.vercel.app/reference/config#embed-false)
already ships, reached by refusal rather than by declaration.

```js
embed: { fallback: 'lexical' }                          // 'auto', plus a fallback
embed: { provider: 'openrouter', fallback: 'lexical' }  // an explicit split, plus one
```

It rides on any arm of `embed`, including the automatic one and the pool a
chat-only provider borrows: the key says what to do, not which embedder, so it is
lifted out before the resolver picks an arm.

The build shouts what it cost, `readiness` reports it as a **note** rather than a
failure, and the browser follows the index rather than the config — a vectorless
index emits `lexicalOnly: true` to the client, so no request is spent embedding a
question there is nothing to score, and the panel's own *No embedding model —
search matches words only* line tells the reader why the answers changed.

**Read the numbers before setting it:** recall@8 0.97 → 0.41, retrieval F1
0.35 → 0.18, 11 of 44 answerable questions refused, and zero retrieval for a
question asked in a language the corpus is not written in. A regression that size
arriving because somebody else's free tier was busy has to be a decision.

**A second embedder as the fallback is deliberately not offered.** The index and
every query must land in one vector space, so a second embedder is a second index
— and its address would have to reach every reader's browser. A local Ollama
solves the build and breaks the site. `'lexical'` needs no address, because there
is nothing left to call.

## 0.3.1 — 2026-08-27

### Added

**`ui.trigger` is a list.** The navbar button, the row in the mobile navigation
menu and the floating button are no longer alternatives — a site can have any
combination of them, because the first two only exist inside a host's navigation
bar and the third only exists outside it:

```js
ui: { trigger: ['nav', 'fab'], panel: 'popup', fabLabel: 'Ask AI' }
ui: { trigger: 'both' }     // all three
ui: { trigger: 'none' }     // no button — ⌘I and your own control still open it
```

A bare word is shorthand for a list, and every value that resolved before still
resolves to what it always meant: `'nav'` is `['nav', 'screen']`, because a
navigation bar that collapses into a hamburger takes the button with it and a
placement with no mobile half disappears on a phone. Spell `['nav']` for the
desktop button on its own. `'both'`, `'all'` and `'none'` are newly accepted —
`types/config.d.ts` had promised `'both'` and `'none'` since the beginning and
the resolver had never accepted either.

`panel: 'auto'` now reads the list: the floating button decides it even in
company, so `['nav', 'fab']` opens the popup. The popup is anchored to the corner
the floating button sits in and the drawer is anchored to nothing, so the one
placement with a geometric opinion holds it. `panel: 'drawer'` overrules that, in
silence, as the crossed pairs always have.

`mountDocPilot({ trigger })` and `<DocPilotPanel trigger>` take a list too. That
option says which trigger instances are **mounted** — the host's decision, from
its own layout — while `config.ui.trigger` says which of them **render**; a
placement passes both or neither.

`npx docpilot init --trigger=nav,fab` takes a comma list, and its interactive
question now offers `nav`, `fab`, `both` and `none`. The block it prints writes a
word as a word and a list as an array literal.

### Fixed

**A popup with no floating button no longer reserves room for one.** `trigger:
['nav'], panel: 'popup'` used to leave the panel hovering 60px above the corner
inset — the space the floating button occupies — with nothing in it. New
`--dp-fab-clear` token, zeroed by a `:has()` rule when no floating button is on
the page; a browser without `:has()` keeps the reserved room, which is the miss
in the safe direction.

**`ui.trigger` cannot fail a build, whatever is in it.** `ui: { trigger: 'toString' }`
— or `'constructor'`, or `'__proto__'` — threw `TypeError: not iterable` out of the
resolver and took the docs build with it, because the table of trigger words is a
plain object and a lookup on it reaches `Object.prototype`. The word table is
guarded with `Object.hasOwn` now, and a member the message has to name is rendered
without `JSON.stringify`, which throws on a circular reference and on a BigInt. A
typo in a cosmetic setting is reported and dropped; it has never been allowed to
throw, and now it cannot.

**`types/config.d.ts` agrees with the resolver again.** `ui.prefetch` was typed
`'hover' | 'open' | 'never'`; the accepted values are `'hover' | 'idle' | false`.
`DocPilotThemeConfig.ui` is now `ResolvedUi | UiSettings` — the resolved shape it
actually carries, plus the settings shape, because a hand-written themeConfig is
a supported input and `session.configure` resolves whatever it is given.

### Changed

**The request count no longer says "free".** `error.budgetLeft` was
*{n} of {limit} free answers left today*; it is *{n} of {limit} answers left
today* now. The word is a claim about the provider, and the line renders on a
paid key with a declared `dailyLimit` as readily as on a free pool — widening the
gate without this would have traded a missing line for a lying one. `budgetLow`
beside it has always been tier-neutral. No new i18n key: the count is what a
reader acts on, and whose catalogue it comes off is not.

**Focus return walks the whole set of triggers.** With more than one placement on
the page, `document.querySelector('.docpilot-nav-trigger')` is no longer a unique
match, so the fallback used when the element that opened the panel is gone now
takes the first trigger that has a box rather than the first in the document.
Measured across 320–1400px on VitePress 1.6.4 and 2.0.0-alpha.19 there is no
configuration where this changes where focus lands — it is hardening, not a fix.

### Documentation

**Every setting is now in one table.** `docs/reference/config.md` gained a
`## Parameters` section under the existing `## All defaults` block: 67 rows of
`Name | Type | Default | Description`, each name linking down to the section that
says why the default is what it is. The block is what you paste; the table is
what you scan.

**Both views are checked against the code.** The table's Default column is
executed and compared to `DEFAULTS`, by the same test that already held the
block — a setting with no row, a row for a setting that does not exist, and a
default written down wrong all fail the suite.

**`budget.showRemaining` now shows the count it was rationing against.** The
muted line under the composer gated on `llm.freePool` alone, so
`budget: { dailyLimit: 500, showRemaining: true }` on a metered provider was
rationed against 500 for the whole day and never told the reader the number — the
one deployment being rationed was the one unable to see it. A daily allowance has
always had two arms, and every other reader of it knew: `session.js` seeds the
ledger's ceiling from `dailyLimit ?? (freePool ? FREE_TIER_DAILY : null)`, and
`trustworthy` opened with `declared || freePool`.

That test is now one exported function, `hasDailyAllowance` in `budget.js`, and
both call it — the line's own docblock claimed the two could not disagree, which
was the bug written down as a guarantee.

## 0.3.0 — 2026-08-26

### Breaking

**Three defaults moved.** None of them changes what an answer contains; all
three change what the panel puts on screen out of the box. A project that had
already written any of these keys is unaffected — an explicit value always wins.

- **`citations.passage` is now `false`.** The chevron that expanded a source row
  to the retrieved chunk is off by default. The source list itself is untouched:
  every answer still names what it cited and every row is still a link. Write
  `citations: { passage: true }` to keep the disclosure.
- **`budget.showRemaining` is now `false`.** The muted line under the composer —
  *38 of 50 free answers left today* — is off, because on a shared key a
  browser's own count is a lower bound on what other readers have already spent.
  `docs/guide/free-tier.md` has described the default this way since it was
  written; the code now agrees with it. Write `budget: { showRemaining: true }`
  on a key only you draw on. Nothing about the **rationing** changed — one-shot
  mode, the rotation threshold and the `429` message are all where they were.
- **The panel header reads `Docpilot`.** It was `DocPilot`. One i18n leaf,
  `panel.title`; override it with
  `i18n: { translations: { panel: { title: '…' } } }`. The trigger, its tooltip
  and the end-of-article link are unchanged.

### Added

**The muted line can say a site has no embedder.** With
`budget.showRemaining: true` on a deployment that declared
[`embed: false`](https://docpilot-nine.vercel.app/reference/config#embed-false),
the same line reads *No embedding model — search matches words only.* — beside
the request count where there is one. It is deliberately not the degraded-search
warning: that one belongs to an embedder that was configured and could not be
reached, and it appears on the refusal it explains. New i18n leaf
`error.noEmbedder`.

**Every default in one block.** `docs/reference/config.md` opens with an
`All defaults` section carrying the whole of `DEFAULTS`, copy-pasteable, plus the
four things the block cannot state on its own — `chat.extraBody`'s
provider-supplied default, the three unions, `chat.model` not surviving a change
of provider, and the five keys that never reach the browser. A test executes the
block and compares it to `DEFAULTS`, so a default cannot move without this page
moving with it.

**A `Where it can go` page**, second in the guide sidebar. It is the one place
that states the condition plainly, in both directions: what the panel needs from
a page, which is very little — `location.pathname`, `<html lang>`, a full page
load and `main` are all defaults it works out on its own, and only `host.search`
has none — and what it will not do, which is answer about the page it is sitting
on.

**`og:description` on the docs site.** VitePress emits
`<meta name="description">` from `description` but never an Open Graph one —
`isDescriptionOverridden` only looks at `name === "description"` — so every
shared link rendered a card with a title and no body.

### Changed

**The package is no longer described as being for documentation sites.** It
mounts on any page that can load a stylesheet and a script — a landing page, a
pricing page, a help centre, an app you already ship — and that is now what
`package.json#description`, the README, the site's title, its `h1` and its og
tags say. Nothing about the panel changed: the copy had been narrower than the
code ever since `/mount` and `/web` landed. The limit travels with the claim
everywhere it appears, in the same breath — the panel answers from the corpus
you built, not from the page it sits on.

**`keywords` reordered and retargeted.** npm clips the keyword list to a single
line in search results, so the first six now read `ask-ai`, `ai-search`,
`site-search`, `ai-chatbot`, `rag`, `answer-engine`. `vitepress` is demoted
rather than dropped — it stays in `description`, which npm weighs higher. Gone:
`search`, `ai` and `documentation`, unrankable head terms, and
`documentation-search`, a duplicate of `docs-search`.

**The site title is `DocPilot`, not `DocPilot for VitePress`.** The phrase moved
rather than went. `docs/install/{vitepress,docusaurus,vue,react}.md` each carry a
`titleTemplate`, so those four pages render `DocPilot for VitePress` and its
siblings as their whole `<title>` — one page whose title is the query, instead of
thirty-three sharing a suffix.

### Fixed

**`docs/guide/free-tier.md` printed `showRemaining: 'auto'`**, which is not a
value that key accepts — it is a boolean, and `'auto'` was reported on stdout and
replaced at build time by anyone who copied the example.

**The npm description was being truncated mid-word.** The registry caps
`description` at 255 characters — silently, and documented nowhere — and 0.2.0's
was 286, so the registry has served `…every citation is checked against wh` since
the day it shipped. A published version cannot be corrected, only superseded. The
new description is 233 characters, and its first sentence closes at 111 so the
whole claim survives Google's ~120-character mobile snippet.

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
