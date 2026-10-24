---
description: An opt-in relevance floor that refuses off-topic questions in the browser, before any model is called — calibrated on your own corpus.
---

# Relevance gate

Every question is scored against your index: how close is its best passage? With the gate on, a question below the floor is refused in the browser, with the closest pages listed — and no model call, so it costs nothing. Switch the mode to compare.

<Demo caption="Scores are illustrative; the floor τ is this site's own, from its calibrated index.">
  <GateDemo />
  <template #code>

```ts
docPilot: {
  guard: { mode: 'calibrated' }, // 'off' (default) | 'dense-only' | 'calibrated'
}
```

```bash
npx docpilot calibrate   # measure the floor on your corpus
npx docpilot index       # write it into the index
```

  </template>
</Demo>

## Modes

| `guard.mode` | Below the floor |
|---|---|
| `'off'` (default) | The model is called anyway. Its own rules make it say the docs do not cover the question, and cite nothing. |
| `'dense-only'` | Refused only when the embedding score is below the floor. |
| `'calibrated'` | Refused whenever the verdict fails. |

Every mode scores every turn and records the verdict, so you can measure before you switch it on.

## Why it is off by default

The floor depends on your corpus, your embedding model **and the reader's language**. A floor measured on English questions can refuse a good Russian one. Run `npx docpilot calibrate` on your own question set, read the report, then opt in.

A refusal is still useful: *I couldn't find this in the docs*, the closest pages as links, and — with `citations.pagesRead` — the pages it read.

More: [The refusal gate](/concepts/the-gate), [Calibration and evaluation](/guide/evaluation), and [`guard`](/reference/config#guard) in the reference.
