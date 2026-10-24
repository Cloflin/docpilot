---
description: Select a passage on the page or in an answer, press Ask AI, and the question arrives with that passage attached.
---

# Ask about a selection

Select a sentence and a small **Ask AI** button appears above it. Press it: the panel opens with the passage attached to the composer as a removable quote, and the reader types the question about it.

<Demo>
  <QuoteDemo />
  <template #code>

```ts
docPilot: {
  quote: {
    fromAnswer: true, // select text inside an answer
    fromDocs: true,   // select text in the article itself
  },
  ui: { firstRunHint: true }, // "Select any passage to ask about it."
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `quote.fromAnswer` | `true` | Selecting text inside an answer offers *Ask AI* on it. |
| `quote.fromDocs` | `false` | Selecting text in the article offers *Ask AI* too. Navigation, sidebar and footer are never quotable. |
| `ui.firstRunHint` | `false` | Shows a one-time line in the empty panel: *Select any passage to ask about it.* |

The quote is sent with the question and stays visible in the question bubble, so the thread shows what was asked about. A quoted selection is scrubbed for keys the same way the question is — see [Pasted keys](/features/credentials).

The article is found with `host.article` — `.vp-doc, main` on VitePress. On another site, set it to the element that holds your content.

More: [`quote`](/reference/config#quote) in the reference.
