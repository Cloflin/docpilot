---
description: Thumbs under each answer, four reasons and a comment on a thumbs-down — sent to your endpoint, or kept on the reader's device.
---

# Feedback

Two thumbs under every answer. A thumbs-down asks what went wrong — **Wrong answer**, **Incomplete**, **Not in the docs**, **Bad links** — and offers a comment box. Keys and tokens are stripped from the comment before it goes anywhere.

<Demo>
  <FeedbackDemo />
  <template #code>

```ts
docPilot: {
  feedbackEndpoint: '/api/feedback', // null keeps votes on the reader's device
  feedback: {
    send: 'down',   // 'both' | 'up' | 'down' | 'none'
    comment: true,
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `feedbackEndpoint` | `null` | Where reports are POSTed. With `null`, votes stay in `localStorage`; `window.__docPilot.exportFeedback()` reads them out. |
| `feedback.send` | `'both'` | Which votes are sent. The line under the composer tells the reader which. |
| `feedback.comment` | `true` | The optional comment box, up to 500 characters. |
| `feedback.confirm` | `true` | A line after sending that says where the report went. |

## Closing the loop

```bash
npx docpilot feedback pull --from https://docs.example.com/api/feedback
```

turns thumbs-down into candidate questions for your next `eval`. It never edits your golden set by itself — you choose what to keep. See [`feedback`](/reference/cli#feedback) in the CLI reference.
