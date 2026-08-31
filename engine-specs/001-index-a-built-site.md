# 001 — A site that is already built is a corpus

> **Кратко.** Индексатор ходил только по `.md`, а HTML попадал в корпус лишь
> поштучно через `docpilot import <url>` — по сети, через allowlist, с моделью в
> конце. Добавлен флаг `index --html-dir <dir>`: обход собранного сайта теми же
> экстрактором и конвертером, что уже написаны для `import`, с цитированием по
> маршруту и без единого сетевого запроса. Новых парсеров нет; риск — чужая
> вёрстка без `<main>`, для неё есть `--html-select`.

## Problem

`walkMarkdown` (`src/build/build-rag-index.ts:130-135`) takes `.md` and nothing
else. That is the right default and it is also the whole of what the indexer can
read, which makes the set of projects this package can serve exactly the set of
projects that author documentation as markdown files in a directory it can see.

Every other project has HTML. Hugo, Jekyll, MkDocs, Astro, Next and Nuxt all
produce a directory of it; a Laravel or Symfony help centre renders it from
templates; a hosted knowledge base serves it and shows you nothing else. For all
of them the only route into the corpus was `docpilot import <url>`
(`src/build/import.ts`): **one page per invocation**, over the network, past
`docPilot.sources.allow`, with a model annotating the result and a file written
into `importDir`. That pipeline is correct for what it is for — mirroring
somebody else's page — and it is the wrong shape for four hundred of your own.

The parts that would do the job are already here and already tested:

| what | where | tested by |
|---|---|---|
| which subtree is the page | `pickMain`, `prune` (`lib/html-extract.ts:214`, `:251`) | `test/import.test.js` |
| the page's name and description | `metadata` (`lib/html-extract.ts:309`) | same |
| HTML to markdown | `toMarkdown` (`lib/html-to-md.ts:325`) | same |
| an optional HTML parser | `import.ts:128-148` (private) | `test/packaging.test.js` |

What was missing was a directory walk and a file path to route mapping. Both are
small; both are also exactly the parts that get rewritten wrongly inside the
indexer if they are not written once.

## Research

- **`routeOf` already states the rule and its header states why it is one
  function.** `docs/guide/index.md` and `dist/guide/index.html` are both `/guide`,
  and the `index` collapse is the half that was historically implemented twice and
  disagreed at the site root — the defect that module's comment records. Adding
  `.html` to its extension alternation is therefore the *only* place the second
  spelling can live without recreating that bug.
- **Pagefind, Algolia DocSearch and every site-search product read built HTML,
  not sources.** The precedent for "index the artefact" is the entire category;
  what is unusual here is doing it *beside* a markdown corpus rather than instead
  of one, which is why the shadowing rule below exists.
- **A sitemap is a filter, not a crawl list.** `sitemap.xml` is the file a
  generator already writes to say which pages are real. Reading it locally needs
  no network, no allowlist and no robots handling; fetching the URLs it names
  would need all three. The measured difference in scope between those two
  designs is the difference between a flag and a subcommand.
- **`metadata()` prefers a page's own `<h1>` over its `<title>`.** Measured while
  writing the suite: a fixture with a shared `<h1>` gave every page in a directory
  the same name, and the per-route assertions passed while testing nothing. Noted
  here because it is the first thing a consumer with a templated `<h1>` will hit.

## Decision

```bash
npx docpilot index --html-dir=dist
npx docpilot index --html-dir=public --html-select="article.doc"
npx docpilot index --html-dir=dist --sitemap=dist/sitemap.xml --html-base=https://acme.test
```

**`src/build/lib/html-dir.ts`** is the new module and holds four exported
functions — `walkHtml`, `routeForHtml`, `sitemapRoutes`, `pageFromHtml` — behind
`readHtmlDir`, which returns records, not chunks. It parses no HTML itself: the
extractor, the serialiser and the parser loader are imported and used verbatim.

**`src/build/lib/dom.ts`** is `parseDocument`, moved out of `import.ts` because
there are now two callers and the install message a consumer meets must be one
string, not two.

**The contract of a built page:**

1. It is a page of **this** site. It is cited by its route and carries no
   `origin`, because nothing left the machine and there is no external source for
   a citation to point at. This is why the local path needs no `sources.allow`
   entry while `import` does.
2. Its route follows `routeOf` — one shared rule, `.html` and `.md` alike.
3. `kind` comes from `kindFor(route)`, the same function markdown uses.
4. **Markdown wins.** A built page whose route a markdown page already claims is
   skipped and counted. Pointing this at the `dist/` of the site being indexed is
   a no-op, not a duplicate corpus.
5. Its source text is assembled as an imported page is: `# title`, the page's own
   `description`, then the body at `##` and below — so the title chunk carries the
   sentence the page says about itself, which is the strongest dense signal it has.

**`--html-select` does not fall back.** A selector that matches nothing warns and
skips the page. Falling back to `pickMain` would index a different subtree than
the one the consumer named and say nothing about it.

**`--sitemap` reads a local file** and is a filter over the walk. Nothing is
fetched.

## Why it fits

Nothing new can enter the corpus by a path that did not already exist. The
extractor's rules are `skills/docs-import/SKILL.md`'s rules, unchanged and
unre-derived; the chunker is the same `chunkMarkdown`; the route is the same
`routeOf`; the `kind` is the same `kindFor`. The one genuinely new decision —
what happens when markdown and HTML claim one route — is resolved in the
direction that is always right: the source file beats the artefact built from it.

The flag is a flag rather than a config key on purpose. `--html-dir` names a
build artefact, a path that exists after `npm run build` and not in a fresh
clone. A setting that is wrong in a fresh clone is a setting that fails CI for a
reason nobody can see.

## Cost and risk

- **`linkedom` moved.** It was an optional, undeclared dependency reached from
  `import.ts`; it is now reached from `lib/dom.ts`, and `packaging.test.js` names
  that file. The registry entry moved with it, and a second rule was added: no
  file in `src/` other than `lib/dom.ts` may write `import('linkedom')`. A third
  caller that reimplements the try/catch fails the suite instead of shipping a
  second install message that drifts.
- **`routeOf` now strips `.html`.** One extension is stripped, never two, so a
  markdown file named `a.htm.md` still resolves to `/a.htm`. Verified over this
  repository's own `docs/`: **0 routes changed**.
- **Foreign markup is the real risk.** A page with no `<main>` and no dominant
  prose block gives chunks of furniture. Mitigations, in order: `pickMain`'s
  prose-weighted scoring, `--html-select`, and `index --dry`, which reports the
  built-page count and every warning before anything is written.
- **Two files, one route.** Several generators write both `guide.html` and
  `guide/index.html`. Unhandled, that is a `duplicate chunk id` build death
  several hundred lines from its cause; here the second file is skipped by name
  in a warning.
- **The corpus moves, so the thresholds move.** A first build that includes
  `--html-dir` owes `calibrate` and `eval`. This is stated in `/reference/cli`
  beside the flag, not only here.

## Checks

- `test/html-dir.test.js` — 12 cases: the walk and its skipped directories, the
  route mapping including `index` and `.htm`, sitemap parsing in three URL
  spellings, extraction dropping nav and footer, the two `--html-select`
  behaviours, route collision, sitemap filtering, and the missing-directory error.
- `test/packaging.test.js` — the optional-module registry now names
  `src/build/lib/dom.js`, plus a walk over `src/` asserting no other file
  imports `linkedom`.
- `npm run typecheck` covers the new module.

## What this does not do

- **No crawling.** `--sitemap` reads a file. There is no fetching, no robots
  handling and no rate limiting, and adding them would make this a subcommand
  with an allowlist rather than a flag — which is what `import` already is.
- **No JavaScript execution.** A page whose content is rendered client-side has
  no content in its HTML, and this command will say it produced no chunks. That
  is honest and it is a real limit.
- **No `origin` and no allowlist for local files.** A built directory the
  consumer owns is not somebody else's page. Indexing an HTML directory that came
  from elsewhere is possible and is the consumer's own provenance decision; the
  citation will name a route on their site either way.
- **Nothing about templates.** Blade, Twig, Liquid and ERB reach the corpus
  through their rendered output, not through their source. Indexing a template
  directly is a separate question and a worse one — a template's text is UI
  strings, placeholders and i18n keys, and a citation into it points at a page
  that was never served.
