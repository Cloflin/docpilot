---
description: Copy an answer with its sources, ask again, edit a question and re-run the thread from there, or copy the whole conversation.
---

# Copy, retry, edit

Under every answer: **Copy answer**, **Ask again**, and the two feedback thumbs. On every question: **Edit question**. In the header: **Copy conversation**.

<Demo>
  <ActionsDemo />
  <template #code>

```ts
docPilot: {
  citations: { inCopy: true },          // copied answers keep their sources
  history: { exportThread: true },      // Copy conversation, in the header
  composer: { editLastOnArrowUp: true }, // ↑ in an empty composer edits the last question
}
```

  </template>
</Demo>

## What each one does

| Action | Result |
|---|---|
| **Copy answer** | The answer as Markdown. With `citations.inCopy`, a `Sources:` list with absolute links follows it. |
| **Copy question** | The question text, for a ticket or a chat. |
| **Ask again** | Discards this answer and asks the same question again. |
| **Edit question** | Turns the question into a text field. Sending it removes everything below and answers the new version. |
| **Copy conversation** | The whole thread as Markdown. Turned off with `history.exportThread: false`. |
| **Stop** | Keeps the text written so far, marked *Stopped.* <kbd>Esc</kbd> does the same. |
| **Retry** | Appears only when the network dropped a question. It re-sends it. |

<kbd>↑</kbd> in an empty composer opens the last question for editing. A half-typed question survives a page reload (`composer.draft`).

More: [The assistant panel](/guide/panel).
