---
description: The reader decides where the answer may come from — all docs, this page, this section, or a hand-picked set of pages.
---

# Search scope

The chip under the composer says what the next question searches. Press it and pick **All docs**, **This page**, **This section**, or any set of pages from the list. The hint line confirms it: *Searching this page.* Retrieval and citations both stay inside the scope.

<Demo>
  <ScopeDemo />
  <template #code>

```ts
docPilot: {
  scope: {
    enabled: true,        // the chip and the picker
    groupBySection: true, // the page list follows your sidebar groups
    filter: 'auto',       // a filter field once the list is long
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `scope.enabled` | `true` | Shows the chip and the picker. `false` always searches everything. |
| `scope.groupBySection` | `true` | Groups the page list under your sidebar headings. Flat while the reader is filtering. |
| `scope.filter` | `'auto'` | Adds a filter field above the list when there are more than `promptListLimit` pages. |
| `scope.promptListLimit` | `12` | How many pages the list shows before the filter appears. |
| `suggestions.scoped` | `true` | Under a narrow scope, the empty panel lists the scoped pages instead of generic suggestions. |

## When the scope is too narrow

If the answer is not inside the chosen pages, the panel does not quietly widen the search. It says *I couldn't find this in this page*, lists the **closest pages elsewhere**, and offers one button: *Clear the scope and search all docs*.

A link can set the scope too: `?dp-ask=…&dp-scope=page` — see [Deep links](/features/triggers#deep-links).

More: [`scope`](/reference/config#scope) in the reference.
