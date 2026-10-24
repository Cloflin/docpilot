---
description: The reader sees what the assistant is doing — loading, searching, reading a page, thinking, writing — and how long a reasoning model thought.
---

# Status and reasoning

A wait without information feels broken. While a turn runs, one line under the question names the current step, and a reasoning model's thinking sits in a collapsible block that opens while it thinks and closes when the answer starts.

<Demo>
  <StatusDemo />
  <template #code>

```ts
docPilot: {
  chat: { reasoning: 'auto' },      // or 'low' | 'medium' | 'high' | false
  ui: { waitingEscalation: true },  // "Still working" after 8 s
}
```

  </template>
</Demo>

## The steps

| Line | When |
|---|---|
| *Loading the docs index* | the first question, while the index downloads |
| *Searching the docs* | retrieval in the browser |
| *Looking at the page list* | the model asked for the list of pages |
| *Reading guide/webhooks* | the model opened a section |
| *Thinking* | a reasoning model before its first word |
| *Writing the answer* | the answer is streaming |

With `ui.waitingEscalation`, a turn with no answer yet says *Still working* at 8 seconds, and *Still working — the answer has not started yet* at 25. After a reasoning model finishes, the block reads *Thought for 4s* and stays available to open.

## Options

| Key | Default | What it does |
|---|---|---|
| `chat.reasoning` | `'auto'` | Asks a reasoning model to think, and shows the thinking. `false` turns it off; a level or `{ effort, budgetTokens, visible }` tunes it. |
| `ui.waitingEscalation` | `true` | The *Still working* lines. |

More: [`chat.reasoning`](/reference/config#chat-reasoning) in the reference.
