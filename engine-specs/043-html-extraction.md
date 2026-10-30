# 043 — HTML extraction

> **Кратко.** До 3.0 каждый путь, который читает HTML (`docpilot import`,
> `index --html-dir`), держал свою копию конвейера, а в Markdown терялись строки
> кода с `<br>`, неактивные вкладки, подписи вкладок, объединённые ячейки и
> относительные ссылки. Теперь один `extractHtml` обслуживает все пути и будущие
> коннекторы Фазы 3; версия экстрактора входит в хеш корпуса только там, где есть
> HTML-страницы. Два спайка на 78 размеченных страницах без сети показали:
> парсер менять не нужно (ни одна страница не отличается), а Readability и
> defuddle проигрывают списку правил по коду и шуму, поэтому оба не приняты и ни
> одной зависимости не добавлено. Закоммиченные индексы состоят из Markdown и не
> сдвигаются ни на байт.

## Problem

Until 3.0 two readers turned a rendered page into Markdown, and each ran its own
copy of the pipeline. The defects below were read in the code at 2.1.1 (line
numbers are those of that tree) and are the list this spec closes.

| id | where (2.1.1) | what happened | requirement |
|---|---|---|---|
| F-01 | `html-to-md.ts:252-253` | `pre` was read by `textContent`, so a `<br>` inside a code block was lost; inline `br` became a space (`:91-92`) | HTML-02 |
| F-02 | `html-to-md.ts:68-74` | the fence language came from `code` only: VitePress puts `language-bash` on a wrapper, and `highlight-source-js` gave the info string `source` | HTML-02 |
| F-03 | `html-extract.ts:183-184` | `hidden` and `display:none` were dropped before any tab rule, so every inactive tab panel vanished | HTML-05 |
| F-04 | `html-extract.ts:36` | `button` was in `DROP_TAGS`, so a tab label built as a button was deleted | HTML-05 |
| F-05 | `html-extract.ts:51,53` | `figure` was dropped, and with it any code sample or table inside | HTML-02, HTML-04 |
| F-06 | `html-to-md.ts:129-143` | cells were read as text only; `colspan` and `rowspan` were ignored, and `querySelectorAll('tr')` joined the rows of a nested table to the outer one | HTML-04 |
| F-07 | `html-to-md.ts:52-62` | with no origin a relative `href` became text with no warning; `<base href>` and `rel=canonical` were never read | HTML-03 |
| F-08 | `documents.ts:212-213`, `build-rag-index.ts:1338` | the dead-link regex ran on raw Markdown including fenced code, and a dead link in an imported page stopped `index` | HTML-03 |
| F-09 | `html-dir.ts:126,160-184` | one page that threw aborted the directory; an empty page was skipped without a report | HTML-10 |
| F-10 | `build-rag-index.ts:1548-1550` | the corpus hash had no extractor term, so a version bump with no text change was invisible | HTML-07 |
| F-11 | `html-extract.ts:309` | `metadata` returned only title and description: no canonical, `lang`, `dateModified` or `noindex` | HTML-06 |
| F-12 | `dom.ts:28-33`, `package.json:182` | linkedom was a devDependency, so `npm i @cloflin/docpilot` did not install the parser and `import` failed with an install hint | HTML-08 |
| F-13 | `chunker.ts:41` | no NFC step in the extraction path; adding one to the shared Markdown reader would change committed bytes | HTML-07 |
| F-14 | `import.ts:63-68` | the attribution line read the clock and ICU locale data | HTML-07 |

Two decisions were also open when the phase began: whether the HTML parser
should change (PROJECT.md: "parse5 if its spike is clean, else linkedom"), and
whether a Readability-class selector should back up the rule list on pages with
no landmark (HTML-11).

## Research

### The labelled set

Both spikes run `scripts/extract-spike.mjs` offline: no network, no hosted
embedder and no model. The set has 78 pages.

- **72 docs pages.** Every page of `npm run docs:build` whose route has a
  Markdown source under `docs/` and is not `layout: home` (74 built pages, less
  `404` and the home page). The source, with front matter, `:::` container lines
  and `<script>`/`<style>` removed, rendered by markdown-it and read as text, is
  the ground-truth text. Its fenced blocks are the ground-truth code. The noise
  list is the VitePress chrome: "Skip to content", "On this page", "Previous
  page", "Next page", "Edit this page", "Return to top", "Last updated".
- **6 fixtures.** The synthetic pages of `test/fixtures/html-extract/`:
  `truth.txt` is the text, the `pre` text of `input.html` read by `codeText` is
  the code, `noise.txt` is the noise.

The **landmark-free subset** (research P-09) is the same 78 pages with `main`,
`article` and `[role="main"]` unwrapped into their children. A built docs page
always has `<main>`, so on the pages as built the landmark branch runs and a
fallback is never reached; only the subset can decide HTML-11.

### Metrics and the decision rule

All four are defined before the run and live in the harness as code.

| metric | definition |
|---|---|
| token F1 | multiset F1 over NFC-lowercased `[\p{L}\p{N}]+` tokens. Output Markdown is rendered and read as text exactly as the ground truth is, so link URLs and `{#id}` anchors do not count as words |
| code retention | share of ground-truth code blocks found verbatim (trailing whitespace trimmed) inside an output fence, pooled over all pages |
| noise leakage | noise strings present in the output and absent from the page's own ground truth (a page that documents a "Skip to content" link is not leaking) |
| parser diff | non-whitespace lines that one arm's Markdown has and the other lacks, counted in both directions |

Pages are scored in id order, a median of an even count is the mean of the two
middle values, and two runs print identical numbers (`cmp` of two `--out` files
exits 0). The constants, with their reasons, are in the harness:
`ADOPT_MIN_F1_GAIN = 0.02` (a gain below two points of token F1 is inside the
page-to-page difference of a set this size) and `MIN_SPIKE_PAGES = 6` (fewer
landmark-free pages and a median says nothing about a site not seen).

- **Parser switch (D-02, D-19).** Switch only when some page has a parser diff
  AND the parse5 arm's F1 or code retention on that page is higher.
- **Fallback adoption (D-08, D-28).** Adopt a candidate only when the
  landmark-free subset holds at least `MIN_SPIKE_PAGES` pages, its median F1
  exceeds the rule list's by at least `ADOPT_MIN_F1_GAIN`, its code retention is
  not lower and its noise leakage is not higher. A tie, or a gain below the
  minimum, is not a win. With fewer pages the result is "not measurable" and
  nothing is adopted.

### The arms

Every arm ends in `extractDocument`, the one serialiser (research Pattern 3).
No candidate's own Markdown is used.

| arm | what it does |
|---|---|
| `rules` | the extractor over linkedom's tree (the control) |
| `parse5` | parse5 `parse`, `serialize`, then linkedom `parseHTML`, then the same rule code: only the tree builder differs |
| `readability` | `new Readability(clone, { charThreshold: 100 }).parse()`; its `content` HTML wrapped in `<main>` and parsed by `parseDocument`. Falls back to happy-dom if it rejects a linkedom document (it never did: 0 of 156 pages) |
| `defuddle` | `Defuddle(clone, url, { markdown: false })` from `defuddle/node`; its `content` HTML, wrapped the same way |

Versions, installed with `--ignore-scripts` in a scratch directory outside the
repository (D-20), Node v26.8.1:

| package | version | published | note |
|---|---|---|---|
| parse5 | 8.0.1 | 2026-04-19 | seam verdict OK |
| @mozilla/readability | 0.6.0 | 2025-03-03 | seam verdict OK |
| defuddle | 0.19.5 | 2026-10-10 | newest release on or before 2026-10-16 (20 days old at the run); no install script |

The legitimacy seam takes package names and read `name@version` as a name that
does not exist, so it was run on the bare names. It rated defuddle SUS
(`too-new`) because its registry latest, 0.19.6, was published 2026-10-24. The
pinned 0.19.5 meets the 14-day rule of D-20, which is the rule that answers the
research's SUS rating instead of a checkpoint. Nothing entered `package.json`,
`package-lock.json` or the repository's `node_modules`.

### Numbers

**With landmarks (the pages as built), 78 pages.**

| arm | median F1 | mean F1 | win / loss / tie vs rules | code retention | noise | failed |
|---|---|---|---|---|---|---|
| rules | 0.9978 | 0.9606 | 0 / 0 / 78 | 420/442 = 0.9502 | 0 | 0 |
| parse5 | 0.9978 | 0.9606 | 0 / 0 / 78 | 420/442 = 0.9502 | 0 | 0 |
| readability | 0.9945 | 0.9007 | 1 / 59 / 18 | 416/442 = 0.9412 | 4 | 0 |
| defuddle | 0.9978 | 0.9491 | 15 / 8 / 55 | 397/442 = 0.8982 | 3 | 0 |

**Landmark-free subset, 78 pages (the one that decides HTML-11).**

| arm | median F1 | mean F1 | win / loss / tie vs rules | code retention | noise | failed |
|---|---|---|---|---|---|---|
| rules | 0.9978 | 0.9606 | 0 / 0 / 78 | 420/442 = 0.9502 | 0 | 0 |
| parse5 | 0.9978 | 0.9606 | 0 / 0 / 78 | 420/442 = 0.9502 | 0 | 0 |
| readability | 0.9945 | 0.8995 | 1 / 59 / 18 | 415/442 = 0.9389 | 4 | 0 |
| defuddle | 0.9978 | 0.9481 | 15 / 8 / 55 | 397/442 = 0.8982 | 5 | 0 |

Median F1 split by kind, landmark-free: on the 72 docs pages rules 0.9978,
readability 0.9958, defuddle 0.9983; on the 6 fixtures rules 0.9950,
readability 0.7847, defuddle 0.8059. The fixtures carry the chrome (cookie
banner, share bar, byline, marketing page) that the rule list was written for,
and that is where both candidates leak noise and lose recall.

### Decision 1 — the parser: keep linkedom

**No page of the 78 changes Markdown between the linkedom tree and the parse5
tree, with or without landmarks (parser diff 0 on every page), so the parser is
not switched and parse5 is not added.** The rule list also gives byte-identical
Markdown on all 78 pages with and without landmarks: the tag, role and token
rules, not the landmark, do the work.

The harness can see a difference when one exists. A hand-written page with
unclosed `p` and `li` elements and a table without `tbody` gives the same
Markdown under both trees. One edge differs: `<pre>` followed by two line feeds.
linkedom keeps the first line feed after `<pre>`; parse5 drops it as the HTML
rule says, and `codeText` then drops one more because it applies the same rule
itself (assumption A-04 was right). No labelled page has that shape, but it
means `codeText` would need a change if parse5 were ever adopted. That belongs
to the day of the switch, not to this spec.

### Decision 2 — the fallback: not adopted

**Neither candidate meets the rule on the landmark-free subset: readability's
median F1 is 0.0033 below the rule list's and defuddle's is equal (gain 0.0000
against a minimum of 0.02); both retain less code (0.9389 and 0.8982 against
0.9502) and both leak more noise (4 and 5 strings against 0). Nothing is
adopted: no `docPilot.html.fallback` key, no `html-fallback.ts`, no peer
dependency, and the "declares no peer dependencies" test is unchanged.**

### Assumptions A-01 to A-10, resolved

| # | claim | outcome |
|---|---|---|
| A-01 | parse5 has no selector API | not needed: the arm serialises the parse5 tree and lets linkedom read it, so no adapter or selector engine was built |
| A-02 | parse5 supports Node 22.13+ and 24 | run on Node v26.8.1 only; moot while the parser stays |
| A-03 | `parse5-htmlparser2-tree-adapter` is the right adapter | not installed, not needed |
| A-04 | linkedom keeps the first newline after `<pre>` | true (see Decision 1) |
| A-05 | some generators wrap code in `figure` or a line-number table | held by fixtures: `test/html-code.test.js` has the highlight.js gutter table and the wrapper cases |
| A-06 | the milestone's WCXB ranking figures | not used as an input |
| A-07 | Readability works on a linkedom document | true: 0 happy-dom fallbacks in 156 runs |
| A-08 | defuddle needs nothing beyond its README | it ran on Node v26.8.1; its optional linkedom is the same 0.18.14; 22 and 24 not run |
| A-09 | `toLocaleDateString('en-GB')` is stable across ICU versions | the attribution line takes an injected `now`, tests pass it |
| A-10 | linkedom supports `removeAttribute` and `querySelectorAll('[role="tabpanel"]')` | true: `html-tabs.ts` uses both and its tests pass |

### Limits of the measurement

The ground truth is approximate, and the same for every arm. 21 docs pages show
code misses for the rule list; the ones read (`/features/gate`) come from `<Demo>`
components whose `#code` slot appears in the Markdown source and is not rendered
into the built HTML, so no extractor could retain it. Interactive demo widgets,
in turn, add their own text to the page (the gate demo's "τ 0.68"). Both biases
hit the four arms alike. They lower absolute retention and F1; they cannot make a
candidate lose to the control alone. The real-page measurement on the reference
site is the Phase 12 acceptance (REL-08), not this spike.

## Decision

### The pipeline

`extractHtml(html, options)` is async (it parses); `extractDocument(document,
options)` is its synchronous core. It makes no network call, reads no clock or
locale and calls no model. A page-level problem is a typed result (`ok: false`
and a `reason`), never a throw. The order lives in one place, `extract-html.ts`:

1. refuse a page over `MAX_HTML_BYTES` before it is parsed;
2. parse, and read the metadata before any removal (a title can sit in a
   `<header>` that step 5 deletes);
3. stop on `noindex`;
4. choose the root: a content selector, else `pickMain` (a landmark, then a
   score);
5. `unfoldPanels`: tab panels and accordions become visible blocks, each with its
   label (`html-tabs.ts`);
6. remove the `exclude` selectors, then `prune` the furniture (`html-extract.ts`);
7. serialise the root to Markdown through the one serialiser (`html-to-md.ts`,
   `html-code.ts`, `html-table.ts`, `html-links.ts`);
8. normalise to NFC;
9. refuse a page with fewer than `MIN_EXTRACTED_CHARS` characters left.

Modules: `extract-html.ts` (the pipeline and `EXTRACTOR_VERSION`),
`html-options.ts` (configuration), `html-links.ts` (link resolution and
counters), `html-code.ts` (code blocks, language, gutters), `html-table.ts`
(spans and fallback), `html-tabs.ts` (panels), `html-extract.ts` (the rule lists
and metadata), `extraction-report.ts` (the table), `dom.ts` (the one place the
parser is imported).

### Configuration

One object, `docPilot.html = { content?, exclude?, sources?: { [key]: { content?,
exclude? } }, fetcher? }`. `content` is one CSS selector for the page body;
`exclude` is a selector or a list, removed from inside it. A `sources` key is a
URL prefix (the strings `sources.allow` takes) for `import`, or a directory for
`--html-dir`; only the longest matching key applies.

Precedence is flags, then the longest `sources` key, then the project default.
`content` and `exclude` are each taken from the most specific level that sets
them, and a level that sets `exclude` replaces the lower list. An empty string or
list is "not set". Flags on both `import` and `index`: `--html-select <css>` and
`--html-exclude <css>`. Phase 3 connectors pass the same `{ content, exclude }`
pair.

### Links

The base of a page, first match wins (research Pattern 4): its `<base href>`,
then its `rel=canonical`, then the `--html-base` value or the `import` source
URL. Only an `http:` or `https:` result counts. A relative href resolves against
it; an unresolvable or malformed href becomes plain text and counts as a link
failure; an absolute non-web scheme (`javascript:`, `data:`) becomes text and is
counted apart (`schemeDropped`), and a fragment-only href stays text. Images are
never emitted on the HTML path: an import is text, and an image that survived
would be a link into a host the owner does not control (`img` and `picture` are
in `DROP_TAGS`). `figure` is kept when it holds a `pre` or a table.

Link policy is split by source (D-10). Authored docs keep the strict dead-link
check. In an imported page a dead root-relative link becomes its text with a
warning, fenced and inline code are never read, images are never rewritten, and
`index` exits 0.

### Code, tables, tabs

- A code block reads its subtree: `<br>` becomes a line feed, one leading line
  feed after `<pre>` is dropped when it is the first character of the `pre`'s own
  first text node (the HTML rule), CRLF and U+00A0 are normalised, trailing line
  feeds go. The language comes from a `language-` token on the `code`, the `pre`
  or up to `LANG_ANCESTOR_DEPTH` ancestors. A highlighter's line-number table and
  copy button are dropped.
- A table expands `colspan` and `rowspan` by copying the cell text into each
  covered position. A table with a block in a cell, a ragged grid, or a row
  wider than `MAX_TABLE_SPAN` is written as one `- **header**: value` bullet per
  row from the raw cells, never as a broken table.
- Tab and accordion labels become a **bold lead line** above their panel, not a
  heading. A heading per tab would make each panel a section of two or three
  lines, and the chunker merges a section shorter than `MERGE_BELOW_TOKENS`
  (120) into its neighbour and deletes its anchor; it would also put a level
  between the page's own headings. Detection is ARIA first (`role=tablist`,
  `tab`, `tabpanel`, `aria-controls`, `aria-labelledby`, `details`/`summary`),
  then the named class patterns in `TAB_PATTERNS`. A group that does not pair
  one label to one panel is left unchanged: a wrong pairing would put one
  panel's label on another's text.

### Metadata, skips and exit codes

Metadata read onto the document: title (`<title>`, `og:title`, `h1`),
description, `rel=canonical` (http or https only), `lang`, `dateModified` (meta
or JSON-LD, ISO 8601 only, kept as written, never hashed), `noindex`.

A page is skipped, never thrown, with one of these reasons: `noindex` (meta
robots, or the `X-Robots-Tag` value when the fetch or the `fetcher` provides it,
D-27), `near-empty (N characters)`, `too large (N bytes)`, `parse failed: …`,
`invalid selector "…"`, `content selector "…" matched nothing`, or
`extraction failed: …` (for example a page nested too deep to walk).

`index --html-dir` skips and warns, and exits 0; it stops only when it attempted
at least one page and extracted none. `import` handles one page, so a skipped
page is "no page extracted" and the command exits 1. A kb page without
`source:` stays a stop (D-23): that is an authoring error, not a bad page.

### The report

`docpilot import` prints a per-source table of `pages`, `kept`, `dropped`,
`empty` and `link failures`, with the first `MAX_REPORTED_SKIPS` skipped pages
named. Counts are plain digits (no locale grouping), in code points of NFC,
whitespace-collapsed text. `docpilot doctor` re-runs the extraction offline over
each directory key of `docPilot.html.sources` (never over a URL key, and not
under `--json`), prints the same table, and lists every imported page an older
extractor wrote with its re-import command (at most `MAX_STALE_LISTED` named by
`index`, the full list by `doctor`). Human-readable only in this phase.

### The fetcher

`docPilot.html.fetcher(url, { signal }) → Promise<string | { html, url?,
headers? }>`. Node-only, never in a client artifact, used by `docpilot import`.
The requested URL and the returned `url` both pass `checkSource` against
`sources.allow`, exactly like a redirect (D-29). The call carries an
`AbortSignal` with `FETCH_TIMEOUT_MS`, shared with the built-in fetch. The
`.md` alternate search keeps the built-in fetch. `--html <file>` stays the manual
form.

### Versioning and the hash

`EXTRACTOR_VERSION = 2`: 1 is the 2.x extractor, which wrote no stamp, and 3.0
is the first release of the new one, so Phase 2 bumps once. It enters the corpus
hash as the term `extractor:2` only when the corpus holds `--html-dir` pages. A
Markdown-only corpus has no extractor in it, so the committed indexes in
`docs/public/rag/` and `rag-local/` stay byte-identical. A page that
`docpilot import` writes carries `extractor: <N>`, `lang` and `dateModified` in
its front matter, and carries no hash term (D-26: its bytes already hold the
extractor that wrote them); `index` warns, never fails, on a page written by an
older or a newer extractor and names the re-import command.

`PARSER_PINS` in `dom.ts` fixes the versions the Markdown was measured with:
linkedom 0.18.14, htmlparser2 10.1.0, css-select 7.0.0, entities 7.0.1.
linkedom is an exact regular dependency, imported statically from `dom.ts` only.
A parser upgrade is an `EXTRACTOR_VERSION` bump, and a test fails when the
installed versions differ. The parser never enters the browser bundle (the
bundle report lists no parser module).

### Constants

| constant | value | reason |
|---|---|---|
| `EXTRACTOR_VERSION` | 2 | the first 3.0 extractor; bump once per release |
| `MIN_EXTRACTED_CHARS` | 24 | below it the body is a label ("Loading…"), not a sentence; code points |
| `MAX_HTML_BYTES` | 8 MiB | a larger page is a data dump or an attack; skipped before parsing |
| `FETCH_TIMEOUT_MS` | 30000 | one deadline for the built-in fetch and the `fetcher` |
| `MAX_TABLE_SPAN` | 64 | clamp on a span and on grid width: HTML allows `colspan` to 1000, and a hostile `colspan="100000"` would otherwise cost memory and time |
| `MAX_LINK_SAMPLES` | 3 | links named in a degraded-link warning |
| `MAX_REPORTED_SKIPS` | 10 | skipped pages named in the report |
| `MAX_STALE_LISTED` | 5 | stale imports named by `index` |
| `LANG_ANCESTOR_DEPTH` | 3 | how far above a `pre` a `language-` token is read |
| `CODE_LABEL_MAX` | 40 | longest label beside a wrapped `pre` |
| `FURNITURE_MAX_CHILDREN` | 4 | the text rules (byline, date, TOC title, feedback question) apply only to an element with at most this many element children: a byline is a line |
| `FURNITURE_TEXT_MAX` | 120 | no text rule sees more than this many characters |
| `SOFT_TEXT_FLOOR` | 40 | a soft hint (`slider`, `sidebar`, `popup`, …) drops a widget only when it holds fewer raw characters than this and no table: a pricing table inside a slider is content |
| `MAX_JSONLD_CHARS` | 100000 | JSON-LD larger than this is not parsed |
| `TOC_LINK_SHARE` | 0.8 | share of link text that makes a list an in-page table of contents |
| `ADOPT_MIN_F1_GAIN` | 0.02 | harness: the margin a fallback must win by |
| `MIN_SPIKE_PAGES` | 6 | harness: fewer landmark-free pages is "not measurable" |

The named rule lists, each entry with its reason in `html-extract.ts`:
`DROP_TAGS`, `DROP_ROLES`, `DROP_HINTS`, `SOFT_HINTS`, `CONSENT_TOKENS`,
`FEEDBACK_TOKENS`, `SHARE_TOKENS`, `TOC_TOKENS`, `BREADCRUMB_TOKENS`,
`BYLINE_TOKENS`, `LINE_NUMBER_HINTS` and `TAB_PATTERNS`.

## Why it fits

One pipeline serves `docpilot import`, `index --html-dir` and the Phase 3
connectors, so a rule changed once is changed everywhere; a test holds that
`import.ts` and `html-dir.ts` contain no prune, `toMarkdown` or `pickMain`. It
reuses what exists: the rule lists and the allowlist, `renderBlocks` as the one
serialiser (the spike's candidates were required to go through it too),
`routeOf` for page routes, `SourceDoc` fields for metadata, `checkSource` for
the fetcher, and the `docpilot-3-target` rule against a new runtime dependency
for work a module already does. The browser bundle gains nothing. The static
index stays content-hashed and byte-identical for identical input.

## Cost and risk

- **Install footprint.** linkedom and its dependencies were already in the lock;
  the move from `devDependencies` to `dependencies` adds about 3 MB of package
  files to a consumer's install (npm `unpackedSize`, research; `du` on this
  checkout reads 7.4 MB for the same tree because of block rounding and source
  maps). The bundle is unchanged.
- **Hash.** The corpus hash of a built-site corpus moves once, with the
  `extractor:2` term; Markdown-only corpora and both committed indexes do not.
  Imported pages written by 2.x read as extractor 1 and get a warning with the
  command that refreshes each.
- **The measurement.** 78 pages, 72 of them from one docs site, on one Node. The
  verdict holds for that set. The real-page measurement is REL-08.
- **Revert condition.** If a real-page run (REL-08) shows the rule list leaking
  chrome on templates with no landmark that neither fixture nor docs page
  reproduces, the answer is a new fixture and a rule, then a re-run of this
  harness; a Readability-class fallback returns only through the rule above,
  as an opt-in imported dynamically with an install hint (D-28). If parse5 is
  ever wanted, `codeText` must change first (Decision 1).

## Checks

| file | what it holds |
|---|---|
| `test/html-fixtures.test.js` | the six fixtures: `expected.md` by `toMatchFileSnapshot`, every `truth.txt` line present, no `noise.txt` string, two runs byte-identical, the relative link resolved against the canonical URL |
| `test/extract-html.test.js` | the pipeline, the corpus hash term, deep nesting, size ceiling |
| `test/html-code.test.js`, `test/html-structure.test.js` | code blocks, gutters, language, tables, spans, headings, `details`, entities |
| `test/html-furniture.test.js` | tab panels, accordions, the noise lists and the text rules |
| `test/html-links.test.js`, `test/html-metadata.test.js` | link base order and counters; metadata, noindex, JSON-LD |
| `test/html-options.test.js`, `test/html-dir.test.js` | precedence and config validation; a bad page does not stop a directory |
| `test/import.test.js`, `test/import-fetcher.test.js`, `test/imported-pages.test.js` | the shared pipeline in `import`, the fetcher and its allowlist check, dead-link degrade, stale-extractor warnings |
| `test/doctor-extraction.test.js` | the doctor rows |
| `test/packaging.test.js`, `test/bundle-report.test.js` | linkedom a pinned regular dependency reached through `dom.ts`, `PARSER_PINS`, no peer dependencies, no parser module in the browser IIFE |
| `scripts/extract-spike.mjs` | not a test: the spike harness, `node scripts/extract-spike.mjs --candidates=<dir> --out=<file>` after `npm run build:js` and `npm run docs:build` |

## What this does not do

- No configurable error budget for failing pages (Phase 3/5), and no JSON form
  of the report.
- No retrieval change and no measurement of the new Markdown on an eval set: the
  eval evidence for the extractor bump comes in Phase 6 with the other
  embedding-moving changes (EVAL-04).
- No real-page measurement on the reference site (the Phase 12 acceptance,
  REL-08), and no refresh of `.planning/codebase/`.
- No change to the committed indexes: they are Markdown-only, and `index` is not
  re-run for this spec.
- No Readability-class fallback and no parse5: both measured and not adopted.
