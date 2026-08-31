# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
package follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Release headings are read by a machine as well as by you:
`scripts/check-publish.js` matches the first `## x.y.z` heading in this file
against `package.json`'s version and refuses the publish if they disagree.

## 1.0.0 — 2026-08-31

### Breaking

**The five shipped Vue components are now `<script setup lang="ts">`, and your
build transpiles them — ours does not.** This is the one most likely to stop an
upgrade, so it goes first. `bin/build-js.js` copies the components into `dist/`
verbatim rather than compiling them, because `.vue` is not TypeScript and `tsc`
does not see it; the annotations therefore survive into the file your bundler
reads. Every consumer of `@cloflin/docpilot/theme`, `/theme-without-styles`,
`/mount` and `/vue` pulls them in.

A Vite host is unaffected — `@vitejs/plugin-vue` hands a `lang="ts"` block to
esbuild, which covers VitePress and Nuxt, and Vue CLI 5 does the same. A webpack
build whose `vue-loader` rule handles JavaScript script blocks only now fails to
parse: add `ts-loader`, or `babel-loader` with `@babel/preset-typescript`, to
that rule. `DocPilotTrigger.vue` uses
`withDefaults(defineProps<{ variant?: string }>(), { variant: 'nav' })`, a
type-only macro a JavaScript-only compiler cannot handle at all. The script-tag
install is untouched: `dist/docpilot.web.js` is prebuilt and carries none of
this.

**Every code entry point resolves into `dist/` now, and `src/` holds
TypeScript.**

```jsonc
// before                              // after
".":       "./src/index.js",           ".":       "./dist/index.js",
"./theme": "./src/theme/index.js",     "./theme": "./dist/theme/index.js",
"./vue":   "./src/adapters/vue.js",    "./vue":   "./dist/adapters/vue.js",
```

Sixteen of the twenty-three `exports` subpaths moved like that. Six already
resolved into `dist/` — the five CSS entries and `./web` — so twenty-two of the
twenty-three now do, every one except `./package.json`. `sideEffects` moved with
them. No subpath was added, removed or renamed, and the `types` conditions are
unchanged: they still name the hand-written `types/*.d.ts`.

Be clear about who this reaches. `@cloflin/docpilot/src/…` was never a supported
path — 0.5.0's `exports` map had no `./src/*` subpath, no `"./*"` fallback and no
`main` field, so Node ESM and every exports-honouring bundler already refused it
with `ERR_PACKAGE_PATH_NOT_EXPORTED`. What breaks is tooling that goes around
`exports` by filesystem path: a bundler alias, a Vite `resolve.alias`, a Jest
`moduleNameMapper`, a Storybook glob, a patch-package patch. Rewrite those to
name `dist/`. `files` is unchanged and still ships `src/`, but that directory now
holds 88 `.ts`, 5 `.vue` and 5 `.scss` files and no `.js` at all; globs targeting
`src/**/*.vue` or `src/**/*.scss` are fine.

**The package no longer works without a built `dist/`, and the build step fails
open.**

```json
"prepare": "npm run build",
"build":   "node bin/build-css.js && node bin/build-js.js && node bin/build-web.js"
```

`prepare` was the CSS and web builds; it is the whole build now, and the new
`bin/build-js.js` is what writes `dist/`. A registry install is fine — the
tarball carries `dist/`. A git dependency, a `file:` dependency, a workspace link
or a vendored checkout runs `prepare` instead, and `bin/build-js.js` resolves
`tsc` through `createRequire`: when TypeScript is missing it prints a skip notice
and exits 0 unless `npm_command` is `publish` or `pack`. That install produces a
package whose every subpath points into a directory nothing wrote. Make sure
`typescript` is installed before `prepare` runs — do not combine those install
shapes with `--omit=dev`.

In a repo checkout, run `npm run build:js` before `node bin/docpilot.js`. Every
dynamic import and all six `ENTRY` paths in the launcher moved from `../src/` to
`../dist/`, which is why `docs:index` gained that prefix. `docpilot`,
`docpilot --help` and an unknown command still exit before the first import and
need no build.

**The corpus moves, so `index → calibrate → eval` is owed on upgrade.** Four
changes, none of which a committed `calibration.json` can survive by assumption:

- **`.mdx` files enter the walk.** It matched `.md` only, which is why the
  shipped Docusaurus adapter mounted a panel over a corpus holding none of that
  site's pages; it is `/\.mdx?$/` now, and `routeOf` and `externalIdFor` strip
  `.mdx` so an MDX page routes to `/guide/install`. Run
  `find <docsDir> -name '*.mdx'` before upgrading: a `guide.md` beside a
  `guide.mdx` produces two pages at `/guide` and the build dies on
  `duplicate chunk id`, and any `.mdx` your generator ignores — a `_partials/`
  include, a draft — now enters as a page. `routeOf` is also a public export
  from `/mount`, `/vue`, `/host` and `/web`, and it strips `.html` and `.htm`
  too; exactly one extension goes, so `a.htm.md` still becomes `/a.htm`.
- **A new `stripMdx` pass runs first inside `normaliseMarkdown`, ahead of
  `applyLlmTags`, over every page rather than only over `.mdx`.** Unindented
  top-level `import`/`export` module statements are deleted to bracket balance,
  along with whole-line `{/* … */}` comments; fenced blocks are untouched, and
  the start regex is anchored so a four-space-indented sample survives too. Two
  guards keep prose that merely begins with the word *import* or *export*. On
  this repository the pass changes exactly one file and zero chunks; the exposure
  elsewhere is a `.md` page carrying a bare module statement outside a fence,
  which in VitePress lives inside a `<script setup>` block `stripVue` already
  removed.
- **The lexical scanner changed the order of case-folding and splitting.**
  `surfaceTokens` was `norm(s)` — NFKC, strip format characters, lowercase —
  followed by the split; it is now a case-preserving `rawTokens(s)` with
  `.toLowerCase()` applied per token. For characters whose lowercase form
  introduces a combining mark the tokens differ: `İstanbul` gave
  `["i", "stanbul"]` and now gives one token, `i` followed by U+0307. Latin, CJK,
  Cyrillic and identifier-shaped input are byte-identical. Nothing hashes the
  scanner, so no guard fires and an unreindexed site keeps loading — it just
  retrieves slightly differently on those terms. Re-index.
- **OpenAPI discovery matches `/\.ya?ml$/i` where it matched `/\.ya?ml$/`, and
  two specs sharing a basename stop the build.** A spec claims
  `/reference/<basename>`, and while every spec came from one directory listing
  that was nearly safe — but the filesystem only ever enforced unique filenames,
  not unique basenames. `api.yaml` beside `api.yml` in the default
  `${docsDir}/public/openapi` collided silently in 0.5.0, second wins; it now
  dies naming both files, with `openapi` left at its default. An uppercase
  `API.YAML` that was skipped before is now indexed, and can collide the same
  way. Rename one; which should win is not a decision this package can make.

**Three settings default to on, and two of them persist where 0.5.x persisted
nothing.**

```js
// all three ship as `true`; write any of these to keep exactly what 0.5.x did
composer: { draft: false }              // no sessionStorage draft, as before
history:  { saveOnUnload: false }       // an unfinished turn is dropped, as before
ui:       { waitingEscalation: false }  // one motionless status word, as before
```

The features are described under **Added**. What matters here is that an existing
config takes all three without editing. `composer.draft` adds a `sessionStorage`
key, `docpilot:draft`, that nothing wrote before — the text is passed through
`redactSecrets()` first, and a mount with either switch off actively removes the
key rather than merely declining to write it. `history.saveOnUnload` writes the
same `docpilot:history` archive 0.5.0 already wrote after every settled turn, so
it adds a new write *moment* rather than new storage. Both are additionally gated
on `history.enabled`, so a site that had already turned history off gets neither.
If your site makes a statement about what the panel keeps, read it again.

`ui.waitingEscalation` adds two i18n keys, `status.stillWorking` and
`status.takingAWhile` — the reader-facing string count went 171 to 173 and the
`status` group from 7 keys to 9. Translation tables merge over the English
defaults, so nothing breaks, but a localised deployment that believed it had
complete coverage renders two English strings at the 8 s and 25 s marks until it
adds them.

**Five declared types were corrected against what the code has been doing, and a
JavaScript consumer sees none of it.** The conformance gate under **Added** found
seven drifted places; these are the five that reject source a 0.5.x TypeScript
project could have written. Every runtime shape is unchanged.

- **`scope.filter` is `'auto' | boolean`**, where it was
  `'auto' | 'always' | 'never'`. `SCOPE_FILTERS` has been `['auto', true, false]`
  for two releases and `pick()` logged an error and fell back to `'auto'` for
  either string, so a config that wrote `filter: 'always'` was already being
  ignored at runtime and now also fails `tsc`. Write `true` for *always* and
  `false` for *never*. `docs/reference/config.md` dropped its standing caveat
  about the mismatch in the same commit.
- **`DocPilotThemeConfig.vocabulary` is gone.** It was declared on the client
  half for exactly one release and `themeDocPilot` never emitted it:
  `vocabulary` is `SERVER_ONLY`, folded into the index at build time and read
  back off the manifest. `DocPilotThemeConfig` has no index signature, so an
  object literal still setting the key fails excess-property checking — which
  lands on code that *wrote* it more than on code that read it, a reader having
  always got `undefined` and probably noticed. Delete the line;
  `DocPilotSettings.vocabulary` and `VocabularySettings` are untouched, and that
  is where it always belonged.
- **`HOST_KEY` is `InjectionKey<() => HostBinding>`**, not a bare `symbol`. The
  contract was always a factory — `inject` runs inside setup and the value it
  yields is called there, which is what `mountDocPilot` and the Vue adapter both
  provide — but `symbol` let a consumer provide a plain binding and fail at
  runtime. Write `provide(HOST_KEY, () => binding)`. The runtime value is the
  same `Symbol.for('docpilot.host')`.
- **`resolveEmbed()` returns the new `ResolvedEmbed`, not `EmbedSettings`.**
  `EmbedSettings` is what an author writes, all fields optional; the resolved
  shape states its absent values as explicit `null` and carries `modelAuto` and
  the `lexicalOnly` discriminant every caller branches on. Under
  `strictNullChecks`, `const e: EmbedSettings = resolveEmbed(cfg)` now errors on
  `provider`; with strict off it errors on `fallback`. Type the slot as
  `ResolvedEmbed`, newly exported from `@cloflin/docpilot/config`.
- **`ResolvedUi` gained a required `waitingEscalation: boolean`, and both arms of
  `DocPilotResult['embed']` gained `modelAuto`.** Anywhere you build one of those
  objects by hand, add the field.

**`expand_section` changed the system prompt, so `promptHash` moved.** `TOOLS_DOC`
is an input to the hash. Eval reports and stored-turn `promptHash` values from
before this release are not comparable with ones after it.

### Added

**`docpilot index` can index a site that is already built — `--html-dir`.**

The indexer walked markdown, and the only route for HTML was
`docpilot import <url>`: one page per invocation, over the network, past a
`sources.allow` allowlist. That is the wrong shape for Hugo, Jekyll, MkDocs,
Astro or Next, which have a `dist/` and no markdown the panel can read.

```sh
npx docpilot index --html-dir=dist
npx docpilot index --html-dir=dist --html-select='main article' --sitemap=dist/sitemap.xml
```

`--html-dir` walks `.html` and `.htm` under a directory, skipping what a build
puts beside its pages — `assets`, `static`, `_next`, `_astro`, `node_modules`,
`.git` and any dot-directory — and routes each page through the same `routeOf`
markdown uses. `--html-select` is a CSS selector that overrides `pickMain` and,
when it matches nothing, warns and skips the page rather than falling back.
`--sitemap` reads a *local* `sitemap.xml` as a route filter; nothing is fetched.
`--html-base` resolves relative links found inside those pages. Both
`--flag value` and `--flag=value` spellings are accepted.

Markdown wins any route collision — an HTML page whose route a markdown page
already claims is skipped and counted as shadowed — so pointing this at the
`dist/` of the site you are already indexing does almost nothing. A page found
this way carries no `origin`, so it needs no `sources.allow` entry. It needs an
HTML parser: `npm i -D linkedom`, the same optional dependency `import` has
always asked for, now behind one `parseDocument()` with one install message
because there are two callers.

**Where the OpenAPI specs live is a setting — `docPilot.openapi`.**

```js
docPilot: {
  openapi: null,                                  // the shipped value
  openapi: ['api/', 'legacy/v1/orders.yaml', 'specs/*.yaml'],
}
```

A list of paths from the project root: a directory, a single file, or a `*` in
the file name — not in a directory name, which is reported. `null` keeps the
behaviour that predates the setting, `${docsDir}/public/openapi`, exactly. It is
server-only, so it joins the withheld-from-client list, which goes from five keys
to six. A path you wrote that does not exist stops the build; the default
directory is still allowed to be absent.

**`expand_section` — the model can ask for the section next to one it holds.**

`fetch_section` returns exactly one chunk and an answer routinely straddles a
chunker boundary, starting at the end of one section and finishing at the start
of the next. The retriever's automatic short-chunk expansion already existed but
ran only during ranking, only under `EXPAND_BELOW_TOKENS`, only forward, and was
invisible to the model. This is a fifth entry in `TOOLS`, declared straight after
`fetch_section`, so it reaches both the provider schema and the published
`TOOLS_DOC` automatically. It takes an `id` the model already has and a
`direction` of `next` or `prev`, defaulting to `next`; an id-only call means
*next*.

It is same-page by construction, always costs a step — a free one would be an
unbounded walk — and is capped at two per turn. The backward pointer is derived
at load into a `prevOf` map rather than written into the index, so no shipped
index goes stale and the corpus hash does not move. Scope is the choke point: an
out-of-scope id returns `out-of-scope` rather than confirming the section exists.

**Identifiers are searchable by their parts — `DOCPILOT_SPLIT_IDENTIFIERS=1`.**

`surfaceTokens` keeps `. _ / - # $` inside a token, so `docPilot.sources.allow`
was one term and a reader typing *sources allow* matched nothing; and
`getUserName` had been lowercased to `getusername` before anything could see the
camel boundary. The scanner is split into a case-preserving `rawTokens` and a
lowercasing `surfaceTokens`, and a new `identifierParts()` emits the lowercased
parts of any token carrying an internal separator or an internal capital, with
acronyms kept whole — `HTTPServer` gives `http`, `server` — and a part equal to
the whole token dropped. `terms()` appends them after the phrase pass, so nothing
is replaced and an exact query loses no weight.

It is a build-time environment flag rather than a config key, and **off by
default**, because the `calibrate`/`eval` measurement that would justify a
default change has not been taken. Turning it on is stamped into
`manifest.tokenizer`, reinstalled in the browser by `store.ts`, and folded into
`vocabularyHash()` — which returns `'<hash>+split'`, or `'none+split'` where it
used to return `null` — so the existing stale-calibration guard fires against a
calibration measured under the other tokeniser instead of being silently reused.

**A reload no longer throws away an answer that was still streaming —
`history.saveOnUnload`.**

`saveCurrent()` ran once per settled turn and once per vote, so reloading at
second three of an answer lost every token already paid for. `saveIfRunning()` is
bound to `pagehide` and to `visibilitychange` on `hidden` through a new
reference-counted `unload.ts`, modelled on `hotkey.js` because HMR unmounts
twice; `beforeunload` is deliberately avoided, since it disqualifies the page
from the back/forward cache. The restored turn arrives as `aborted` — rendered as
*Stopped.* with *Ask again* — because `slimTurn` already downgrades a
non-terminal state. **The stream is not resumed and cannot be**: what comes back
is what had already reached the browser, which is the half that was paid for.
Default `true`, additionally gated on `history.enabled`.

**The composer keeps a half-typed question across a reload — `composer.draft`.**

It was a plain `ref('')`, so a reflex reload emptied a question written against
the 1000-character ceiling. It debounces at 400 ms into `sessionStorage` under
`docpilot:draft` — paired with `docpilot:conversation` rather than the
localStorage archive, because a draft belongs to one tab — and is restored at
mount only into an empty composer, before `applyDeepLink` so `?dp-ask=` still
wins. `redactSecrets()` runs before the write, closing the one path that reached
storage ahead of the redaction machinery. Default `true`, additionally gated on
`history.enabled`.

**The status line escalates at 8 s and 25 s — `ui.waitingEscalation`.**

`statusLabel` was a pure function of the phase and `DEFAULT_STEP_TIMEOUT_MS` is
120000, so a provider that accepted the connection and then said nothing held the
reader in front of a motionless word for two minutes. A new pure module,
`status.ts`, exports `waitingKey({elapsedMs, quiet, escalate})` with
`STILL_WORKING_MS = 8000` and `TAKING_A_WHILE_MS = 25000`; the component reads
the existing one-second `tick` rather than adding a timer, and there is
deliberately no third step. The escalation runs only while the newest turn has
neither `answerText` nor `thought`, which makes the second step's sentence true
by construction rather than by observation. Default `true`.

**The hand-written `types/` are checked against the declarations `tsc` emits.**

Until now nothing compared the two descriptions of this package to each other.
`typings/conformance.d.ts` imports both sides of five surfaces — index, config,
host, mount, highlight — and asserts assignability rather than equality with a
`Satisfies<Generated, Promised>` helper, so the generated side may be narrower
but not a different shape. Seven places where they had drifted were found the day
it was written, including a `nodeEmbedTarget` declared twice with different
return types and the `scope.filter` union above. It lives in its own
`tsconfig.conformance.json` because it reads a gitignored `dist/`, and putting it
in `tsconfig.json` would make `npm run typecheck` fail on a fresh clone. Two new
scripts wire it up: `typecheck:dist`, and `verify`, which is now
`check → build:js → typecheck → conformance → test`.

**Fifteen config exports that were importable and undeclared now have
declarations**, so they no longer type-error on the way in: twelve functions —
`capsOf`, `resolveTuning`, `chatModels`, `embedModels`, `poolProviderOf`,
`noEmbed`, `noChat`, `proxyContract`, `indexDirOf`, `manifestPathOf`,
`assertGuard`, `assertVocabulary` — and three constants, `GUARD_MODES`,
`VERBOSITY_LEVELS` and `SLUG`. Seven of them are read by `bin/docpilot.js`
itself, in one destructured import of the compiled config.

**Three resolved-side types are named and exported: `ResolvedEmbed`,
`ResolvedChat`, `ResolvedDocPilot`.** The first is described under **Breaking**.
`ResolvedChat` omits `chain` from `ChatSettings` and re-adds it resolved,
alongside `providerAuto`, `modelAuto` and `searchOnly`. `ResolvedDocPilot` is
what `bin/docpilot.js` puts on the global and every CLI command reads; note that
only its `chat` half is swapped in — `embed` stays a union that still admits the
authored `EmbedConfig`, so it needs narrowing before you read `.provider` off it.

**The gate runs on every push and every pull request —
`.github/workflows/ci.yml`.** `publish.yml` triggers on a `v*` tag only, so
`prepublishOnly` was the single place the suite had ever run. One `verify` job on
Node 20 and 24 — the floor from `engines.node`, and what `publish.yml` releases
on — running `npm ci` (not `--ignore-scripts`: `prepare` is what writes `dist/`,
and `verify` resolves the package through `exports` into it), then
`npm run verify`, then `npm run build` and `node scripts/check-publish.js` for
the size floors and the export-map walk that stand between a green suite and a
tarball that fails on import.

**Five new test files** cover the ground the release added: `expand-section`,
`identifier-tokens`, `mdx-openapi`, `html-dir` and `ir`. Two are worth naming for
what they pin rather than what they cover — `identifier-tokens` asserts that
splitting is off by default and that `vocabularyHash()` carries the flag, so the
existing stale-calibration guard fires instead of a second guard nobody would
remember to add; and `expand-section` asserts the harness always charges for an
expansion, honours the cap of two, and makes what it emitted citable.

### Changed

**`tsconfig.json` only checks and `tsconfig.build.json` only emits.**

That split is what made a file-by-file migration possible. The check config keeps
`noEmit` and `checkJs` and now includes `src/**/*.ts` plus the two declaration
trees, where it had named four `.js` files by hand. The build config extends it,
flips `noEmit` and `checkJs` the other way, and adds `declaration`, `sourceMap`,
`noEmitOnError`, `rootDir` and `outDir`. It takes `src/**/*.ts` **and**
`src/**/*.js`, so `dist/` was complete at every commit of the migration, while
the check config saw only what had been written to be checked — `checkJs` off
there and on here, which is the whole trick. `strict` and `noImplicitAny` are
unchanged from 0.5.0; both are still off.

Three compiler options were added as shipping constraints rather than as style.
`verbatimModuleSyntax`, because a type-only import inside a `.vue` block is
erased by `tsc` but survives a consumer's per-file esbuild transform and lands as
a runtime *does not provide an export named* error — requiring `import type`
makes that unshippable. `erasableSyntaxOnly`, which bans `enum`, `namespace` and
parameter properties so that an emitted file is its source minus the annotations
and nothing else, which is what let each conversion commit be reviewed as a diff
of `dist/`. And `allowArbitraryExtensions`, so the five new `*.d.vue.ts` siblings
can act as declarations for the `.vue` files beside them — `moduleResolution:
NodeNext` resolves a relative `./DocPilot.vue` on disk and never consults the
`declare module '*.vue'` wildcard, which answers for bare specifiers only.

**Every script that touches the package builds JavaScript first.** `build` gained
`bin/build-js.js`; `prepare` became `npm run build`; `verify` became
`check && build:js && typecheck && tsc -p tsconfig.conformance.json && test`;
`docs:index` gained a `build:js` prefix. `build:js` and `typecheck:dist` are new.
`prepublishOnly` is unchanged in text and now runs the JavaScript build twice.
Two build inputs were renamed for the TypeScript source and would fail outright
otherwise: `bin/build-web.js` builds `src/web.ts`, and
`scripts/check-docpilot.sh` reads `src/theme/docpilot/harness.ts`. Output
filenames are unchanged.

**The documentation caught up with the corpus and the panel.**

- `docs/guide/indexing.md` says the corpus is `.md` and `.mdx` alike plus your
  OpenAPI specs, explains that MDX module syntax is stripped before chunking
  while component text is kept, and adds a section telling Hugo, Jekyll, MkDocs
  and Astro users to build and run `npx docpilot index --html-dir=dist`.
- `docs/guide/history.md` no longer says only that reloading brings the
  conversation back. It says the restored conversation includes an answer still
  being written, returning as a stopped turn with *Ask again*, and that the
  request is not resumed — only what already reached the browser. The storage
  table gains `docpilot:draft` under `sessionStorage`.
- `docs/reference/config.md` gains `composer.draft`, `history.saveOnUnload`,
  `ui.waitingEscalation` and `openapi`, each with its own why-the-default
  section, in the pasteable `DEFAULTS` block, the scan table and the prose.
- `docs/reference/cli.md` documents `--html-dir` and its companions, and
  `DOCPILOT_SPLIT_IDENTIFIERS`.
- `docs/concepts/a-turn.md` lists `expand_section` among the tools a turn can
  call, framed as a failure shape rather than a capability.
- `docs/install/typescript.md` explains that `exports` resolves into `dist/`, and
  why `types/` stays hand-written even though `tsc` now emits declarations: a
  generated declaration pins the whole internal shape and makes a rename a
  breaking change.
- `skills/docs-rag/SKILL.md` restates the pipeline sentence for `{md,mdx}` plus
  `docPilot.openapi` plus a directory of already-built HTML, and adds
  `expand_section` to the tokens that may never appear in `DocPilot.vue`, holding
  the new tool name to the same layering rule as the others.

**The measured figures moved with the corpus**: 460 chunks to 471, 920 KB to
942 KB, 942,080 bytes to 964,608, and 171 reader-facing strings to 173. They are
hand-maintained in the README, the comparison and panel guides, the i18n key
table and three VitePress theme components, and all of them moved together. The
`status` group in `docs/guide/i18n.md` goes from 7 keys to 9, which is the
i18n-facing record of `ui.waitingEscalation`.

### Fixed

**Enter no longer sends the question while an IME is composing.** The keydown
handler was `e.key === 'Enter' && !e.shiftKey`. In Japanese, Chinese and Korean
input Enter also commits a candidate, several times a sentence, so every commit
sent a half-typed question and spent a request against an allowance the whole
site shares. `if (e.isComposing || e.nativeEvent?.isComposing) return` is now
first in the handler, which puts `ArrowUp` — edit-last-question — under the same
guard. This is a defect rather than a preference, so it gets no config key and
there is nothing to turn off.

**`scripts/check-publish.js` expands wildcard `exports` subpaths instead of
skipping them.** The loop stat-ed every target beginning `./dist/` as a literal
path and skipped the rest, so `./theme/components/*.vue` was never checked while
it lived under `src/` — and could not have been, being a pattern. A target
containing `*` is now split, read from the directory and checked file by file,
failing with *matches no file — exports[…] resolves to nothing*. An empty
`dist/theme/components/` is precisely the shape of failure that script exists to
stop: every subpath still resolves, `npm publish` is green, and the theme imports
five components that are not there. Everything else in it is unchanged — the
500-byte CSS floor, the 100,000-byte web-bundle floor, the explicit
`dist/docpilot.web.js` check for the script-tag install, the non-empty
`dist/web/` chunk check, the `publishConfig.access` assertion and the
CHANGELOG-against-version match.

## 0.5.0 — 2026-08-29

### Added

**The panel can be pinned to a scheme — `ui.theme`.**

Which scheme the panel wore was never a setting. With no adapter loaded the core
reads `prefers-color-scheme`, which is the only signal an embed has; with one, the
adapter maps every colour token to the host's own and the panel follows the site's
toggle. Both are right for the case they were written for, and neither could be
told it was wrong — a marketing page that is dark by construction handed a
light-OS reader a white panel, and a product that wanted its assistant to read as
one thing everywhere had to override nine tokens in a stylesheet loaded after the
adapter, which means knowing that the adapter wins by load order rather than by
specificity.

```js
ui: { theme: 'auto' }    // the shipped value — the page decides, as before
ui: { theme: 'light' }   // always light, whatever the site and the OS say
ui: { theme: 'dark' }    // always dark, on the same terms
```

`'system'` is accepted as a spelling of `'auto'`. **The default changes nothing:**
`'auto'` is exactly the behaviour that shipped, under both mechanisms.

A pin is a class on `<html>`, and the core re-declares the nine tokens that differ
between its own light and dark sets on `html.docpilot-light` / `html.docpilot-dark`
— one class deeper than the `:root` an adapter maps on, which is how it wins over
a stylesheet that beats the core by loading second. It also sets `color-scheme` on
the panel and the trigger, so the caret, the scrollbar and any native control
follow; never on `<html>`, because the page's own scrollbars belong to the page.
Shiki gets the same pair as a rule in all three stylesheets, since its colours are
per-token inline properties that no token can reach.

**A pinned panel wears DocPilot's own palette, not your site's**, and it cannot be
otherwise: `--vp-c-bg` only holds a dark value while VitePress is in dark mode.
`--dp-accent-soft`, `--dp-shadow` and `--dp-scrim` are deliberately left to the
host even under a pin — one value serves both schemes, so they stay your brand
tint, your elevation and your backdrop. ui-specs/011 carries the research.

**There is no toggle inside the panel.** A reader who wants it to follow them
already has one — the site's own theme switch, under `'auto'`.

## 0.4.0 — 2026-08-28

### Breaking

**One default moved, and one more joins it below.** Neither changes what an
answer contains.

**`guard.mode` ships as `'dense-only'` instead of `'calibrated'`.** On a site
with an embedder the two are the same gate, request for request; on one without,
a failing verdict no longer ends the turn — it picks the copy above the rows and
the model decides. `guard: {mode: 'calibrated'}` keeps the old behaviour, and the
reasoning is under **Added** below.

**`ui.trigger` moves too**, and that one changes where the panel is opened from
out of the box. A project that had already written it is unaffected — an explicit
value always wins.

- **`ui.trigger` is now `'fab'`.** It was `'nav'`. The panel opens from the
  floating button and answers in the popup rather than from the button beside
  search. Write `ui: { trigger: 'nav' }` to keep the navbar placement and its
  mobile row, or `'auto'` to get the drawer back with it. Note that an explicit
  `ui` object that never named `trigger` takes the new default like an omitted
  one does. The reasoning, and the rest of the trigger vocabulary, are under
  **Changed** below.

### Added

**A turn outlives the panel it was asked in — `ui.background`.**

Closing the panel called `stop()`, `stop()` aborted the controller, and an abort
with nothing painted yet has no terminal state of its own: it fell into
`'no-answer'` with `cause: 'not-answerable'`, which renders as *I couldn't find
this in the docs.* A reader who put the panel away during retrieval — which is
most of a turn's latency, before the first token — was handed the gate's refusal
for a turn the gate had never run.

One `abort()` was serving two intentions. **Stop** is the composer's button and
the `Escape` rung above it, and it still reaches the abort at every value of this
setting. **Close** is the `×`, the scrim, the floating button and the hotkey, and
none of those ever asked for anything to end.

```js
ui: { background: 'notify' }   // the shipped value — a dot on the trigger
ui: { background: 'open' }     // the panel returns by itself, answer in place
ui: { background: false }      // the turn is abandoned on close, as before
```

The turn survives moving to another page of the site, because the store always
has. When it settles behind a closed panel the trigger takes a 10px dot in a new
`--dp-alert`, which bounces three times and then rests; `prefers-reduced-motion`
keeps the dot and drops the bounce. Opening the panel clears it.

**The default changes a shipped behaviour, and the reason it may is that what it
replaces was a falsehood rather than a preference** — there is no value of this
setting under which that sentence was right. ui-specs/010 carries the research.

**The polite live region moved out of the panel's `v-if`.** It was destroyed with
the panel, so `announce.answerReady` had nowhere to land once a turn could settle
behind a closed one. Being resident also removes a race the open path always had:
a live region inserted in the same frame as its text is one several screen readers
never announce.

**The vocabulary — the documentation's own name for what readers call something
else.**

A plugin that is also an assistant, a chat and a widget has four names before
anybody translates one, and the lexical channel knows only the one the docs
happened to use. A reader who types *виджет* against a corpus that says
*DocPilot* shares no token with it, so lexical coverage `L` is 0 — and where
there is no dense channel that is the whole score, so the gate refused a question
about the product before any model was asked. `session.js` has carried the
sentence for it in a comment for two releases: *the panel answers "I couldn't
find this in the docs", which is false. It did not look.*

```js
vocabulary: {
  DocPilot: ['widget', 'виджет', 'ассистент', 'чат'],
  'chat.chain': ['fallback', 'фоллбек'],
}
```

`npx docpilot vocabulary` writes the first draft: it reads every title and
heading in the corpus, asks the configured model which words readers are likely
to use for them — in the languages your site is asked in — and writes
`${evalDir}/vocabulary.json`. It **proposes and never decides**, the file is
committed and edited like the golden set, and a re-run merges rather than
replacing. The config key overrides it per term.

**It rewrites, and it never adds.** What the gate scores is the question with the
reader's word replaced by the documentation's, exactly as if they had typed the
second one — nothing removed either, which is what keeps `gate.js`'s sign
intact: an off-topic question padded with product nouns still carries every
off-domain term it came with, so `L` cannot saturate on a rewrite.

It lives in `terms()`, the single tokenizer for `df.json`, MiniSearch's query
side and the gate's `L` — so index and query are rewritten by the same code by
construction, and a rewrite can only ever add matches. Two passes: declared
phrases over the surface stream, longest match first, so `ии чат` is recognised
whole; then single names again after stemming, so `виджеты` and `виджета` reach
what `виджет` reached. Identifiers are untouched unless the map names them, on
the same rule `stemLite` already keeps.

On a turn with no dense channel the pairs are sent in the system block, so the
model's own `search_docs` calls query the documentation's word. On a hybrid turn
they are not — the embedder already bridges the two and the tokens are the
excerpts'. `LEXICAL_DOC`'s old advice to try *a different concrete term, not a
synonym* was right while a synonym was a word the index had never heard of; a
declared pair is in the index on both sides, so the rule is now about which word
rather than about avoiding the move.

**And it is detectable when it goes stale**, which the stemmer was not. Every
lexical score moves when the map does, and the index hash is sha256 over chunk
TEXT — the CHANGELOG below says in as many words that *nothing in the build can
detect that it is due*. The manifest carries a `vocabHash` beside the index hash
now, `calibrate` writes it into `calibration.json`, and `index` reports a stale
guard when the two disagree. A calibration from before the field existed and a
build with no vocabulary compare equal, so no existing deployment is told to
recalibrate for nothing.

**`guard.mode: 'dense-only'` — the gate scores every turn and ends only the ones
it can judge.**

The verdict is always computed and always recorded; this decides whether a
failing one refuses before the model is called. With no embedder `G = L`, and
`L` is token overlap between the question and the corpus: it is 0 for a reader
asking in another language, and 0 for one calling the product by a name the docs
do not use. A refusal built on that says the corpus has nothing when the truth is
that the channel cannot tell. The vocabulary closes the second of those; nothing
closes the first, because the words a map does not carry are exactly the ones
nobody thought to declare.

So on a vectorless turn the verdict picks the copy and the **model** decides
whether the question is answerable — the judgement it can actually make, holding
a refusal contract of its own that withdraws an uncited answer before the reader
sees it. On a site with an embedder nothing changes at all. What it costs where
it does change is a model turn on a question the corpus has nothing for, which on
a shared free tier is one of fifty a day for the whole site; `readiness` says so,
and `'calibrated'` is the value for a deployment that would rather not.

**`chat.chain` reaches two of one service, at two addresses, with two keys.**

A member is identified by a **name** now, and it defaults to the provider id — so
every chain written before this resolves to the paths it always did, and two
entries of one service become sayable the moment you name them:

```js
chat: {
  chain: [
    { name: 'gw-eu', provider: 'custom', baseURL: 'https://eu.gw.internal', apiKeyEnv: 'GW_EU_KEY', model: 'qwen3-8b' },
    { name: 'gw-us', provider: 'custom', baseURL: 'https://us.gw.internal', apiKeyEnv: 'GW_US_KEY', model: 'qwen3-8b' },
    'openrouter',
  ],
}
```

Three silences closed at once. The second `{provider: 'custom'}` used to be
deduped away without a word; a repeat is now refused by name. `baseURL` on a
self-hosted member was read by nobody — the emitted client base is the proxy path
and the proxy's upstream came from the table and one env var — while the
reference claimed *a value written here outranks all of them*; it does now, for
`ollama`, `llamacpp` and `custom`, and stops the build beside a branded provider,
which has an address of its own. And `apiKeyEnv` names the variable holding a
member's key, never the value: a key in a config file is a key in the browser
bundle, which is what `THEME_ONLY` has always forbidden.

The name keys the proxy route, the credential, and the cooldown the transport
learns — so a blip on one gateway no longer demotes the other, which under a
shared `provider|baseURL` key it did.

**`chat.preferLocal` — a server of your own answers first.**

The opt-in half of the decision 0.3.2 made. `custom`, `llamacpp` and `ollama`
sort to the front of the ladder rather than the back, and an environment that
selects nothing falls through to a local Ollama instead of to OpenRouter's free
tier.

It **reorders and never selects**: a local server is still reached by its
address, because from inside a build a laptop running one and a CI box that has
never heard of one are the same environment — the argument that took the old
default away. That argument is about guessing, and says nothing about an author
who writes it down. `readiness` reports the key when it moved nothing, because a
setting that silently does what it would have done anyway is the failure this
whole area exists to refuse.

### Fixed

**Corpus text is rendered, not printed.** Two surfaces showed a reader the
markdown *source* of a chunk while the answer above them showed rendered prose:
the passage behind a citation (`citations.passage`) and the result rows in
search-only mode. Both read `## Heading`, `**bold**` and `](/guide/config)` as
literal characters.

- **The passage runs through the same renderer the answer does** — lists, code
  cards with syntax colour, tables, emphasis, and links filtered against the
  manifest exactly as an answer's are. Two departures, both because the box is a
  240px quotation and not a page: no copy button on a fence, and the chunk's own
  headings demoted to a bold line. What is shown is unchanged — the whole chunk,
  still uncut.
- **A search-only snippet is stripped to its text before the 220-character
  window is taken**, so the budget goes on words instead of on punctuation, a cut
  no longer lands inside a link, and the query highlight marks an emphasised word
  the same as a plain one.

**Four knobs that were documented and unenforced, and four sentences that were
documented and untrue.**

- **`chat.temperature` beside a provider that rejects it stops the build.**
  `docs/guide/providers.md` states the rule for that column outright — a `—`
  means naming the knob there stops the build rather than being dropped in
  silence — Anthropic's cell is `—`, its API rejects sampling parameters, and
  nothing refused it. The shipped 0.2 is exempt: it is indistinguishable from
  asking for nothing.
- **`chat.verbosity` and `guard.mode` are checked against their vocabularies**,
  and **`chat.models` against being an array of model ids.** All three reached
  the browser verbatim, so a typo was not a build failure — it was a field in the
  bundle. `guard.mode: 'lenient'` behaved as the strictest setting, which is the
  safe direction and still the wrong one.
- **The selector for `custom` is `CUSTOM_BASE_URL`**, and both provider tables
  said `CUSTOM_API_KEY`. The key authorises; the address is what puts it in the
  chain, because a host you run has no credential to be found by.
- **`LLAMACPP_API_KEY` is supported and was in no documentation at all** — the
  guide said *no config file entry, no key*.
- **`chat.maxTokens` reaches Ollama**, and the reference still said that adapter
  sends no token ceiling. It has since 0.3.2; `providers.md` was already right
  and `config.md` was stale.
- **`chat.extraBody` has a row in the parameters table.** It has no `DEFAULTS`
  entry — `undefined` and `null` mean different things to `extraBodyOf`, so
  neither can be shipped as the value — which also meant the table-completeness
  test could not see that it was missing.

**The answer ladder — a turn never ends empty-handed.**

`chat.chain` ships as `'auto'`: every provider the environment holds a key for is
walked, not just the first. The resolved set is sorted before it is walked —
billed accounts, then a provider's own free catalogue, then a server of your own,
with the chain table's order kept inside each tier. That table is ordered by what
one key covers, which is the right question for choosing one provider and the
wrong one for ordering a set: walking it verbatim spends a reader's question on a
50-a-day allowance shared by the whole site while a funded key sits two rows
below it. A model you named keeps its provider billed and flattens the tiers back
to the table's order, so `chat: {model: 'anthropic/claude-sonnet-4'}` beside an
OpenRouter key does not sink. An environment with one key still resolves to one
member and one route, unchanged to the byte.

Rotating across a service is wider than rotating inside a pool, and deliberately
so — every exclusion the pool makes is an argument about the same host and the
same account, and none of them survives a provider boundary. A `401`, a network
failure carrying no status, and the DAY's `429` all rotate to the next provider;
only the last member's daily `429` escapes, so `rate-limited` still settles with
the reset the service named. Abort and a step timeout rotate nowhere, and nothing
rotates once a delta has been painted — across services as well as within a pool.
A member that stepped aside goes to the back of the order for its cooldown, never
out of it, and there is no sticky sibling to that map: a sticky member would let
one blip promote a free tier above the billed account the deployment configured
first.

None of it is visible. A service stepping aside for the next one is the ladder
working rather than a fault to report, so there is no badge and no notice;
`?dpdebug=1` prints `turn.ladder = {provider, index, freePool}` and a feedback
record carries it. Priority is configured with the surfaces that already exist —
the `chat.chain` array for providers, a member object for a non-head member's
models, `chat.model` and `chat.models` for the head's — and no new knob was added.

**The last rung is the search-only product, reached at runtime.**

A turn where no service answered used to print *The AI service didn't respond*
over a finished retrieval: the question embedded, both channels searched, the
gate scored, every ranked passage sitting in memory, and not one of those needed
a model. It settles as `state: 'results'` with `turn.hybrid` now — the same rows
a [`chat: false`](https://docpilot-nine.vercel.app/reference/config#chat-false)
site serves, each a verbatim excerpt under a link to the heading it was cut from,
under one sentence that names the cause and gets out of the way: *The AI models
aren't reachable right now — this is a search answer. The closest passages:* —
with Retry and Search the docs beneath them.

A failure BEFORE retrieval has no rows to show and is still the transport error
it always was. A spent daily limit keeps `rate-limited` and its own copy, because
the service did answer and what it answered was a schedule, and it now lists the
passages too under a quieter *Meanwhile, the closest passages:*.

[The answer ladder](https://docpilot-nine.vercel.app/concepts/the-ladder) is the
page, and the two `hybrid` strings join the i18n keys.

**`chat: false` — search-only, and no model at all.**

The other half of `embed: false`. A question is scored against the index exactly
as before and answered with the ranked passages themselves: each an excerpt under
a link to the heading it was cut from. No model is called on any turn, so there is
no key to hold, no token to spend and no sentence that can be wrong. `'none'` is
the accepted alias, as it is for `embed`.

Everything ahead of the answer is unchanged — the scope picker, the credential
settle, the greeting reply, the calibrated gate. What the gate does is different
on purpose: it is an empty-state signal here rather than a suppressor. The
refusal contract exists because a model writing from weak evidence produces
something plausible and wrong; nothing is generated in this mode, so the rows are
shown either way and the verdict only chooses the sentence above them.

Paired with `embed: false` it is a deployment holding no provider credential and
making no outbound request of any kind after the page loads. `npx docpilot
doctor` prints `chat none — search-only`, asks for no chat route in `--proxy`,
and says out loud that `embed: 'auto'` still posts the corpus at build time —
switching the model off is not by itself a site that sends nothing anywhere.


**`ui.font` and `ui.fontMono`** — the face for a site the panel cannot inherit
one from: a `<body>` that names no font, a theme that sets one on its article
container alone, a design system that keeps it in a variable.

```js
ui: { font: 'Inter, system-ui, sans-serif' }   // the family list itself
ui: { font: '--brand-font' }                   // the variable you already have
ui: { font: 'var(--brand-font, Inter)' }       // the same, fallback and all
```

A bare `--name` is wrapped into `var(--name)` — that wrapper is the one part of
the value with no decision in it.

Both are written onto `<html>` as inline custom properties, which is **the only
layer that outranks a host adapter**: `vitepress.scss` maps `--dp-font` to the
site's own family on `:root`, so a rule of ours at the same specificity would
lose on the host where naming a face is most likely to be the point. Overriding
the token in CSS is unchanged and stays the right move when the value depends on
something only a stylesheet knows — a media query, a `[data-theme]`, a container.

A value that could end the declaration or open another — `;` `{` `}` `<` `>` `@`
`*` `\` or `url()` — is reported on stderr during the build and dropped, on the
same terms as every other cosmetic setting: a typo must not be able to fail a
docs build.

### Changed

**The panel ships on the floating button and the popup.** `ui.trigger` defaults
to `'fab'` instead of `'nav'`, and `ui.panel` — still `'auto'` — follows it to
`'popup'`.

The old default was a VitePress assumption wearing the clothes of a general one:
a navbar slot exists in that theme and nowhere else, so a custom theme, a React
page or any host rendering its own header got no button at all, with nothing on
stdout to explain it. `mountDocPilot` had already settled the same question its
own way and mounts `'fab'` by default; this is the settings half agreeing.

**A site that wants the navbar button back writes one key:**

```js
ui: { trigger: 'nav' }   // the button beside search, its mobile row, and the drawer
```

`'auto'` returns the drawer with it, so the shape does not have to be named
either. Everything else is unchanged: `'nav'` still means both navbar
placements, `['nav','fab']` still opens the popup, and every explicit
`ui.trigger` a site already wrote resolves to exactly what it resolved to
before. An explicit `ui` that never named `trigger` is not covered by that and
was never meant to be — `ui: { credit: false }` took the old default and takes
the new one, exactly as an omitted `ui` does.

The fallback for an unrecognised `ui.trigger` moves with the default — a typo
now leaves the floating button rather than the navbar one, and still says so on
stderr.

**Lexical retrieval, for the deployments that have nothing else.**

Five changes, all of which matter most where there is no dense channel to cover
for them:

- **A per-page cap replaces MMR when there is no query vector.** At the shipped
  `MMR_LAMBDA` of 1.0 the redundancy term is multiplied by zero, so the same-page
  indicator that was supposed to diversify a vectorless result set was dead code
  and one page could take every slot. `PAGE_CAP` (2) shapes the head of the set
  and backfills rather than returning a short one.
- **A scoped refusal now says WHICH refusal it is.** `wouldPassUnscoped` was
  computed from dense cosines, which a vectorless index does not have — so every
  scoped refusal read as *not in the docs* even when the answer sat one directory
  away, and the one-click widen could not render at all. It has a lexical arm now,
  against the same `tauLexical` and moving no primary score.
- **`kind` intersects at candidate generation** rather than over an
  already-truncated fused pool, and the scope predicate moved into the search
  itself.
- **`path` and `anchor` are searchable.** Two fields every chunk has carried since
  the first build and nothing ever indexed, so a half-remembered route reached a
  page only through its prose.
- **The model is told what search is.** On a lexical-only turn the system message
  gains one block: search matches words, not meaning — query with exact
  identifiers and the documentation's vocabulary, in the documentation's
  language. Without it the model's `search_docs` re-queries paraphrased
  semantically, which on BM25 alone re-scores the same words the same way, spends
  the step, and reads as "not in the docs". Sent only where it is true; published
  by the §14 prompt disclosure on lexical-only deployments; covered by the prompt
  hash either way.

`BM25_K`, `BM25_B`, `BM25_D`, `BOOST_TITLE`, `BOOST_BREADCRUMB`, `BOOST_PATH`,
`BOOST_ANCHOR` and `PAGE_CAP` join the sweepable levers at their shipped values,
so the one scoring function a lexical-only site has can finally be measured.
None of them is writable from a manifest: they can move `L`, and `L` is half of
`G`.

**Light suffix stripping, in the one tokenizer.**

`terms()` now strips inflectional endings — Russian and Ukrainian cases, English
plurals. `конфигурации` and `конфигурацию` were two unrelated tokens to BM25 and
one word to every reader who typed either; the only thing bridging them was
`fuzzy: 0.2`, which is an edit-distance accident rather than a rule.

Names are never touched: a token carrying a digit, `.`, `/`, `#`, `_`, `$` or `-`
is returned as it is, so `plugin.init`, `v2` and `/getting-started` survive whole.
`-ing` and `-ed` were built, measured and dropped — they collided `index` with
`indexing` and `bill` with `billing`, and did not unify `configure` with
`configured` anyway. Index and query are stripped by the same code, so this can
only add matches.

Measured on this corpus as a side effect: the vocabulary merges from 4,873 types
to 4,373, the terms lost to `df.json`'s 4,000-entry cap fall from 873 to 373, and
the kept entries cover 98.75% of postings rather than 97.16%.

**If you run lexical-only, re-index and re-calibrate.** Ranking feeds the gate's
evidence, and `tau` was calibrated against the old distribution — RAG-SPEC 5.6.
Nothing in the build can detect that it is due, because the index hash is over
chunk text and none of this touches it:

```
npx docpilot index && npx docpilot calibrate --refresh && npx docpilot index
```

**The panel says what it is.**

The footnote under the composer closes on one linked word — `DocPilot` — after
the scope button and the AI disclaimer it already carried:

```
All docs · AI-generated. Check the linked pages. · DocPilot
```

It is there from the first open rather than from the first answer, because the
moment a reader wonders what is about to answer them is the moment the thread is
still empty. `ui.credit: false` removes it; `i18n` key `credit.label` renames it
in place.

The separators in that row became conditional at the same time. With
`scope.enabled: false` and no turn yet, both earlier segments are absent, and the
row used to open with a hanging `· ` — rare enough to survive unnoticed while the
disclaimer was the only thing behind it.

**One vocabulary for reasoning, and a capability matrix behind it.**

`chat.reasoning` asks for thinking in one provider-neutral word — `'auto'`,
`false`, a level from `minimal` through `max`, or `{effort, budgetTokens,
visible}` — and DocPilot spells it the way the configured service does.
`chat.verbosity`, `chat.topP` and `chat.seed` join it.

The levels do not survive contact with reality unchanged, and that is the point:
no two services publish the same vocabulary. OpenAI and OpenRouter have six
words, xAI has four, DeepSeek has three and no `medium` at all. What you write is
ranked and the nearest word the configured provider actually accepts is sent,
ties going down; `npx docpilot doctor` prints the substitution.

A knob a provider is KNOWN to reject stops the build by name rather than being
dropped on the way out — `chat.verbosity` beside `anthropic` says so, and names
`chat.extraBody` as the way to say it anyway. Support that varies by MODEL is a
note instead, because a pool moves the model between requests and a static
verdict would be a lie half the time. `custom` names a host rather than a
service, so nothing there is refused at all.

`npx docpilot doctor` grew a `knobs` block printing, for the configured provider,
what each setting becomes on the wire — the one fact about a knob that was
available nowhere else. The full matrix is in the providers guide.

**`docpilot doctor --models` now answers for local servers.**

It compared the name in the table against a catalogue, which is right for a
hosted service, wrong for llama.cpp — whose `chatModel` is a placeholder the
server ignores — and unhelpful for Ollama, where the fix is `ollama pull` rather
than an edit. It reads llama-server's `/props` for the weights actually loaded,
Ollama's capability list for what the model can do, and prints the command that
helps. A local server that is switched off is reported and never fails a build.


**The shipped instructions were rewritten — shorter, and one rule wider.**

Every rule in the default system instruction was recast in fewer words: 1,488
characters where 0.3.3's were 2,096, with the `Rules:` header dropped and every
line tightened. One rule gained meaning rather than losing it — the confidence-0
rule now names what it always covered: *That includes other products and general
programming.*

Nothing a site wrote moves: `prompt.override` still replaces the block whole and
`prompt.extend` still appends to it. `promptHash` changes for every deployment,
hybrid ones included, so reports from 0.3.3 are not comparable with reports from
this release — `docpilot eval` says so rather than diffing them.

**The panel wears your font. It no longer ships one of its own.**

`--dp-font` was a system sans stack — `ui-sans-serif, system-ui, -apple-system,
…` — which made it the one token that *overwrote* something the host had already
decided. It is `inherit` now. The panel is mounted into `<body>`, so the stack
was the only thing standing between it and the page's own face; the navbar
trigger and the article call to action had been inheriting all along, and this
is the panel joining them rather than a new idea.

Nothing changes on VitePress or Docusaurus: both adapters already map the token
to the host framework's own family. What changes is the `<script>`-tag and
`mountDocPilot` install, where the panel now matches the site it is mounted on
instead of arriving in a face nobody chose.

`--dp-font-mono` stays a real stack. A page has no monospace for the panel to
borrow, and `inherit` there would set a code block in the body face.

**A nested rule may no longer ask for `--dp-font`.** `inherit` resolves against
the element that uses it, so `var(--dp-font)` inside a monospaced block returns
the monospace. One rule did exactly that — the heading between the prompt
disclosure's blocks — so the prompt panel now carries the face and marks its
monospaced *blocks* instead of the reverse. The two text buttons under those
blocks were monospaced by the same inheritance and are not any more.
`test/styles.test.js` pins the whole list of places that ask for the face.

**`docpilot.web.css` ships inside `@layer docpilot`.** Only that one build. The
four stylesheets `build-css.js` writes are loaded by a host this package has an
adapter for — VitePress, Docusaurus — and are unchanged; the web bundle is the
one that lands on a site nobody mapped, next to CSS nobody here has seen.

A layer settles the cascade question in that install without either side writing
`!important` (this package writes none, and the panel's own selectors are no
longer something a site has to out-specify):

```css
/* unlayered, one class — this wins over the panel now */
.docpilot__send { border-radius: 4px; }
```

A site whose own styles are layered decides the order by naming it first, rather
than by which `<link>` the browser reached first:

```css
@layer docpilot, site;
```

**It points the other way too, and that is the part to read before upgrading.**
An unlayered rule beats a layered one whatever its specificity, so a reset the
page already loads now outranks the panel. Two are known to bite: Tailwind v3's
preflight sets `border: 0 solid` on `*`, which erases every hairline the design
system is built on, and a bare `a`, `button` or `ul` rule repaints the answer
body. Both are answered by declaring the property back — which is the control
the layer exists to hand over.

The wrapper is a Vite plugin in `bin/build-web.js` and it carries the ordering
that makes it work — `vite:css-post` emits the stylesheet, so a plugin that runs
before it rewrites nothing and ships an unlayered file with no error. That
failure has no local symptom, so `test/packaging.test.js` asserts the built file
opens with the layer exactly once and that the other four carry no `@layer` at
all.

### Fixed

**`chat.maxTokens` reaches Ollama.** It was resolved, documented and threaded the
whole way down, and then dropped — the adapter's destructure never named it — so
every Ollama deployment ran on the server's own default ceiling whatever the site
configured, and an answer cut off there looked like a model failing rather than a
setting nobody was honouring. It is `options.num_predict` now.

**`chat.extraBody` reaches every adapter.** It was read by the OpenAI-shaped one
alone, so an Ollama or Anthropic site could write it, see it validated, see it
emitted into the page, and post a body without it. On Ollama its `options` merge
with the adapter's rather than replacing them, so `num_ctx` survives.

**OpenAI's reasoning models could not answer at all.** `max_tokens` is deprecated
on `/v1/chat/completions` and rejected outright by the o-series and the GPT-5
line, so `chat: {provider: 'openai', model: 'gpt-5-mini'}` failed every question
with a 400 that the panel rendered as "I couldn't find this in the docs".
`max_completion_tokens` is sent to the models that require it.

**Anthropic can think about its answer.** Thinking was suppressed on every final
call, because manual extended thinking cannot ride with a forced tool call and
the answer's shape is pinned with one. Adaptive thinking does support forced
tools, so on a current model the two now travel together. Models at Opus 4.5 and
earlier reject adaptive and keep the budgeted shape; the adapter picks from the
model name, because a package that posts one shape everywhere is wrong for half
the catalogue in opposite directions.

**`deepseek-chat` was retired by DeepSeek on 2026-07-24** and was still this
package's default for that provider. It is `deepseek-v4-flash`.

**An unterminated `<think>` no longer loses a good answer.** The strict-schema
path stripped paired tags only, so a reply whose reasoning was cut off mid-trace
came back as "could not read the response" — while the identical reply parsed on
the fallback transport. The repair runs only after a parse has already failed, so
an answer that merely mentions the tag is left alone.

**`assertChat` and `resolveChat` agree about a provider's default model.** An
unresolved config for a provider that has one was refused, while the same object
passed through `resolveDocPilot` first was accepted — a refusal about the caller
wearing a message about a missing model.

## 0.3.3 — 2026-08-27

### Removed

**`peerDependencies` is gone — all eleven of them.**

Every one was `optional: true`, which means npm never installed any of them. So
the block had exactly one mechanical effect: it **refused to install** when a
consumer already carried a version outside the range it happened to state. Three
of eleven ranges did that, or came within one release of it:

- `vitepress: '^1.6.4'` pinned a peer this repo's own devDependencies did not
  satisfy — ERESOLVE on any host running `npm install`. Fixed in 0.3.1.
- `@scalar/openapi-parser: '^0.22.0'` — a number nobody checked, against a
  package that was at 0.28. `^0.x` matches ONE minor, so 0.3.2 could not be
  installed at all beside a current `@scalar/api-reference`:

  ```
  npm error ERESOLVE could not resolve
  npm error   peerOptional @scalar/openapi-parser@"^0.22.0" from @cloflin/docpilot@0.3.2
  npm error   Found: @scalar/openapi-parser@0.28.16
  ```

- `linkedom: '^0.18.0'` was the same defect waiting on linkedom 0.19.

A block that installs nothing, warns nobody who is not already about to hit a
runtime error, and has broken a real install once is not carrying its weight. The
guidance it was meant to hold lives where people actually meet the requirement:
`docpilot import` and the OpenAPI chunker each name their install command in the
error they throw, and the highlighters are reached through an explicit subpath
documented in [Syntax highlighting](https://docpilot-nine.vercel.app/reference/highlighting).

**What this costs, stated plainly:** a consumer on a future major — Vue 4, React
20, Prism 2 — now meets a runtime error rather than an install-time warning.
What it buys is that this package can no longer make somebody else's
`npm install` fail. Two tests in `packaging.test.js` hold the line: one asserts
the block stays absent, one asserts that the two build-time modules still name
their install command in the error they throw.

**Nothing else changed.** 0.3.2's provider chain, embedder discovery and
`doctor --models` probe ship unaltered; this release exists because that peer
range made 0.3.2 uninstallable beside a current `@scalar/api-reference`.

## 0.3.2 — 2026-08-27

### Migration

**A project that named no provider no longer resolves to a local Ollama.** That
is the whole of the breaking change, and it has two halves.

`chat.provider` shipped as `'ollama'` and now ships as `'auto'`, so a key sitting
in the environment for something else — a CI secret, a sibling service — is now
consulted. And `ollama` is selected by `OLLAMA_BASE_URL` rather than by closing
the chain, so an environment with nothing in it falls through to OpenRouter's
free tier instead of to `localhost:11434`.

If you were running a local Ollama without saying so in your config, say so:

```js
chat: { provider: 'ollama' }        // pin it; the chain is not consulted
```

or say it in the environment, which also lets you move it:

```bash
OLLAMA_BASE_URL=http://localhost:11434
```

Everything else is unaffected: a config that named its provider resolves exactly
as it did, and the build log stays silent about the chain there. Whenever the
environment *did* choose, it says so out loud:

```
[docpilot] chain  auto → openai
[docpilot]        openai ✓ · gemini — · mistral — · … · ollama —
```

`npx docpilot doctor` prints the same list on demand, with the member that
answered marked, and works without a config file at all.

### Added

**The provider chain — `chat.provider: 'auto'`, and the end of "installed, keyed,
and still talking to localhost".**

`chat.provider` shipped as `'ollama'`, and the environment could only ever
*confirm* a choice you had already made: the resolver went from a named provider
to the name of that provider's key, never the other way. So a project that
installed this package, put `OPENAI_API_KEY` in `.env.local` and wrote nothing
else resolved to a local Ollama and spent every question on a connection refused.
The key was read, found, and ignored.

`'auto'` — the new default, and what an omitted `chat` block now means — walks an
ordered list and takes the first service the environment holds a key for:

```js
const ai = defineDocPilot({}, loadEnv('', process.cwd(), ''))
```
```bash
OPENAI_API_KEY=sk-…      # the whole configuration
```

**Providers that embed come first**, and that is the ordering argument rather
than a ranking of answer quality — `openai`, `gemini`, `mistral`, `together`,
`fireworks`, `nebius`, `openrouter`, then the answering-only `anthropic`, `groq`,
`deepseek`, `xai`, `cerebras`, then the self-hosted `custom`, `llamacpp` and
`ollama`. One key covering both halves is the difference between a working
install and a second decision: a chat-only provider sends `embed: 'auto'` to
OpenRouter's free pool, which needs a second key and posts the whole corpus to a
third party at build time. Fine to choose, poor to be defaulted into.

**The self-hosted tail is selected by ADDRESS.** A local server has no credential
to be found by, so `OLLAMA_BASE_URL` and `LLAMACPP_BASE_URL` do both jobs: setting
one selects that provider, and its value is where requests go.
`OLLAMA_BASE_URL=http://localhost:11434` says *the usual one*.

**An environment that selects nothing falls through to OpenRouter's free tier.**
The local Ollama used to hold that place, because it closed the list and needed
nothing to be selected by, so every unconfigured build landed there — right for a
laptop running one, a connection refused everywhere else, and indistinguishable
from inside a build that makes no network calls. OpenRouter's remaining setup is
a single free key, with no model to choose on either half and no card, so the
build now prints one instruction instead of producing a silent outage.

Nothing here touches the network. A config file is read synchronously at build
time, so a resolver that reached out to decide what a default means would be a
build that fails offline and answers differently on two machines. Reachability is
`npx docpilot doctor`'s question, and it now prints the chain with the member
that answered marked.

**Every provider carries its own default model.** `chat.model` had one shipped
value — `qwen3:8b`, a statement about Ollama — which every other provider then
inherited, so it was dropped on any provider change and `assertChat` stopped the
build. Correct, and a dead end: `chat: { provider: 'openai' }` reads as a
complete sentence to everyone and was a build failure. The default lives on the
provider's own row now, beside `embedModel`. Two rows still have none:
`openrouter`, where the free pool answers, and `custom`, which names a host
rather than a service.

**The embedder is asked for, not assumed.** `PROVIDERS` carries one `embedModel`
string per service and the paragraph above that table says what they are:
defaults, not guarantees. When the model was **not written down by you** —
you named a provider and stopped, or you named neither — `npx docpilot index`
now asks the service which embedding models it serves and walks those answers
behind the configured name:

```
  embedders 2 to try — custom offers 1, and BAAI/bge-m3 is configured
  warn  BAAI/bge-m3 is not answering (HTTP 404); trying the next embedder
  embedder  acme/gte-large-v2 · 1024d — chosen from 2 candidate(s)
```

Three things it fixes, all one defect. `custom` and `llamacpp` name a HOST rather
than a service, so `BAAI/bge-m3` and `local` were this package guessing what you
loaded onto your own gateway. A stale catalogue name meant the build dying on its
first chunk with a 404 naming a model nobody typed. And a provider named without
a model stopped the build on the embed half while the same shape was a complete
sentence on the chat half.

**A name you wrote is never walked past.** `embed: {provider: 'x', model: 'y'}`
is used as given, no catalogue is read, and a wrong one fails loudly rather than
being quietly replaced. The candidate list is allowed to be a loose guess — an
OpenAI-compatible `/v1/models` is `{id}` and nothing else — precisely because
`createEmbedder` commits only to a candidate that answered a real embedding
request. Discovery proposes; the probe disposes.

**Discovery changes the model, never the provider.** The reverse proxy carrying
`/ai/v1/embeddings` is written from `resolveEmbed()` at config time,
synchronously, with no network, so a build that moved itself would leave every
reader's query vector posted to the wrong upstream.

**`embed: {provider: 'openai'}` is a complete sentence.** The unnamed model is
filled from the provider table, exactly as `resolveChat` fills `chatModel`. One
asymmetry with no reason behind it, gone.

**`npx docpilot doctor --models` checks the chat-only claim.** `anthropic`,
`deepseek`, `groq`, `xai` and `cerebras` are recorded as serving no embeddings
endpoint, and that is a claim rather than a law — the same table said it of
OpenRouter for months after it stopped being true, and the cost of it going stale
is a second key plus the text of the whole corpus posted to a third party at
build time. So the endpoint is knocked on, with a candidate from the provider's
own catalogue:

```
[docpilot] embed?    groq answers /v1/embeddings after all — nomic-embed-text-v1.5
                     embed: {provider: 'groq'} drops the borrowed openrouter key
```

Silent otherwise. It reports and never acts, for the proxy reason above; two
candidates at most, so it cannot become a survey; and `anthropic` is skipped
without a request, its API having no embeddings path to knock on.

**`chat.baseURL` is documented.** It has been read since the first release — by
`targetOf`, by `nodeChatTarget`, by `resolveEmbed` deciding where an automatic
embedder lives — and was in neither `DEFAULTS` nor the reference, so rule 11b
could not see it and nobody could find it. It is in both now, with `null`
meaning the provider's own address.

**`llamacpp` — llama.cpp's own server, as a provider.** Selected by
`LLAMACPP_BASE_URL` rather than by a key, because a local server has no
credential to be detected by, and that variable also moves the upstream:
`http://gpu.internal:9000` and requests go there. `CUSTOM_BASE_URL` does the same
for `custom`, which was pinned to `localhost:8000` in package source with no way
to move it.

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

### Changed

**`npx docpilot index` and `doctor` no longer exit on a missing config.** Both
used to `process.exit(1)` twice over: no config file, and a config file with no
named `docPilot` export. The named export is a contract about *agreement* — the
CLI and the build must resolve one object or the index is built with one embedder
and queried with another — and that argument holds exactly while there is an
object. With none, both sides resolve the same empty settings against the same
environment and reach the same provider. They warn and continue now, which is
what makes the zero-config install runnable end to end.

**`readiness` reports one missing key per provider, not per half.** `embed: 'auto'`
follows chat wherever chat can embed, so the two halves are usually one service —
and a missing key produced the identical sentence twice with the identical fix
under each, which the fall-through above makes the common case.

**`npx docpilot init` writes the index into your `.gitignore`.** `docs/public/rag/`
is megabytes of quantised vectors rewritten whole by every rebuild.
`.gitignore` in this repository has claimed `init` did this since it shipped;
nothing implemented it. Appended rather than created, so an existing file keeps
its contents, and idempotent.

**`@scalar/openapi-parser` is declared as an optional peer.** An OpenAPI file in
`public/` threw with the install command in the message, for a package that
appeared in no dependency list at all.

**VitePress is supported from 1.2.** The peer was `^1.6.4 || ^2.0.0-alpha.16`; it
is now `>=1.2 || >=2.0.0-alpha.16`. The four slots the theme fills —
`layout-bottom`, `nav-bar-content-before`, `nav-screen-content-after`,
`doc-footer-before` — have been there the whole time, and the version floor was
tracking the version this repository happened to build on. Below 1.6, VitePress
carries Shiki 1.x, which never published `@shikijs/langs` or `@shikijs/themes` at
all: there the four Shiki packages are a real install rather than an optional one.

### Fixed

**Shiki peers accept what VitePress already ships.** The four `@shikijs/*` peers
asked for `^4.0.0` while VitePress 1.6.4 — the current stable — carries Shiki
2.5.0, so `npm i @cloflin/docpilot` on a stable VitePress site ended in
`npm error code ELSPROBLEMS ... invalid: @shikijs/core@2.5.0`, and the usual way
out was an `overrides` block that either pinned the panel to the old version or
rewrote somebody else's subtree. The range is now `>=2`, which is what the adapter
actually needs: `createHighlighterCore`, the JavaScript regex engine and the
per-language and per-theme subpaths are unchanged across 2.x, 3.x and 4.x. Nothing
to install on VitePress 1.6+, and [nothing to override](https://docpilot-nine.vercel.app/reference/highlighting)
anywhere.

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
