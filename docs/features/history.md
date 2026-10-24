---
description: Past conversations stay on the reader's device, in localStorage. No account, no server, nothing sent anywhere.
---

# Conversation history

The clock button in the panel header opens the reader's past conversations, newest first, titled by their first question and dated like *3 hours ago*. Press one to restore it; hover a row to delete it. Everything lives in the reader's browser.

<Demo>
  <HistoryDemo />
  <template #code>

```ts
docPilot: {
  history: {
    enabled: true,
    maxConversations: 20, // the oldest drops off past this
    exportThread: true,   // Copy conversation, in the header
    saveOnUnload: true,   // an answer cut off by a reload comes back
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `history.enabled` | `true` | Shows the clock button and saves threads. |
| `history.maxConversations` | `20` | Threads kept per device. A 512 KB storage ceiling applies underneath. |
| `history.exportThread` | `true` | Adds *Copy conversation* to the header. |
| `history.saveOnUnload` | `true` | An answer interrupted by navigation or reload returns as *Stopped.* with its partial text and *Ask again*. |

## Where it is stored

| Key | Storage | Holds |
|---|---|---|
| `docpilot:history` | `localStorage` | the saved conversations |
| `docpilot:conversation` | `sessionStorage` | the open thread, across in-site navigation |
| `docpilot:draft` | `sessionStorage` | a question still being typed |

Nothing is sent to a server, and the stored text is already scrubbed of keys. *Delete all* asks twice — *Delete all — press again* — and never through a browser dialog. When a restored thread is older than the current index, a banner says *The docs have changed since this conversation. Some links may no longer work.*

More: [Conversation history](/guide/history) in the guide.
