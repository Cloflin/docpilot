# 003 — The block stream gets a name

> **Кратко.** Блочный поток `{kind, text, level, lang, notes}` уже существовал —
> внутри `html-to-md.js`, приватно, и сразу сериализовался в markdown. Тип вынесен
> в `lib/ir.ts` вместе с рендерером `renderBlocks`; `toMarkdown` стал двумя
> строками. Новый формат теперь — генератор блоков, а не ещё один эмиттер
> markdown. Кода не переписано ни строки: вторая половина `toMarkdown` перенесена
> дословно. Реестр парсеров сюда не входит и появится, когда форматов станет
> больше трёх.

## Problem

`html-to-md.ts` produced a block stream and threw the type away.

`blocks()` is a generator yielding `{ kind: 'p' | 'h' | 'code' | 'list' | 'table'
| 'quote' | 'hr', text, level?, lang?, notes? }` in document order, and its own
comment says why it is a generator rather than a string builder: *so the caller
can see the sequence*. The caller then serialised it immediately, inside the same
function, and nothing outside the module could name the shape.

That is fine for one format. It is the entire cost of a second. `.rst`, `.adoc`
and a notebook's cells are all lists of headings, paragraphs, code, tables and
quotes; each of them, written against today's code, has to emit **markdown**, and
markdown is where the rules that are easy to get wrong live:

- **the heading ladder is normalised, not copied.** A source whose sections are
  `<h3>` because of how a template nests produces a file with no `##` in it at
  all — and the chunker splits on heading level, so that page becomes one chunk.
- **a fence is as long as it needs to be.** A sample that itself contains a
  ` ``` ` line — every page documenting markdown has one — closes its own block in
  the middle of itself under a three-backtick fence.
- **a table's notes follow the table.** A `data-tippy-content` is frequently the
  only definition a term in that table has anywhere on the page.

Each of those was reachable only through a DOM, which is also why none of them had
a test of its own: asserting the fence rule meant constructing an HTML page that
happened to produce a fence.

## Research

- **The chunker was the other candidate for the seam, and it is the wrong one.**
  `chunkMarkdown` is text all the way down — `toSections`, `scanBlocks`,
  `packLines`, `splitFence`, `splitTable`, `hardSplit` all operate on strings, and
  giving it a block entry point means restructuring 621 lines of the hottest code
  in the build. The reuse a new format actually needs is the *emitter*, not the
  cutter: once it has markdown, `chunkMarkdown` already handles it.
- **Extraction after three consumers, not before one.** `html-to-md` had one
  caller when it was written; it now has three — `import`, `index --html-dir`, and
  whatever format comes next. That is the point at which naming a shared type is
  a description of what exists rather than a guess about what might.
- **The registry was deliberately left out.** A public `docpilot.parsers.js` is a
  new extension point, a new compatibility surface and a new failure mode, and
  three formats do not need one. This spec is the seam; the registry is a separate
  decision with its own number, if it is ever taken.

## Decision

**`src/build/lib/ir.ts`** exports two things:

```ts
export type Block = {
  kind: 'p' | 'h' | 'code' | 'list' | 'table' | 'quote' | 'hr'
  text: string
  level?: number      // 'h' only
  lang?: string       // 'code' only, '' rather than null — it is concatenated
  notes?: { term: string; definition: string }[]   // 'table' only
}

export function renderBlocks(found, { minHeading = 2 } = {})
  // → { markdown, headings, links }
```

`kind` is a closed set on purpose. A format with something else — an admonition,
a footnote, a definition list — converts it into one of these, which is the
decision `html-to-md` already makes for `<dl>`.

**`toMarkdown` becomes its first half plus a call:**

```ts
export function toMarkdown(root, { origin = '', minHeading = 2 } = {}) {
  return renderBlocks([...blocks(root, { origin })], { minHeading })
}
```

A new source format is now: write a function that yields `Block`s, hand them to
`renderBlocks`, hand the markdown to `chunkMarkdown`. Nothing about fences,
ladders or notes has to be rediscovered.

## Why it fits

It is the smallest change that pays: one file, one type, one function moved
verbatim, and `toMarkdown`'s signature and behaviour unchanged. Nothing new can
enter the corpus and no call site outside `html-to-md.ts` was touched.

It also lands where the codebase already put the seam. The generator was written
"so the caller can see the sequence" — this spec only makes *the caller* a
category rather than a line.

## Cost and risk

- **The requirement was that nothing moved, and the verification is the tests.**
  75 cases across `import.test.js` and `html-dir.test.js` drive `toMarkdown`
  end-to-end and pass unchanged. The corpus hash cannot verify this one: no
  markdown page goes through `toMarkdown`, so the docs corpus is not a witness
  either way, and claiming it as one would be a false proof.
- **A closed `kind` set is a constraint on formats not yet written.** If one
  genuinely needs an eighth kind, this type is where the argument happens — which
  is the intent, but it is a cost.
- **One more file in the build's import graph.** `html-to-md` now imports `ir`;
  `packaging.test.js` ships `src/build/lib/` wholesale, so nothing had to be
  added to `files`.

## Checks

- `test/ir.test.js` — 8 cases, and every one of them is a rule that had no direct
  test before: the ladder normalisation in both directions, the two fence cases,
  table notes, link collection, heading order, and the empty stream that would
  otherwise throw on `Math.min` of nothing.
- `test/import.test.js` and `test/html-dir.test.js` — unchanged, and the evidence
  that the extraction was verbatim.

## What this does not do

- **No parser registry, no config key, no plugin API.** Adding a format is still
  a change to this package.
- **The chunker was not touched.** It still takes markdown. `chunkBlocks` was
  considered and rejected above.
- **No new format ships with this.** `.rst`, `.adoc` and `.ipynb` are now cheap;
  none of them is written here.
