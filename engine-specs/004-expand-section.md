# 004 — `expand_section`

> **Кратко.** `fetch_section` отдаёт один чанк, а ответ регулярно лежит через
> границу секции. Расширение соседом в системе уже было — `sectionExpand` в
> ретривере — но только автоматически, только для коротких чанков и только на
> ранжировании: попросить соседа модель не могла. Добавлен четвёртый инструмент.
> Формат индекса не меняется: `c.next` уже стоит на каждом чанке, обратная карта
> строится один раз при загрузке. Всегда стоит шаг, потолок — два соседа за turn.

## Problem

`fetch_section` returns exactly one chunk (`harness.ts:362-386`). A chunk is a
section, and a section is where the chunker cut — not where the answer ends. The
common failure is ordinary and invisible: the model retrieves the right section,
the sentence that completes the answer is the first sentence of the next one, and
the answer is confidently half-right with a correct citation attached to it.

The system already knows this happens. `sectionExpand` (`retriever.ts:674-687`)
pulls in `c.next` for any retrieved chunk shorter than `EXPAND_BELOW_TOKENS`. But
that is:

- **automatic** — it runs during ranking, not on request;
- **short-chunks-only** — the case it was built for is a stub section, not a
  boundary;
- **forward-only**, and a boundary has two sides;
- **invisible to the model**, which has no way to say "the sentence I need is
  just past the end of this".

So the one thing the model can do when it lands on a boundary is search again,
with the same query, hoping the neighbour outranks something. That is a step
spent to maybe recover text the index could have handed it directly.

## Research

- **The pointer already exists.** `c.next` is written per page by both chunkers
  (`chunker.ts:604`, `openapi-chunker.ts:123`) and is already read by
  `sectionExpand`. Nothing had to be added to the index for the forward
  direction.
- **The backward direction needs no field either.** A reverse map over
  `index.chunks` is one pass at load. The alternative — a `prev` field in every
  chunk — changes the index format, moves the corpus hash, and makes every
  consumer rebuild for a value that is derivable. Checked: `prev` *is* already
  present in this repository's committed shards, but it is not a field the client
  is guaranteed by the manifest version, and deriving it costs nothing.
- **Expansion is same-page by construction**, because `next` is written per page
  and the last chunk of a page points at `null`. The retriever's existing comment
  on `sectionExpand` says exactly this, and the new tool inherits it rather than
  restating it as a rule.
- **The failure mode of an uncharged tool is documented in this file already.**
  `MAX_FREE_STEPS` exists because three no-op paths — a repeated rejection, a
  cached search, an invented tool name — each refunded their step and together
  made an unbounded loop. An expansion that refunded would be a fourth, and a
  worse one: it always succeeds, so it never even trips the refund ceiling.

## Decision

A fourth tool, declared in `TOOLS` and therefore automatically present in both
the provider schema (`toolSchemas`) and the published contract (`TOOLS_DOC`):

```
expand_section(id, direction)
  id:        string, an id returned to you by a search in this turn
  direction: next | prev, default next
```

**`retrieval.expand(id, direction)`** is the new export, and it is the only thing
that touches the index. It returns the same discriminated shape as `fetch`:

| outcome | reason | why |
|---|---|---|
| the neighbour | `ok: true` | |
| the id is not in the corpus | `unknown-id` | |
| the id's page is out of scope | `out-of-scope` | reported to the model as `unknown id`, like `fetch` |
| there is no neighbour, or the neighbour is out of scope | `no-neighbour` | |

**`no-neighbour` is a third outcome and is safe to distinguish.** "This section is
the last on its page" is a fact about a page the model has already been shown, so
it leaks nothing. A neighbour that exists but is out of scope reports
`no-neighbour` too — never `out-of-scope`, which would confirm the id.

**In the harness:**

- the returned section is added to `emittedIds` — it is text the host put in front
  of the model this turn, so it is citable on exactly the same footing as a search
  result — and to `spelled`, so a later search does not re-send it abbreviated;
- **it always charges a step.** There is no free path;
- **two per turn**, `MAX_EXPANSIONS`. The cap is on the turn, not on the page:
  without one, a model that finds walking cheaper than searching walks from the
  first chunk of a page to the last, one step per lap.

## Why it fits

Nothing about the choke point moves. The executor is closed over `retrieval` and
never sees the index — the rule `check-docpilot.sh` enforces over the whole file
— and the new tool resolves its id through the same object every other tool does.
Scope filtering happens inside `expand`, in both roles: the id you name and the
neighbour you get.

The index format does not change, so no shipped index goes stale and the corpus
hash does not move. The prompt contract is generated from `TOOLS`, so the
published tool list and the schema the validator enforces cannot drift — that
mechanism already existed and this is the first tool added since it did.

## Cost and risk

- **The prompt changed, so `promptHash` changed.** Every eval report is named by
  it. Reports produced before this spec and after it are not comparable, which is
  the correct behaviour and is worth knowing before reading a diff of two runs.
- **One more tool in a small budget.** Default `maxIterations` is 2. A turn that
  spends both steps expanding has none left to search — which is the model's
  decision to make, and the cap keeps the worst case at two.
- **A model that ignores it costs nothing.** This is additive: no existing path
  changed.
- **The reverse map is corpus-sized.** One `Map` of ids, built once per retrieval
  object rather than per turn.

## Checks

- `test/expand-section.test.js` — 13 cases. Six drive `retrieval.expand`
  directly: forward, backward, both ends of a page, an unknown id, the scope
  boundary in both roles, and the default direction. Two assert the contract
  reaches the provider. Five assert the harness invariants over the source, the
  way this suite already asserts the others: resolves through `retrieval`, never
  free, capped per turn, cites what it emitted, and keeps unknown and
  out-of-scope indistinguishable.
- `scripts/check-docpilot.sh` — the existing `harness.js holds no index
  reference` rule still passes.

## What this does not do

- **It does not cross pages.** `next` is per page by construction, and a tool that
  walked into the following page would be a scope decision made by a pointer.
- **It does not change `sectionExpand`.** The automatic short-chunk expansion
  during ranking stays exactly as it was; this is the requestable version, not a
  replacement.
- **It does not return more than one section per call.** A `count` parameter was
  considered and left out: two calls with a cap is the same reach with a limit
  that is enforced rather than requested.
- **It does not add a `prev` field to the index.** Derived at load, on purpose.
