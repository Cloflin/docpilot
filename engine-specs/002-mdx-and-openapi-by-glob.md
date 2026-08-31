# 002 — `.mdx` enters the walk, and the specs stop being in one directory

> **Кратко.** Индексатор брал только `.md`, поэтому отгруженный Docusaurus-адаптер
> монтировал панель над корпусом, в котором нет ни одной его страницы. `.mdx`
> добавлен в обход, модульный синтаксис MDX снимается новым `stripMdx` — измерено
> на этом репозитории: одна строка на `layout: home` странице, ноль изменённых
> чанков. Спеки OpenAPI больше не прибиты к `docs/public/openapi/`: появился
> ключ `docPilot.openapi` — каталог, файл или `*` в имени файла.

## Problem

**Two holes, and the first one is a shipped adapter over an empty corpus.**

`walkMarkdown` took `.md` and only `.md` (`build-rag-index.ts:135`). A Docusaurus
project writes `.mdx`. `src/adapters/docusaurus/` ships, is documented, and mounts
a panel on pages that — for a project written the way Docusaurus projects are
written — were not in the index it queries. Nothing failed: the build succeeded,
the panel loaded, the gate refused, and the refusal is indistinguishable from
"your documentation does not cover this".

Two further places assumed the same extension and would have produced wrong ids
rather than an error: `routeOf` strips `.md` (`route.ts`), so an `.mdx` page would
have been routed as `/guide/install.mdx`; and `externalIdFor`
(`build-rag-index.ts:218`) does the same for imported pages.

**The second hole is one hard-coded directory.** `docs/public/openapi` was written
into the indexer (`build-rag-index.ts:993`, before this change). A project whose
spec is at `api/openapi.yaml` — which is where most of them are — had to copy the
file into the docs site's public assets to index it at all, and then keep the copy
in step by hand.

## Research

- **MDX components need nothing.** `stripHtml` (`normalise.ts:442`) already
  removes `</?[a-z][^>]*>` with the `i` flag, so a capitalised JSX element loses
  its brackets and keeps its children exactly as `<em>` does. Checked before
  writing a component pass: there was nothing for one to do.
- **What is genuinely unlike markdown is the module syntax**, and it is the part
  that hurts most: `import Tabs from '@theme/Tabs'` opens *every* page of a
  Docusaurus site. A chunk that says nothing and appears everywhere is the worst
  shape of noise a BM25 channel can carry.
- **`normalise.js` already owns this class of pass and already owns its hazard.**
  `stripVue` is a line state machine rather than a multiline regex, and its
  comment records why: the regex version reached into a fenced sample and deleted
  its body. `stripMdx` is written on the same `eachLine` scanner for the same
  reason.
- **Measured on this repository's own docs**, before wiring it in: `stripMdx`
  changes **one file** — `docs/index.md`, one line, `import Home from
  './.vitepress/theme/Home.vue'` — and that page is `layout: home`, which produces
  no chunks. **Zero chunks changed.** That measurement is what made it safe to run
  the pass over every page instead of gating it on the extension.
- **A glob library is not needed.** Three shapes — a directory, a file, a `*` in
  the basename — cover every real layout. A dependency for that is a dependency
  this package has already declined twice, and the reasons are in
  `packaging.test.js`.

## Decision

**`.mdx` joins the walk.** `walkMarkdown` matches `/\.mdx?$/`, `routeOf` strips
`.mdx` alongside `.md` and `.html`, and `externalIdFor` does the same. One
extension is stripped, never two.

**`stripMdx` is the first pass of `normaliseMarkdown`**, ahead of `applyLlmTags`
for the reason `applyLlmTags` runs ahead of `stripHtml`: a module statement is not
markup and must not reach a pass that reads markup. It removes `import` and
`export` statements and whole-line JSX comments, and it runs over every page
rather than only over `.mdx`, with two guards:

- **the start must look like a statement, not a sentence.** `import` needs a
  quoted specifier, a `from '…'`, or the `{` of a multi-line list; `export` needs
  a declaration keyword. `import the file's contents` survives its apostrophe and
  `export the data as CSV` survives its verb.
- **the end is bracket balance**, so `export const toc = [` runs to its `]`
  however many lines that takes. Anything that stopped earlier would resume in the
  middle of an expression and index half of it.

Fenced lines are untouched, like every other pass in the file.

**`docPilot.openapi`** is a new server-only setting: a list of paths from the
project root. `null` keeps the old behaviour exactly.

```js
openapi: ['api/openapi.yaml']     // one file
openapi: ['api']                  // a directory
openapi: ['specs/v*.yaml']        // a name pattern
```

`specFiles()` in `lib/openapi-chunker.ts` resolves it. `*` matches inside the file
name only; a `*` in a directory segment is an error, and so is a path that was
written and does not exist — the default directory is the one path allowed to be
absent, because most projects publish no spec.

**A spec still claims `/reference/<basename>`, and now two of them can collide.**
The filesystem used to keep basenames unique for free; two configured directories
do not. `v1/api.yaml` beside `v2/api.yaml` **stops the build** naming both files.
Which should win is not a decision this package can make.

## Why it fits

Every piece lands on machinery that already exists and already states its own
rules. The extension list is in `routeOf`, the one function whose header is about
what happens when that rule is written twice. The MDX pass is on `eachLine`, the
scanner the other three passes in that file share. The spec list is a function in
the module that already owns "what is a spec", reached from the same call site
that used to hold a `readdirSync`. The new setting is `SERVER_ONLY`, which is
asserted rather than remembered — and the three documentation gates in
`docpilot.test.js` failed the moment the key was added, which is what made
documenting it a step rather than a promise.

## Cost and risk

- **`stripMdx` runs over every page, so a false positive deletes documentation.**
  Mitigated by the two guards above, tested from both directions, and measured on
  this corpus at zero chunks changed. Residual risk: a page whose prose contains
  an unfenced line that is genuinely a valid `export const …` statement and is
  meant to be read. Nothing in this repository is that, and a page that is should
  fence it.
- **The multi-line balance counter strips quotes crudely** — a regex over
  `'…' "…" \`…\`` before counting brackets. A bracket inside a template literal
  with an interpolation could still be miscounted. The failure mode is bounded: it
  eats to the next balancing line of a statement it already decided was a
  statement.
- **`.mdx` in the corpus is new content for anyone who has one.** For a Docusaurus
  project this is not a regression, it is the first time the corpus is what the
  panel claims it is — but it changes the corpus hash, and the gate must be
  recalibrated on that project.
- **The duplicate-basename check is new and can stop a build that used to pass.**
  Only for a configuration that could not previously exist: one directory cannot
  hold two files of one name.

## Checks

- `test/mdx-openapi.test.js` — 15 cases: five `stripMdx` behaviours including the
  fence guard and the prose guard, the pipeline position, `.mdx` routing, and
  eight `specFiles` cases including both error paths.
- `test/docpilot.test.js` — the three documentation gates (11b, 11d, 11e) now
  cover `openapi`, and the `/reference/` route rule was rewritten around
  `specNameOf` plus a new assertion that a basename collision dies.
- `npm run typecheck` — `openapi` is declared in `types/config.d.ts`.

## What this does not do

- **It does not render MDX.** A component whose output *is* the content —
  a table built from a JS array, a card grid — contributes its JSX text and no
  more. That is a real limit and the honest fix for it is
  [001](001-index-a-built-site.md): index the built HTML.
- **It does not warn about how much JSX a page lost.** A threshold was considered
  and skipped: on the corpus this was measured against, the number is zero, and a
  warning calibrated against no data is a warning that gets muted.
- **It does not add a glob library.** `**`, `?` and brace expansion are not
  supported and say so.
- **It does not touch `/reference/` route assignment.** The basename is still the
  route; the change is only that a collision is now possible and is now refused.
