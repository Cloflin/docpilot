---
description: Every claim carries a numbered citation. Open a source to read the exact passage the answer was drawn from.
---

# Sources and passages

Each claim in an answer ends with a number, and the **Sources** list under the answer says where each number points. With `citations.passage` on, every source row is also an accordion: the chevron opens the exact passage the model was given, inline, with no extra request.

<Demo>
  <SourcesDemo />
  <template #code>

```ts
docPilot: {
  citations: {
    passage: true,   // the accordion with the retrieved passage
    inCopy: true,    // copied answers end with a Sources: list
    pagesRead: true, // a refusal lists the pages it read
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `citations.passage` | `false` | Adds *Show the passage* to each source row. The text comes from the turn itself, so opening it costs nothing. |
| `citations.inCopy` | `true` | *Copy answer* appends a `Sources:` heading with absolute Markdown links, so a pasted answer still points home. |
| `citations.pagesRead` | `false` | When the panel cannot answer, it lists the pages it searched under *Searched the docs and read 4 pages*. |

## What is checked

The sources are not whatever the model claims. Before an answer is shown, the browser compares every citation with the passages it actually retrieved for that turn:

- A citation to a passage that was not retrieved is removed.
- A citation of one of the site's own [tools](/features/tools) passes the same check, because the browser handed out its id that turn. It shows as *Plan limits · from the site*, with no link and no passage.
- A link to a page that does not exist on your site is shown as text, not as a link.
- If the model marks itself unsure, the answer says so: *The model was unsure of this one — check the sources below.*

On a restored conversation, the passage is looked up again by its id. If a rebuild removed it, the row has no chevron instead of a stale passage.

More: [`citations`](/reference/config#citations) in the reference, and [What it guarantees](/concepts/guarantees).
